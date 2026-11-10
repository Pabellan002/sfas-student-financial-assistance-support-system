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

// Cashier is the financial-review role (role_id = 99).
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 99) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Cashier role required.']);
    exit;
}

$employeeId = (int) $_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Handle SSE (Server-Sent Events) stream
if ($method === 'GET' && isset($_GET['stream'])) {
    error_log("[CASHIER NOTIFICATIONS] SSE stream requested by employee ID: {$employeeId}");
    
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
            error_log("[CASHIER NOTIFICATIONS] SSE connection aborted for employee ID: {$employeeId}");
            break;
        }
        
        try {
            $countStmt = $pdo->prepare("SELECT COUNT(*) as count 
                                        FROM tbl_csdl_notifications 
                                        WHERE notification_employee_id = ? 
                                        AND notification_is_read = 0");
            $countStmt->execute([$employeeId]);
            $unreadCount = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            error_log("[CASHIER NOTIFICATIONS] Employee ID {$employeeId} has {$unreadCount} unread notifications");
            
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
            
            error_log("[CASHIER NOTIFICATIONS] Fetched " . count($notifications) . " notifications for employee ID {$employeeId}");
            
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
                error_log("[CASHIER NOTIFICATIONS] New notification detected! ID: {$lastNotificationId}");
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
            
            sleep(3);
        } catch (Throwable $e) {
            error_log('[CASHIER NOTIFICATIONS] SSE error: ' . $e->getMessage());
            sleep(5);
        }
    }
    exit;
}

// Handle regular GET/POST requests
if ($method === 'GET') {
    try {
        employeeNotificationsRespondGet($pdo, $employeeId);
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Error fetching notifications']);
    }
} elseif ($method === 'POST') {
    // Handle JSON input (from ApiService)
    $input = json_decode(file_get_contents('php://input'), true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'markAsRead') {
        $notificationId = intval($_POST['notificationId'] ?? 0);
        if ($notificationId > 0) {
            try {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_notifications 
                                      SET notification_is_read = 1,
                                          notification_read_at = NOW()
                                      WHERE notification_id = ? 
                                      AND notification_employee_id = ?");
                $stmt->execute([$notificationId, $employeeId]);
                echo json_encode(['success' => true]);
            } catch (Throwable $e) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Error updating notification']);
            }
        } else {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid notification ID']);
        }
    } elseif ($action === 'markAllAsRead') {
        try {
            $stmt = $pdo->prepare("UPDATE tbl_csdl_notifications 
                                  SET notification_is_read = 1,
                                      notification_read_at = NOW()
                                  WHERE notification_employee_id = ? 
                                  AND notification_is_read = 0");
            $stmt->execute([$employeeId]);
            echo json_encode(['success' => true]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error updating notifications']);
        }
    } else {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
    }
} else {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
}
?>
