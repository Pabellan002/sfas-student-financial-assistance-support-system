<?php
class ActiveSession
{
    public static function ensureSchema(PDO $pdo): void
    {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS tbl_csdl_active_sessions (
                active_session_user_type VARCHAR(16) NOT NULL,
                active_session_user_id INT NOT NULL,
                active_session_token_hash CHAR(64) NOT NULL,
                active_session_issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                active_session_last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (active_session_user_type, active_session_user_id),
                UNIQUE KEY uq_active_session_token_hash (active_session_token_hash)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        ");
    }

    public static function issue(PDO $pdo, string $userType, int $userId): void
    {
        self::ensureSchema($pdo);

        $token = bin2hex(random_bytes(32));
        $hash = hash('sha256', $token);
        $stmt = $pdo->prepare("
            INSERT INTO tbl_csdl_active_sessions
                (active_session_user_type, active_session_user_id, active_session_token_hash)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                active_session_token_hash = VALUES(active_session_token_hash),
                active_session_issued_at = CURRENT_TIMESTAMP,
                active_session_last_seen = CURRENT_TIMESTAMP
        ");
        $stmt->execute([$userType, $userId, $hash]);

        $_SESSION['active_session_token'] = $token;
    }

    /**
     * Only a different stored token proves that another login replaced this one.
     * A missing row or local token means the session ended for another reason.
     */
    public static function status(PDO $pdo): string
    {
        $userId = $_SESSION['user_id'] ?? null;
        $userType = $_SESSION['user_type'] ?? null;
        $token = $_SESSION['active_session_token'] ?? null;

        if (!is_numeric($userId) || !is_string($userType) || !is_string($token) || $token === '') {
            return 'ended';
        }

        $stmt = $pdo->prepare("
            SELECT active_session_token_hash
            FROM tbl_csdl_active_sessions
            WHERE active_session_user_type = ? AND active_session_user_id = ?
            LIMIT 1
        ");
        $stmt->execute([$userType, (int) $userId]);
        $storedHash = $stmt->fetchColumn();

        if (!is_string($storedHash)) {
            return 'ended';
        }

        return hash_equals($storedHash, hash('sha256', $token)) ? 'current' : 'replaced';
    }

    public static function isCurrent(PDO $pdo): bool
    {
        return self::status($pdo) === 'current';
    }

    public static function revokeCurrent(PDO $pdo): void
    {
        $userId = $_SESSION['user_id'] ?? null;
        $userType = $_SESSION['user_type'] ?? null;
        $token = $_SESSION['active_session_token'] ?? null;
        if (!is_numeric($userId) || !is_string($userType) || !is_string($token) || $token === '') {
            return;
        }

        $stmt = $pdo->prepare("
            DELETE FROM tbl_csdl_active_sessions
            WHERE active_session_user_type = ?
              AND active_session_user_id = ?
              AND active_session_token_hash = ?
        ");
        $stmt->execute([$userType, (int) $userId, hash('sha256', $token)]);
    }

    public static function clearLocalAuthentication(): void
    {
        foreach ([
            'user_id', 'user_type', 'user_role_id', 'school_id', 'user_name',
            'campus_id', 'login_time', 'last_activity', 'requires_password_change',
            'active_session_token', 'password_change_reason',
        ] as $key) {
            unset($_SESSION[$key]);
        }
    }
}
