<?php

class SessionTimeout
{
    public static function seconds(PDO $pdo): int
    {
        $timeout = 300;
        try {
            $stmt = $pdo->query("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'session_timeout_seconds' LIMIT 1");
            $value = $stmt->fetchColumn();
            if ($value !== false && ctype_digit((string) $value)) {
                $timeout = max(300, (int) $value);
            }
        } catch (Throwable $e) {
            // Use the five-minute default if settings are unavailable.
        }
        return $timeout;
    }

    public static function isExpired(int $timeout): bool
    {
        return isset($_SESSION['last_activity'])
            && time() - (int) $_SESSION['last_activity'] >= $timeout;
    }
}
