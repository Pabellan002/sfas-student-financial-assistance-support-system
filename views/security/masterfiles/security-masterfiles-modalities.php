<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
RBAC::init($pdo);
if (!isset($_SESSION['user_id'], $_SESSION['user_type'])) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}
if (!RBAC::canAccessPage((int)$_SESSION['user_id'], 'csdl.masterfiles.access')) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}
if (!RBAC::canAccessPage((int)$_SESSION['user_id'], 'csdl.masterfiles.modalities.access')) {
    header('Location: ' . AppPath::url('views/csdl/csdl-dashboard.html'));
    exit;
}
$html = file_get_contents(__DIR__ . '/../../masterfiles/masterfiles-modalities.html');
if (empty($_SESSION['csrf_token'])) $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
echo RBAC::renderStaffHtml(str_replace('</head>', '<meta name="csrf-token" content="' . htmlspecialchars($_SESSION['csrf_token'], ENT_QUOTES, 'UTF-8') . '"></head>', $html), (int)$_SESSION['user_id']);
