<?php
require_once __DIR__ . '/../config/config-env.php';

class TurnstileVerification {
    public static function requireValid($token, string $expectedAction): void {
        $result = static::validate($token, $expectedAction);
        if (!$result['success']) {
            http_response_code($result['status']);
            unset($result['status']);
            header('Content-Type: application/json');
            echo json_encode($result);
            exit;
        }
    }

    public static function validate($token, string $expectedAction): array {
        $invalid = [
            'success' => false,
            'status' => 400,
            'error_code' => 'TURNSTILE_INVALID',
            'message' => 'Security verification failed or expired. Please complete the new check and try again.',
        ];
        $unavailable = [
            'success' => false,
            'status' => 503,
            'error_code' => 'TURNSTILE_UNAVAILABLE',
            'message' => 'Security verification is temporarily unavailable. Please try again shortly.',
        ];

        if (!is_string($token) || trim($token) === '' || strlen($token) > 2048) {
            return $invalid;
        }

        $secret = trim((string) ($_ENV['TURNSTILE_SECRET_KEY'] ?? (getenv('TURNSTILE_SECRET_KEY') ?: '')));
        if ($secret === '') {
            error_log('Turnstile: TURNSTILE_SECRET_KEY is not configured.');
            return $unavailable;
        }

        $result = static::requestVerification($secret, $token);
        if (!is_array($result) || !isset($result['success']) || !is_bool($result['success'])) {
            return $unavailable;
        }

        if ($result['success'] !== true) {
            $errors = $result['error-codes'] ?? [];
            if (!is_array($errors) || array_intersect($errors, ['missing-input-secret', 'invalid-input-secret', 'internal-error', 'bad-request'])) {
                error_log('Turnstile: provider configuration or service error.');
                return $unavailable;
            }
            return $invalid;
        }

        // A token issued for another form must not authorize a login.
        if (($result['action'] ?? '') !== $expectedAction) {
            return $invalid;
        }

        return ['success' => true];
    }

    protected static function requestVerification(string $secret, string $token): ?array {
        if (!function_exists('curl_init')) {
            error_log('Turnstile: the PHP cURL extension is required.');
            return null;
        }

        $handle = curl_init('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        if ($handle === false) {
            return null;
        }

        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query(['secret' => $secret, 'response' => $token]),
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded', 'Accept: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $body = curl_exec($handle);
        $httpStatus = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
        $curlError = curl_errno($handle);
        curl_close($handle);

        if ($body === false || $httpStatus !== 200) {
            // Never log the submitted token, secret, or request body.
            error_log('Turnstile: Siteverify request failed (HTTP ' . $httpStatus . ', cURL ' . $curlError . ').');
            return null;
        }

        $result = json_decode($body, true);
        return is_array($result) ? $result : null;
    }
}
