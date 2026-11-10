<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';

header('Cache-Control: no-store, no-cache, must-revalidate, Max-Age=0');
header('Pragma: no-cache');
header('Expires: Sat, 26 Jul 1997 05:00:00 GMT');

if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type'])) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit();
}

// Initialize RBAC
RBAC::init($pdo);

// Check Masterfiles access permission first
if (!RBAC::canAccessPage($_SESSION['user_id'], 'csdl.masterfiles.access')) {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit();
}

// Check specific Scholarships page permission
if (!RBAC::canAccessPage($_SESSION['user_id'], 'csdl.masterfiles.scholarships.access')) {
    header('Location: ' . AppPath::url('views/csdl/csdl-dashboard.html'));
    exit();
}

$html_file = __DIR__ . '/../../masterfiles/masterfiles-scholarships.html';
if (file_exists($html_file)) {
    $html_content = file_get_contents($html_file);

    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    $csrf_token = $_SESSION['csrf_token'];

    $html_content = str_replace(
        '</head>',
        '    <meta name="csrf-token" content="' . $csrf_token . '">' . "\n</head>",
        $html_content
    );

    echo RBAC::renderStaffHtml($html_content, (int)$_SESSION['user_id']);
} else {
    http_response_code(404);
    echo "404 Not Found: The requested HTML file does not exist.";
}
?>

