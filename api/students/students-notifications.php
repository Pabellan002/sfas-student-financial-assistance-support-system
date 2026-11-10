<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

// Check if user is a student
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    http_response_code(401);
    exit;
}

$studentId = (int) $_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Handle SSE (Server-Sent Events) stream
if ($method === 'GET' && isset($_GET['stream'])) {
    // Set headers for SSE
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    
    // Prevent script timeout (SSE should run indefinitely)
    set_time_limit(0);
    ignore_user_abort(true);
    
    // Send initial connection message
    echo "data: " . json_encode(['type' => 'connected']) . "\n\n";
    if (ob_get_level() > 0) {
        ob_flush();
    }
    flush();
    
    $lastNotificationId = 0;
    
    // Keep connection alive and check for new notifications
    while (true) {
        // Check if client disconnected
        if (connection_aborted()) {
            break;
        }
        
        try {
            // Get unread notifications count
            $countStmt = $pdo->prepare("SELECT COUNT(*) as count 
                                        FROM tbl_csdl_notifications 
                                        WHERE notification_student_id = ? 
                                        AND notification_is_read = 0");
            $countStmt->execute([$studentId]);
            $unreadCount = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Get latest notifications (last 5)
            $notifStmt = $pdo->prepare("SELECT 
                notification_id,
                notification_title,
                notification_message,
                notification_is_read,
                notification_created_at,
                notification_loan_id
                FROM tbl_csdl_notifications
                WHERE notification_student_id = ?
                ORDER BY notification_created_at DESC
                LIMIT 5");
            $notifStmt->execute([$studentId]);
            $notifications = $notifStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Format notifications
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
            
            // Check if there are new notifications
            $hasNew = false;
            if (!empty($formattedNotifications) && $formattedNotifications[0]['id'] > $lastNotificationId) {
                $hasNew = true;
                $lastNotificationId = $formattedNotifications[0]['id'];
            }
            
            // Send data to client (always send to keep connection alive)
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
            // Send error message
            echo "data: " . json_encode(['type' => 'error', 'message' => 'Error fetching notifications']) . "\n\n";
            if (ob_get_level() > 0) {
                ob_flush();
            }
            flush();
        }
        
        // Wait 3 seconds before next check
        if (function_exists('usleep')) {
            usleep(3000000); // 3 seconds in microseconds
        } else {
            sleep(3);
        }
    }
    
    exit;
}

// Handle regular API requests (GET notifications, mark as read, etc.)
if ($method === 'GET') {
    try {
        // Get unread count
        $countStmt = $pdo->prepare("SELECT COUNT(*) as count 
                                    FROM tbl_csdl_notifications 
                                    WHERE notification_student_id = ? 
                                    AND notification_is_read = 0");
        $countStmt->execute([$studentId]);
        $unreadCount = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['count'];

        $totalStmt = $pdo->prepare("SELECT COUNT(*) as count 
                                    FROM tbl_csdl_notifications 
                                    WHERE notification_student_id = ?");
        $totalStmt->execute([$studentId]);
        $totalCount = (int) $totalStmt->fetch(PDO::FETCH_ASSOC)['count'];

        $usePagination = isset($_GET['page']);
        if ($usePagination) {
            $page = max(1, (int) ($_GET['page'] ?? 1));
            $perPage = min(50, max(5, (int) ($_GET['perPage'] ?? 20)));
            $offset = ($page - 1) * $perPage;

            $notifStmt = $pdo->prepare("SELECT 
                notification_id,
                notification_title,
                notification_message,
                notification_is_read,
                notification_created_at,
                notification_loan_id
                FROM tbl_csdl_notifications
                WHERE notification_student_id = ?
                ORDER BY notification_created_at DESC
                LIMIT ? OFFSET ?");
            $notifStmt->bindValue(1, $studentId, PDO::PARAM_INT);
            $notifStmt->bindValue(2, $perPage, PDO::PARAM_INT);
            $notifStmt->bindValue(3, $offset, PDO::PARAM_INT);
            $notifStmt->execute();
            $notifications = $notifStmt->fetchAll(PDO::FETCH_ASSOC);
            $totalPages = $perPage > 0 ? (int) ceil($totalCount / $perPage) : 1;

            echo json_encode([
                'success' => true,
                'unreadCount' => $unreadCount,
                'notifications' => $notifications,
                'pagination' => [
                    'page' => $page,
                    'perPage' => $perPage,
                    'total' => $totalCount,
                    'totalPages' => max(1, $totalPages),
                ],
            ]);
        } else {
            // Dropdown preview (last N)
            $limit = min(50, max(1, (int) ($_GET['limit'] ?? 10)));
            $notifStmt = $pdo->prepare("SELECT 
                notification_id,
                notification_title,
                notification_message,
                notification_is_read,
                notification_created_at,
                notification_loan_id
                FROM tbl_csdl_notifications
                WHERE notification_student_id = ?
                ORDER BY notification_created_at DESC
                LIMIT ?");
            $notifStmt->bindValue(1, $studentId, PDO::PARAM_INT);
            $notifStmt->bindValue(2, $limit, PDO::PARAM_INT);
            $notifStmt->execute();
            $notifications = $notifStmt->fetchAll(PDO::FETCH_ASSOC);

            echo json_encode([
                'success' => true,
                'unreadCount' => $unreadCount,
                'notifications' => $notifications,
            ]);
        }
    } catch (Throwable $e) {
        http_response_code(500);
        error_log('Notification API error: ' . $e->getMessage());
        echo json_encode(['success' => false, 'message' => 'Error fetching notifications']);
    }
    exit;
}

// Handle POST requests (mark as read, mark all as read)
if ($method === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'markRead') {
        $notificationId = intval($_POST['notificationId'] ?? 0);
        if ($notificationId > 0) {
            try {
                $updateStmt = $pdo->prepare("UPDATE tbl_csdl_notifications 
                                            SET notification_is_read = 1,
                                                notification_read_at = NOW()
                                            WHERE notification_id = ? 
                                            AND notification_student_id = ?");
                $updateStmt->execute([$notificationId, $studentId]);
                
                echo json_encode(['success' => true]);
            } catch (Throwable $e) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Error updating notification']);
            }
        }
        exit;
    }
    
    if ($action === 'markAllRead') {
        try {
            $updateStmt = $pdo->prepare("UPDATE tbl_csdl_notifications 
                                        SET notification_is_read = 1,
                                            notification_read_at = NOW()
                                        WHERE notification_student_id = ?
                                        AND notification_is_read = 0");
            $updateStmt->execute([$studentId]);
            
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
