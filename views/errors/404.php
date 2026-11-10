<?php
require_once __DIR__ . '/../../api/includes/includes-app-path.php';
http_response_code(404);
header('Content-Type: text/html; charset=UTF-8');
$html = file_get_contents(__DIR__ . '/404.html');
$base = htmlspecialchars(AppPath::url(''), ENT_QUOTES, 'UTF-8');
echo preg_replace('/<base href="[^"]*">/', '<base href="' . $base . '">', $html, 1);
