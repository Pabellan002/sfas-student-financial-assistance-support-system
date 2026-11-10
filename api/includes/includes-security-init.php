<?php
require_once __DIR__ . '/includes-app-path.php';
require_once __DIR__ . '/includes-security-headers.php';
require_once __DIR__ . '/includes-csrf.php';
require_once __DIR__ . '/includes-input-validation.php';
require_once __DIR__ . '/includes-rate-limit.php';

SecurityHeaders::initSession();
SecurityHeaders::setHeaders();

if (!isset($_SESSION['csrf_token'])) {
    CSRFProtection::generateToken();
}

// Protect every authenticated API endpoint and guarded PHP view, not just the
// periodic session heartbeat. Authentication endpoints handle this explicitly.
if (isset($_SESSION['user_id'], $_SESSION['user_type'])) {
    $scriptName = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
    $activeSessionExempt = [
        '/api/auth/auth-login.php',
        '/api/auth/auth-check-session.php',
        '/api/auth/auth-logout.php',
        '/api/includes/includes-csrf-endpoint.php',
    ];
    $isExempt = false;
    foreach ($activeSessionExempt as $suffix) {
        if (str_ends_with($scriptName, $suffix)) {
            $isExempt = true;
            break;
        }
    }

    if (!$isExempt) {
        require_once __DIR__ . '/../config/connection-pdo.php';
        require_once __DIR__ . '/includes-active-session.php';
        require_once __DIR__ . '/includes-session-timeout.php';
        if (SessionTimeout::isExpired(SessionTimeout::seconds($pdo))) {
            ActiveSession::revokeCurrent($pdo);
            session_unset();
            session_destroy();
            if (str_contains($scriptName, '/api/')) {
                http_response_code(401);
                header('Content-Type: application/json');
                echo json_encode([
                    'success' => false,
                    'active' => false,
                    'authenticated' => false,
                    'reason' => 'session_expired',
                    'message' => 'Session expired',
                ]);
            } else {
                header('Location: ' . AppPath::url('views/auth/login.html?session_expired=1'));
            }
            exit;
        }
        $activeSessionStatus = ActiveSession::status($pdo);
        if ($activeSessionStatus !== 'current') {
            ActiveSession::clearLocalAuthentication();
            $wasReplaced = $activeSessionStatus === 'replaced';
            $isApiRequest = str_contains($scriptName, '/api/');
            if ($isApiRequest) {
                http_response_code(401);
                header('Content-Type: application/json');
                echo json_encode([
                    'success' => false,
                    'active' => false,
                    'authenticated' => false,
                    'reason' => $wasReplaced ? 'signed_in_elsewhere' : 'session_ended',
                    'message' => $wasReplaced
                        ? 'This account was signed in from another browser.'
                        : 'Your session has ended. Please sign in again.',
                ]);
            } else {
                header('Location: ' . AppPath::url('views/auth/login.html?') . ($wasReplaced ? 'signed_in_elsewhere=1' : 'session_expired=1'));
            }
            exit;
        }
    }
}

if (isset($_SESSION['user_id'], $_SESSION['user_type']) && isset($pdo)) {
    require_once __DIR__ . '/includes-audit.php';
    AuditLogger::trackRequest($pdo);
}

