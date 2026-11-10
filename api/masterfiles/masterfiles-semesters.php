<?php
require_once '../config/connection-pdo.php';
require_once '../includes/includes-security-init.php';
require_once '../includes/includes-rbac.php';

header('Content-Type: application/json');

try {
    RBAC::init($pdo);
    $employeeId = (int)($_SESSION['user_id'] ?? 0);
    $action = $_GET['action'] ?? '';

    if ($action === 'list') {
        RBAC::requireMasterfileRead($employeeId, 'school_years', 'You do not have permission to view semesters');
        $stmt = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id");
        $semesters = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        echo json_encode([
            'success' => true,
            'data' => $semesters
        ]);
    } else {
        echo json_encode([
            'success' => false,
            'message' => 'Invalid action'
        ]);
    }
} catch (Exception $e) {
    echo json_encode([
        'success' => false,
        'message' => 'Error: ' . $e->getMessage()
    ]);
}
