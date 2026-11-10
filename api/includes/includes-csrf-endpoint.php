<?php
require_once __DIR__ . '/../includes/includes-security-init.php';

// Allow CSRF token fetching from Cloudflare Tunnel or other proxy environments
// This is safe because CSRF tokens are meant to be read by the frontend
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin && (
    strpos($origin, 'localhost') !== false || 
    strpos($origin, '127.0.0.1') !== false ||
    strpos($origin, 'trycloudflare.com') !== false ||
    strpos($origin, $_SERVER['HTTP_HOST'] ?? '') !== false
)) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token');
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['action']) && $_GET['action'] === 'get_token') {
    CSRFProtection::getTokenJSON();
} else {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
}
?>

