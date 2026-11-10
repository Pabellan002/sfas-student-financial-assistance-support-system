<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-webpush.php';

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Get VAPID public key (for subscription) - PUBLIC, no auth required
if ($method === 'GET' && isset($_GET['vapid'])) {
    WebPushHelper::init();
    echo json_encode([
        'success' => true,
        'publicKey' => WebPushHelper::getPublicKey()
    ]);
    exit;
}

// Check if user is an employee for all other operations
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$employeeId = (int) $_SESSION['user_id'];

// Handle POST requests (subscribe/unsubscribe)
if ($method === 'POST') {
    // Parse JSON input FIRST
    $input = json_decode(file_get_contents('php://input'), true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    
    try {
        CSRFProtection::validateRequest();
    } catch (Exception $e) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'CSRF validation failed']);
        exit;
    }
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'subscribe') {
        try {
            $subscription = $_POST['subscription'] ?? null;
            
            if (!$subscription || !isset($subscription['endpoint'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid subscription data']);
                exit;
            }
            
            $endpoint = $subscription['endpoint'];
            $p256dh = $subscription['keys']['p256dh'] ?? '';
            $auth = $subscription['keys']['auth'] ?? '';
            
            // Check if subscription already exists
            $checkStmt = $pdo->prepare("SELECT subscription_id FROM tbl_csdl_push_subscriptions 
                                       WHERE subscription_employee_id = ? AND subscription_endpoint = ?");
            $checkStmt->execute([$employeeId, $endpoint]);
            $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existing) {
                // Update existing subscription
                $updateStmt = $pdo->prepare("UPDATE tbl_csdl_push_subscriptions 
                                           SET subscription_p256dh = ?,
                                               subscription_auth = ?,
                                               subscription_is_active = 1,
                                               subscription_updated_at = NOW()
                                           WHERE subscription_id = ?");
                $updateStmt->execute([$p256dh, $auth, $existing['subscription_id']]);
            } else {
                // Insert new subscription
                $insertStmt = $pdo->prepare("INSERT INTO tbl_csdl_push_subscriptions 
                                            (subscription_employee_id, subscription_endpoint, subscription_p256dh, subscription_auth, subscription_is_active) 
                                            VALUES (?, ?, ?, ?, 1)");
                $insertStmt->execute([$employeeId, $endpoint, $p256dh, $auth]);
            }
            
            echo json_encode(['success' => true, 'message' => 'Subscription saved']);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Push subscription error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error saving subscription']);
        }
        exit;
    }
    
    if ($action === 'unsubscribe') {
        try {
            $endpoint = $_POST['endpoint'] ?? '';
            
            if (empty($endpoint)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Endpoint required']);
                exit;
            }
            
            // Deactivate subscription
            $updateStmt = $pdo->prepare("UPDATE tbl_csdl_push_subscriptions 
                                       SET subscription_is_active = 0,
                                           subscription_updated_at = NOW()
                                       WHERE subscription_employee_id = ? AND subscription_endpoint = ?");
            $updateStmt->execute([$employeeId, $endpoint]);
            
            echo json_encode(['success' => true, 'message' => 'Unsubscribed']);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Push unsubscribe error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error unsubscribing']);
        }
        exit;
    }
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
?>






