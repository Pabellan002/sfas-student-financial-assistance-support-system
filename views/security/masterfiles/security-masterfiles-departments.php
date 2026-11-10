<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if (empty($_SESSION['user_id']) || empty($_SESSION['user_type'])) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

// Initialize RBAC
RBAC::init($pdo);

// Check Masterfiles access permission first
if (!RBAC::canAccessPage($_SESSION['user_id'], 'csdl.masterfiles.access')) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit();
}

// Check specific Departments page permission
if (!RBAC::canAccessPage($_SESSION['user_id'], 'csdl.masterfiles.departments.access')) {
    header('Location: ' . AppPath::url('views/csdl/csdl-dashboard.html'));
    exit();
}

$htmlPath = __DIR__ . '/../../masterfiles/masterfiles-departments.html';
$html = file_exists($htmlPath) ? file_get_contents($htmlPath) : '';

$token = CSRFProtection::generateToken();

if ($html) {
    $injected = preg_replace(
        '/<head>/i',
        '<head>' . "\n<meta name=\"csrf-token\" content=\"" . htmlspecialchars($token, ENT_QUOTES, 'UTF-8') . "\">",
        $html,
        1
    );
    echo RBAC::renderStaffHtml($injected, (int)$_SESSION['user_id']);
} else {
    http_response_code(500);
    echo 'Missing departments view';
}
?>


