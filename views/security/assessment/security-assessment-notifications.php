<?php
session_start();

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type'])) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit();
}

$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 101 && $userRoleId != 100) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit();
}

$htmlPath = __DIR__ . '/../../assessment/assessment-notifications.html';
if (!is_file($htmlPath)) {
    http_response_code(500);
    echo 'Notifications view not found.';
    exit;
}

$html = file_get_contents($htmlPath);
if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}
$meta = "\n    <meta name=\"csrf-token\" content=\"" . htmlspecialchars($_SESSION['csrf_token'], ENT_QUOTES, 'UTF-8') . "\">\n";
$html = preg_replace('/<head>/', '<head>' . $meta, $html, 1);
echo RBAC::renderStaffHtml($html, (int)$_SESSION['user_id']);
