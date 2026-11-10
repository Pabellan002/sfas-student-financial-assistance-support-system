<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type'])) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

$userRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
if ($userRoleId !== 98) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

// Initialize RBAC
RBAC::init($pdo);

// Check page access permission
if (!RBAC::canAccessPage($_SESSION['user_id'], 'branch_admin.dashboard.access')) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

$htmlPath = __DIR__ . '/../../../views/branch-admin/branch-admin-dashboard.html';
if (!is_file($htmlPath)) {
    http_response_code(500);
    echo 'Branch Admin dashboard view not found.';
    exit;
}

$token = CSRFProtection::generateToken();
$meta = "\n    <meta name=\"csrf-token\" content=\"" . htmlspecialchars($token, ENT_QUOTES, 'UTF-8') . "\">\n";
$html = file_get_contents($htmlPath);
$html = preg_replace('/<head>/', '<head>' . $meta, $html, 1);
echo RBAC::renderStaffHtml($html, (int)$_SESSION['user_id']);
