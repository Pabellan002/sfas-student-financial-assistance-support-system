<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-active-session.php';
require_once __DIR__ . '/../includes/includes-password-policy.php';
require_once __DIR__ . '/../includes/includes-session-timeout.php';

header('Content-Type: application/json');
// Prevent intermediary/proxy caches (e.g., Cloudflare) from serving stale auth state.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
header('Pragma: no-cache');
header('Expires: 0');
header('Vary: Cookie, Authorization');

$defaultTimeout = SessionTimeout::seconds($pdo);
$warningSeconds = 60; // warn client during the final minute

// Determine mode: peek (read-only) vs update (refresh activity)
$headers = function_exists('getallheaders') ? getallheaders() : [];
$isPeek = isset($_GET['peek']) || (isset($headers['X-Session-Peek']) && (string)$headers['X-Session-Peek'] === '1');
$isUpdate = isset($_GET['update']) || (isset($headers['X-Session-Update']) && (string)$headers['X-Session-Update'] === '1');
if (!isset($_SESSION['last_activity'])) {
    $_SESSION['last_activity'] = time();
}

$now = time();

// If no user set, treat as expired
$isAuthenticated = isset($_SESSION['user_id']) && isset($_SESSION['user_type']);

if (!$isAuthenticated) {
    echo json_encode([
        'success' => true,
        'active' => false,
        'authenticated' => false,
        'message' => 'Not authenticated',
        'timeout' => $defaultTimeout
    ]);
    exit;
}

// Resolve idle expiry before checking the active-session row. A row may already
// be gone after a logout/timeout; its absence does not prove another login.
if (SessionTimeout::isExpired($defaultTimeout)) {
    ActiveSession::revokeCurrent($pdo);
    session_unset();
    session_destroy();
    echo json_encode([
        'success' => true,
        'active' => false,
        'authenticated' => false,
        'reason' => 'session_expired',
        'message' => 'Session expired',
        'timeout' => $defaultTimeout,
    ]);
    exit;
}

$activeSessionStatus = ActiveSession::status($pdo);
if ($activeSessionStatus !== 'current') {
    ActiveSession::clearLocalAuthentication();
    $wasReplaced = $activeSessionStatus === 'replaced';
    echo json_encode([
        'success' => true,
        'active' => false,
        'authenticated' => false,
        'reason' => $wasReplaced ? 'signed_in_elsewhere' : 'session_ended',
        'message' => $wasReplaced
            ? 'This account was signed in from another browser.'
            : 'Your session has ended. Please sign in again.',
        'timeout' => $defaultTimeout,
    ]);
    exit;
}

// Re-evaluate password age during an active session as well, so a session that
// crosses the 30-day boundary is prompted without waiting for another login.
try {
    if ($_SESSION['user_type'] === 'student') {
        $passwordPolicyStmt = $pdo->prepare("
            SELECT student_school_id AS school_id,
                   student_password_hash AS password_hash,
                   student_password_changed_at AS changed_at,
                   student_created_at AS created_at
            FROM tbl_csdl_students WHERE student_id = ? LIMIT 1
        ");
    } else {
        $passwordPolicyStmt = $pdo->prepare("
            SELECT employee_school_id AS school_id,
                   employee_password_hash AS password_hash,
                   employee_password_changed_at AS changed_at,
                   employee_created_at AS created_at
            FROM tbl_csdl_employees WHERE employee_id = ? LIMIT 1
        ");
    }
    $passwordPolicyStmt->execute([$_SESSION['user_id']]);
    $passwordPolicyAccount = $passwordPolicyStmt->fetch();
    if ($passwordPolicyAccount && !empty($passwordPolicyAccount['password_hash'])) {
        $passwordChangeReason = PasswordPolicy::getChangeReason(
            $passwordPolicyAccount['password_hash'],
            (string) $passwordPolicyAccount['school_id'],
            $passwordPolicyAccount['changed_at'] ?? null,
            $passwordPolicyAccount['created_at'] ?? null
        );
        if ($passwordChangeReason !== null) {
            $_SESSION['requires_password_change'] = true;
            $_SESSION['password_change_reason'] = $passwordChangeReason;
        } else {
            unset($_SESSION['requires_password_change'], $_SESSION['password_change_reason']);
        }
    }
} catch (Throwable $e) {
    error_log('Password policy check failed.');
}

$elapsed = $now - (int)$_SESSION['last_activity'];

// Update last activity (heartbeat) only when update mode requested
if ($isUpdate && $isAuthenticated) {
    $_SESSION['last_activity'] = $now;
}

$remaining = $defaultTimeout - $elapsed;
$showWarning = $remaining <= $warningSeconds;

// Get role name if role_id exists
$roleName = null;
if (isset($_SESSION['user_role_id']) && $_SESSION['user_role_id']) {
    try {
        $roleStmt = $pdo->prepare("SELECT role_name FROM tbl_csdl_roles WHERE role_id = ? LIMIT 1");
        $roleStmt->execute([$_SESSION['user_role_id']]);
        $roleRow = $roleStmt->fetch();
        if ($roleRow) {
            $roleName = $roleRow['role_name'];
        }
    } catch (Throwable $e) {
        // Ignore error, use default role name based on user_type
    }
}

// Fallback to user_type if role name not found
if (!$roleName) {
    $roleName = $_SESSION['user_type'] === 'student' ? 'Student' : 'Staff';
}

echo json_encode([
    'success' => true,
    'active' => true,
    'remaining' => $remaining,
    'timeout' => $defaultTimeout,
    'warn' => $showWarning,
    'requires_password_change' => isset($_SESSION['requires_password_change']) && $_SESSION['requires_password_change'] === true,
    'password_change_reason' => $_SESSION['password_change_reason'] ?? null,
    'password_max_age_days' => PasswordPolicy::MAX_AGE_DAYS,
    'user' => [
        'id' => $_SESSION['user_id'],
        'type' => $_SESSION['user_type'],
        'role_id' => $_SESSION['user_role_id'] ?? null,
        'role_name' => $roleName,
        'name' => $_SESSION['user_name'] ?? null
    ]
]);
?>
