<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-rbac.php';

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);
$userRoleId = (int)($_SESSION['user_role_id'] ?? 0);
$userType = (string)($_SESSION['user_type'] ?? '');
$isCsdlAdminRole = ($userType === 'employee' && $userRoleId === 100);

$action = $_GET['action'] ?? 'list';

$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && is_array($input)) {
    $_POST = $input;
}

$csrfProtectedActions = ['create', 'update', 'toggle', 'delete'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

try {
    switch ($action) {
        case 'list':
            if (!$isCsdlAdminRole) {
                RBAC::requireMasterfileRead($employeeId, 'campuses', 'You do not have permission to view campuses');
            }
            $stmt = $pdo->query(
                "SELECT 
                    c.campus_id AS id,
                    c.campus_code AS code,
                    c.campus_name AS name,
                    c.campus_address AS address,
                    c.campus_status AS status,
                    COALESCE(st.student_count, 0) AS students
                 FROM tbl_csdl_campuses c
                 LEFT JOIN (
                    SELECT student_campus_id AS campus_id, COUNT(*) AS student_count
                    FROM tbl_csdl_students
                    WHERE student_campus_id IS NOT NULL
                    GROUP BY student_campus_id
                 ) st ON st.campus_id = c.campus_id
                 ORDER BY c.campus_name ASC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $totalCampuses = count($rows);
            $activeCampuses = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['status'] ?? '0') === '1' ? 1 : 0), 0);
            $inactiveCampuses = $totalCampuses - $activeCampuses;
            $totalStudents = array_reduce($rows, fn($carry, $item) => $carry + (int)($item['students'] ?? 0), 0);

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'totalCampuses' => $totalCampuses,
                'activeCampuses' => $activeCampuses,
                'inactiveCampuses' => $inactiveCampuses,
                'totalStudents' => $totalStudents,
            ]);
            break;

        case 'create':
            if (!$isCsdlAdminRole) {
                RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.campuses.create', 'You do not have permission to create campuses');
            }
            $code = trim($_POST['campus_code'] ?? '');
            $name = trim($_POST['campus_name'] ?? '');
            $address = trim($_POST['campus_address'] ?? '');

            if ($code === '' || $name === '') {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Campus code and name are required.']);
                exit;
            }

            $stmt = $pdo->prepare("INSERT INTO tbl_csdl_campuses (campus_code, campus_name, campus_address, campus_status) VALUES (?, ?, ?, 1)");
            $stmt->execute([$code, $name, $address !== '' ? $address : null]);
            echo json_encode(['success' => true, 'message' => 'Campus added successfully.']);
            break;

        case 'update':
            if (!$isCsdlAdminRole) {
                RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.campuses.edit', 'You do not have permission to edit campuses');
            }
            $id = (int)($_POST['campus_id'] ?? 0);
            $code = trim($_POST['campus_code'] ?? '');
            $name = trim($_POST['campus_name'] ?? '');
            $address = trim($_POST['campus_address'] ?? '');

            if ($id <= 0 || $code === '' || $name === '') {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Campus ID, code, and name are required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_campuses SET campus_code = ?, campus_name = ?, campus_address = ? WHERE campus_id = ?");
            $stmt->execute([$code, $name, $address !== '' ? $address : null, $id]);
            echo json_encode(['success' => true, 'message' => 'Campus updated successfully.']);
            break;

        case 'toggle':
            if (!$isCsdlAdminRole) {
                RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.campuses.edit', 'You do not have permission to edit campuses');
            }
            $id = (int)($_POST['campus_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Campus ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_campuses SET campus_status = (1 - campus_status) WHERE campus_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Campus status updated successfully.']);
            break;

        case 'delete':
            if (!$isCsdlAdminRole) {
                RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.campuses.delete', 'You do not have permission to delete campuses');
            }
            $id = (int)($_POST['campus_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Campus ID is required.']);
                exit;
            }

            $studentStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_students WHERE student_campus_id = ?");
            $studentStmt->execute([$id]);
            if ((int)$studentStmt->fetchColumn() > 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Cannot delete campus with assigned students.']);
                exit;
            }

            $employeeStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_employees WHERE employee_campus_id = ?");
            $employeeStmt->execute([$id]);
            if ((int)$employeeStmt->fetchColumn() > 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Cannot delete campus with assigned employees.']);
                exit;
            }

            $stmt = $pdo->prepare("DELETE FROM tbl_csdl_campuses WHERE campus_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Campus deleted successfully.']);
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (Throwable $e) {
    error_log('masterfiles-campuses.php error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
