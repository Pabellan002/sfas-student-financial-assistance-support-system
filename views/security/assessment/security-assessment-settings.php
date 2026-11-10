<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

if ((int) ($_SESSION['user_role_id'] ?? 0) !== 101) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

RBAC::init($pdo);
if (!RBAC::canAccessPage($_SESSION['user_id'], 'assessment.settings.access')) {
    http_response_code(403);
    echo 'Access denied.';
    exit;
}

$htmlPath = __DIR__ . '/../../../views/assessment/assessment-settings.html';
if (!is_file($htmlPath)) {
    http_response_code(500);
    echo 'Assessment settings view not found.';
    exit;
}

$token = CSRFProtection::generateToken();
$meta = "\n    <meta name=\"csrf-token\" content=\"" . htmlspecialchars($token, ENT_QUOTES, 'UTF-8') . "\">\n";
$html = file_get_contents($htmlPath);
echo RBAC::renderStaffHtml(preg_replace('/<head>/', '<head>' . $meta, $html, 1), (int)$_SESSION['user_id']);
?>
