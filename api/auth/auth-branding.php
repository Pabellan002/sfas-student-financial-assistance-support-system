<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// Allow any authenticated session (student or employee)
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

try {
    $stmt = $pdo->prepare("
        SELECT setting_key, setting_value
        FROM tbl_csdl_settings
        WHERE setting_key IN ('system_name', 'school_name', 'system_logo')
    ");
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $settings = [
        'system_name' => ['value' => 'Student Financial Assistance'],
        'school_name' => ['value' => ''],
        'system_logo' => ['value' => null]
    ];

    foreach ($rows as $row) {
        $key = (string)($row['setting_key'] ?? '');
        if ($key !== '') {
            $settings[$key] = ['value' => $row['setting_value'] ?? null];
        }
    }

    echo json_encode(['success' => true, 'settings' => $settings]);
} catch (Throwable $e) {
    error_log('Branding settings error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load branding settings']);
}
?>
