<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-employee-notifications-query.php';

header('Content-Type: application/json');

// Check if user is an employee
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Check if user has COO role (role_id = 97)
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 97) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. COO role required.']);
    exit;
}

$employeeId = (int) $_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Handle SSE (Server-Sent Events) stream
if ($method === 'GET' && isset($_GET['stream'])) {
    // Set headers for SSE
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');
    
    set_time_limit(0);
    ignore_user_abort(true);
    
    echo "data: " . json_encode(['type' => 'connected']) . "\n\n";
    if (ob_get_level() > 0) {
        ob_flush();
    }
    flush();
    
    $lastNotificationId = 0;
    
    while (true) {
        if (connection_aborted()) {
            break;
        }
        
        try {
            $countStmt = $pdo->prepare("SELECT COUNT(*) as count 
                                        FROM tbl_csdl_notifications 
                                        WHERE notification_employee_id = ? 
                                        AND notification_is_read = 0");
            $countStmt->execute([$employeeId]);
            $unreadCount = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            $notifStmt = $pdo->prepare("SELECT 
                notification_id,
                notification_title,
                notification_message,
                notification_is_read,
                notification_created_at,
                notification_loan_id
                FROM tbl_csdl_notifications
                WHERE notification_employee_id = ?
                ORDER BY notification_created_at DESC
                LIMIT 5");
            $notifStmt->execute([$employeeId]);
            $notifications = $notifStmt->fetchAll(PDO::FETCH_ASSOC);
            
            $formattedNotifications = array_map(function($notif) {
                return [
                    'id' => $notif['notification_id'],
                    'title' => $notif['notification_title'],
                    'message' => $notif['notification_message'],
                    'isRead' => (bool) $notif['notification_is_read'],
                    'createdAt' => $notif['notification_created_at'],
                    'loanId' => $notif['notification_loan_id']
                ];
            }, $notifications);
            
            $hasNew = false;
            if (!empty($formattedNotifications) && $formattedNotifications[0]['id'] > $lastNotificationId) {
                $hasNew = true;
                $lastNotificationId = $formattedNotifications[0]['id'];
            }
            
            echo "data: " . json_encode([
                'type' => 'notification',
                'unreadCount' => $unreadCount,
                'notifications' => $formattedNotifications,
                'hasNew' => $hasNew
            ]) . "\n\n";
            
            if (ob_get_level() > 0) {
                ob_flush();
            }
            flush();
            
        } catch (Throwable $e) {
            error_log('SSE notification error: ' . $e->getMessage());
            echo "data: " . json_encode(['type' => 'error', 'message' => 'Error fetching notifications']) . "\n\n";
            if (ob_get_level() > 0) {
                ob_flush();
            }
            flush();
        }
        
        if (function_exists('usleep')) {
            usleep(3000000);
        } else {
            sleep(3);
        }
    }
    
    exit;
}

// Handle regular API requests
if ($method === 'GET') {
    try {
        employeeNotificationsRespondGet($pdo, $employeeId);
    } catch (Throwable $e) {
        http_response_code(500);
        error_log('Notification API error: ' . $e->getMessage());
        echo json_encode(['success' => false, 'message' => 'Error fetching notifications']);
    }
    exit;
}

// Handle POST requests
if ($method === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'markAsRead') {
        $notificationId = intval($_POST['notificationId'] ?? 0);
        if ($notificationId > 0) {
            try {
                $updateStmt = $pdo->prepare("UPDATE tbl_csdl_notifications 
                                            SET notification_is_read = 1,
                                                notification_read_at = NOW()
                                            WHERE notification_id = ? 
                                            AND notification_employee_id = ?");
                $updateStmt->execute([$notificationId, $employeeId]);
                
                echo json_encode(['success' => true]);
            } catch (Throwable $e) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Error updating notification']);
            }
        }
        exit;
    }
    
    if ($action === 'markAllAsRead') {
        try {
            $updateStmt = $pdo->prepare("UPDATE tbl_csdl_notifications 
                                        SET notification_is_read = 1,
                                            notification_read_at = NOW()
                                        WHERE notification_employee_id = ?
                                        AND notification_is_read = 0");
            $updateStmt->execute([$employeeId]);
            
            echo json_encode(['success' => true]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error updating notifications']);
        }
        exit;
    }
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
?>
