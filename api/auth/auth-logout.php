<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-active-session.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}
$csrfToken = $_POST['csrf_token'] ?? null;
if (!$csrfToken) {
    $rawBody = file_get_contents('php://input');
    if (!empty($rawBody)) {
        $decoded = json_decode($rawBody, true);
        if (is_array($decoded)) {
            $csrfToken = $decoded['csrf_token'] ?? null;
        }
    }
}
if (!$csrfToken) {
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    if (!is_array($headers)) {
        $headers = [];
    }
    $csrfToken = $headers['X-CSRF-Token'] ?? $headers['x-csrf-token'] ?? null;
}
$csrfValid = false;
if ($csrfToken) {
    $csrfValid = CSRFProtection::validateToken($csrfToken);
}

if (!$csrfValid) {
    $isHttps = (
        (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ||
        (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string)$_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https')
    );
    $scheme = $isHttps ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $expectedOrigin = $host ? ($scheme . '://' . $host) : '';

    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $referer = $_SERVER['HTTP_REFERER'] ?? '';
    $sameOrigin = false;

    if ($expectedOrigin !== '' && $origin !== '') {
        $sameOrigin = strcasecmp(rtrim($origin, '/'), rtrim($expectedOrigin, '/')) === 0;
    } elseif ($expectedOrigin !== '' && $referer !== '') {
        $refParts = parse_url($referer);
        if ($refParts && isset($refParts['host'])) {
            $refScheme = $refParts['scheme'] ?? '';
            $refHost = $refParts['host'] ?? '';
            $refPort = isset($refParts['port']) ? ':' . $refParts['port'] : '';
            $refOrigin = $refScheme !== '' ? ($refScheme . '://' . $refHost . $refPort) : '';
            $sameOrigin = strcasecmp(rtrim($refOrigin, '/'), rtrim($expectedOrigin, '/')) === 0;
        }
    }

    if (!$sameOrigin) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Logout request blocked by origin check.',
            'error_code' => 'LOGOUT_ORIGIN_INVALID'
        ]);
        exit;
    }
}

try {
    $userId = $_SESSION['user_id'] ?? null;
    $userType = $_SESSION['user_type'] ?? null;
    $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';

    // Only the browser that owns the current token may revoke it. An older,
    // superseded browser must not be able to log out the newer session.
    ActiveSession::revokeCurrent($pdo);

    if ($userId && $userType) {
        if ($userType === 'student') {
            $auditStmt = $pdo->prepare("
                INSERT INTO tbl_csdl_audit_log 
                (audit_log_student_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
                VALUES (?, 'LOGOUT', 1, ?, ?, ?)
            ");
            $auditStmt->execute([
                $userId,
                'User logged out successfully',
                $ipAddress,
                $userAgent
            ]);
        } else {
            $auditStmt = $pdo->prepare("
                INSERT INTO tbl_csdl_audit_log 
                (audit_log_employee_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
                VALUES (?, 'LOGOUT', 1, ?, ?, ?)
            ");
            $auditStmt->execute([
                $userId,
                'User logged out successfully',
                $ipAddress,
                $userAgent
            ]);
        }
    }

    $_SESSION = array();

    if (isset($_COOKIE[session_name()])) {
        $cookieParams = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires' => time() - 3600,
            'path' => $cookieParams['path'] ?? '/',
            'domain' => $cookieParams['domain'] ?? '',
            'secure' => (bool)($cookieParams['secure'] ?? false),
            'httponly' => (bool)($cookieParams['httponly'] ?? true),
            'samesite' => $cookieParams['samesite'] ?? 'Lax',
        ]);
        // Extra fallback for environments where cookie attributes differ at runtime.
        setcookie(session_name(), '', time() - 3600, '/');
    }

    session_destroy();
    CSRFProtection::destroyToken();
    // Start a fresh anonymous session to avoid stale ids
    session_start();
    session_regenerate_id(true);

    echo json_encode([
        'success' => true,
        'message' => 'Logged out successfully'
    ]);

} catch(PDOException $e) {
    session_destroy();
    echo json_encode([
        'success' => true,
        'message' => 'Logged out successfully'
    ]);
}
?>
