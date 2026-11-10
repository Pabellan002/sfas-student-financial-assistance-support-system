<?php
/**
 * WebPush Helper Class
 * Requires: composer require minishlink/web-push
 * Run: composer install (if not already installed)
 * 
 * To generate VAPID keys:
 * composer require minishlink/web-push
 * php -r "require 'vendor/autoload.php'; \$keys = \Minishlink\WebPush\VAPID::createVapidKeys(); echo 'Public: ' . \$keys['publicKey'] . PHP_EOL . 'Private: ' . \$keys['privateKey'] . PHP_EOL;"
 */

require_once __DIR__ . '/../config/config-env.php';

// Check if autoload exists
if (file_exists(__DIR__ . '/../../vendor/autoload.php')) {
    require_once __DIR__ . '/../../vendor/autoload.php';
}

class WebPushHelper {
    private static $vapidPublicKey = null;
    private static $vapidPrivateKey = null;
    private static $vapidSubject = null;

    /**
     * Initialize VAPID keys
     * For production, store these in environment variables or config file
     */
    public static function init() {
        // VAPID keys - Store these securely (environment variables recommended)
        // To generate keys, you need to install the library first:
        // composer require minishlink/web-push
        // Then run: php -r "require 'vendor/autoload.php'; \$keys = \Minishlink\WebPush\VAPID::createVapidKeys(); echo 'Public: ' . \$keys['publicKey'] . PHP_EOL . 'Private: ' . \$keys['privateKey'] . PHP_EOL;"
        
        // Using environment variables or config - YOU MUST SET THESE
        self::$vapidPublicKey = getenv('VAPID_PUBLIC_KEY') ?: '';
        self::$vapidPrivateKey = getenv('VAPID_PRIVATE_KEY') ?: '';
        self::$vapidSubject = getenv('VAPID_SUBJECT') ?: ($_ENV['APP_URL'] ?? '');
    }

    /**
     * Get VAPID public key (for client-side subscription)
     */
    public static function getPublicKey() {
        if (self::$vapidPublicKey === null) {
            self::init();
        }
        return self::$vapidPublicKey;
    }

    /**
     * Check if WebPush library is available
     */
    public static function isAvailable() {
        return class_exists('Minishlink\WebPush\WebPush');
    }

    /**
     * Send push notification to a subscription
     */
    public static function sendNotification($subscription, $payload, $options = []) {
        if (!self::isAvailable()) {
            error_log('[WebPushHelper] Library not available. Run: composer install');
            return false;
        }

        if (self::$vapidPrivateKey === null) {
            self::init();
        }

        try {
            error_log('[WebPushHelper] Preparing to send notification...');
            
            $auth = [
                'VAPID' => [
                    'subject' => self::$vapidSubject,
                    'publicKey' => self::$vapidPublicKey,
                    'privateKey' => self::$vapidPrivateKey,
                ],
            ];

            $webPush = new \Minishlink\WebPush\WebPush($auth);
            error_log('[WebPushHelper] WebPush instance created');

            $pushSubscription = \Minishlink\WebPush\Subscription::create([
                'endpoint' => $subscription['endpoint'],
                'keys' => [
                    'p256dh' => $subscription['keys']['p256dh'],
                    'auth' => $subscription['keys']['auth'],
                ],
            ]);
            error_log('[WebPushHelper] Subscription object created');

            $webPush->queueNotification(
                $pushSubscription,
                json_encode($payload)
            );
            error_log('[WebPushHelper] Notification queued');

            // Send all queued notifications
            error_log('[WebPushHelper] Flushing queue...');
            $success = false;
            foreach ($webPush->flush() as $report) {
                $endpoint = $report->getRequest()->getUri()->__toString();
                
                if ($report->isSuccess()) {
                    error_log('[WebPushHelper] ✓ Successfully sent to: ' . substr($endpoint, 0, 50) . '...');
                    $success = true;
                } else {
                    $reason = $report->getReason();
                    $statusCode = $report->getResponse() ? $report->getResponse()->getStatusCode() : 'N/A';
                    error_log('[WebPushHelper] ✗ Failed to send to: ' . substr($endpoint, 0, 50) . '...');
                    error_log('[WebPushHelper] ✗ Reason: ' . $reason . ' (HTTP ' . $statusCode . ')');
                    
                    // If subscription is gone/expired, mark it for cleanup
                    if ($statusCode == 410 || $statusCode == 404) {
                        error_log('[WebPushHelper] ✗ Subscription appears to be expired/invalid');
                        // Return the endpoint so it can be cleaned up by the caller
                        return ['success' => false, 'expired' => true, 'endpoint' => $endpoint];
                    }
                }
            }

            if ($success) {
                error_log('[WebPushHelper] ✓ Notification sent successfully');
            }
            return ['success' => $success, 'expired' => false];
        } catch (Exception $e) {
            error_log('[WebPushHelper] ✗ Exception: ' . $e->getMessage());
            error_log('[WebPushHelper] ✗ Exception type: ' . get_class($e));
            error_log('[WebPushHelper] ✗ Stack trace: ' . $e->getTraceAsString());
            return ['success' => false, 'expired' => false];
        }
    }

    /**
     * Send notification to multiple subscriptions
     */
    public static function sendToMultiple($subscriptions, $payload, $options = []) {
        $results = [];
        foreach ($subscriptions as $subscription) {
            $results[] = self::sendNotification($subscription, $payload, $options);
        }
        return $results;
    }
}
