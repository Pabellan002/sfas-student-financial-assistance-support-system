<?php
require_once __DIR__ . '/../../../api/includes/includes-security-init.php';
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}
$htmlPath = __DIR__ . '/../../../views/students/students-dashboard.html';
if (!is_file($htmlPath)) {
    http_response_code(500);
    echo 'Student dashboard view not found.';
    exit;
}
$token = CSRFProtection::generateToken();
$meta = "\n    <meta name=\"csrf-token\" content=\"" . htmlspecialchars($token, ENT_QUOTES, 'UTF-8') . "\">\n";
$html = file_get_contents($htmlPath);
$html = preg_replace('/<head>/', '<head>' . $meta, $html, 1);
echo $html;
?>

