<?php
/**
 * Helper function to send push notifications when notifications are created
 */

require_once __DIR__ . '/includes-webpush.php';
require_once __DIR__ . '/includes-app-path.php';
require_once __DIR__ . '/../config/connection-pdo.php';

/**
 * Send push notification to user (student or employee)
 * @param PDO $pdo Database connection
 * @param int $userId User ID (student_id or employee_id)
 * @param string $userType 'student' or 'employee'
 * @param array $notificationData Notification data (title, message, loanId, etc.)
 */
function sendPushNotification(PDO $pdo, int $userId, string $userType, array $notificationData) {
    // Log attempt
    error_log("[WebPush] Attempting to send push notification to {$userType} ID: {$userId}");
    
    if (!WebPushHelper::isAvailable()) {
        // WebPush library not installed, skip
        error_log("[WebPush] Library not available - skipping push notification");
        return false;
    }

    try {
        // Get active push subscriptions for the user
        $subscriptionColumn = $userType === 'student' ? 'subscription_student_id' : 'subscription_employee_id';
        
        $stmt = $pdo->prepare("SELECT 
            subscription_id,
            subscription_endpoint,
            subscription_p256dh,
            subscription_auth
            FROM tbl_csdl_push_subscriptions
            WHERE {$subscriptionColumn} = ? 
            AND subscription_is_active = 1");
        $stmt->execute([$userId]);
        $subscriptions = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if (empty($subscriptions)) {
            error_log("[WebPush] No active subscriptions found for {$userType} ID: {$userId}");
            return false; // No active subscriptions
        }

        error_log("[WebPush] Found " . count($subscriptions) . " active subscription(s)");

        // Prepare payload
        $payload = [
            'title' => $notificationData['title'] ?? 'New Notification',
            'body' => $notificationData['message'] ?? 'You have a new notification',
            'icon' => AppPath::url('assets/images/i.png'),
            'badge' => AppPath::url('assets/images/i.png'),
            'tag' => 'notification-' . ($notificationData['id'] ?? time()),
            'data' => [
                'loanId' => $notificationData['loanId'] ?? null,
                'userType' => $userType,
                'id' => $notificationData['id'] ?? null
            ]
        ];

        error_log("[WebPush] Payload prepared: " . json_encode(['title' => $payload['title'], 'body' => $payload['body']]));

        // Send to each subscription
        $successCount = 0;
        $expiredSubscriptions = [];
        
        foreach ($subscriptions as $sub) {
            $subscription = [
                'endpoint' => $sub['subscription_endpoint'],
                'keys' => [
                    'p256dh' => $sub['subscription_p256dh'],
                    'auth' => $sub['subscription_auth']
                ]
            ];

            $result = WebPushHelper::sendNotification($subscription, $payload);
            
            // Handle array return value (success/expired status)
            if (is_array($result)) {
                if ($result['success']) {
                    $successCount++;
                    error_log("[WebPush] Successfully sent to subscription ID: {$sub['subscription_id']}");
                } elseif ($result['expired']) {
                    error_log("[WebPush] Subscription expired, marking for cleanup: {$sub['subscription_id']}");
                    $expiredSubscriptions[] = $sub['subscription_id'];
                } else {
                    error_log("[WebPush] Failed to send to subscription ID: {$sub['subscription_id']}");
                }
            }
            // Handle legacy boolean return value
            elseif ($result) {
                $successCount++;
                error_log("[WebPush] Successfully sent to subscription ID: {$sub['subscription_id']}");
            } else {
                error_log("[WebPush] Failed to send to subscription ID: {$sub['subscription_id']}");
            }
        }
        
        // Clean up expired subscriptions
        if (!empty($expiredSubscriptions)) {
            try {
                $placeholders = implode(',', array_fill(0, count($expiredSubscriptions), '?'));
                $cleanupStmt = $pdo->prepare("UPDATE tbl_csdl_push_subscriptions 
                                              SET subscription_is_active = 0 
                                              WHERE subscription_id IN ($placeholders)");
                $cleanupStmt->execute($expiredSubscriptions);
                error_log("[WebPush] Cleaned up " . count($expiredSubscriptions) . " expired subscription(s)");
            } catch (Throwable $cleanupError) {
                error_log("[WebPush] Error cleaning up expired subscriptions: " . $cleanupError->getMessage());
            }
        }

        error_log("[WebPush] Sent {$successCount} out of " . count($subscriptions) . " notifications");
        return $successCount > 0;

    } catch (Throwable $e) {
        error_log('[WebPush] Exception: ' . $e->getMessage());
        error_log('[WebPush] Stack trace: ' . $e->getTraceAsString());
        // Don't throw - push notifications are optional
        return false;
    }
}






