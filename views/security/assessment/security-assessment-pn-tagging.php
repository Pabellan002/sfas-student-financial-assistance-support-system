<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee'
    || (int) ($_SESSION['user_role_id'] ?? 0) !== 101) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}
RBAC::init($pdo);
$employeeId = (int) $_SESSION['user_id'];
if (!RBAC::hasPermission($employeeId, 'assessment.pntagging.access')) {
    http_response_code(403);
    echo 'You do not have permission to access Assessment PN Tagging.';
    exit;
}
$html = file_get_contents(__DIR__ . '/../../assessment/assessment-pn-tagging.html');
$meta = '<meta name="csrf-token" content="' . htmlspecialchars(CSRFProtection::generateToken(), ENT_QUOTES, 'UTF-8') . '">';
$html = preg_replace('/<head>/', '<head>' . $meta, $html, 1);
echo RBAC::renderStaffHtml($html, $employeeId);
