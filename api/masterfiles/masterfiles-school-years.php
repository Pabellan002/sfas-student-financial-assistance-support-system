<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-rbac.php';

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);

$action = $_GET['action'] ?? 'list';

// Read JSON input for POST requests if $_POST is empty
$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && $input !== null) {
    $_POST = $input;
}

// Enforce CSRF for any state-changing action
$csrfProtectedActions = ['create', 'update', 'toggle', 'delete'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

try {
    switch ($action) {
        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'school_years', 'You do not have permission to view school years');
            $stmt = $pdo->query(
                "SELECT 
                    sy.sy_id AS id,
                    sy.sy_code AS code,
                    sy.sy_semester_id AS semester_id,
                    sem.semester_name AS semester_name,
                    sy.sy_start_date AS start_date,
                    sy.sy_end_date AS end_date,
                    sy.sy_status AS status
                 FROM tbl_csdl_school_years sy
                 LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
                 ORDER BY sy.sy_code ASC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate counts
            $totalSchoolYears = count($rows);
            $activeSchoolYears = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['status'] ?? '0') === '1' ? 1 : 0), 0);
            $inactiveSchoolYears = $totalSchoolYears - $activeSchoolYears;

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'totalSchoolYears' => $totalSchoolYears,
                'activeSchoolYears' => $activeSchoolYears,
                'inactiveSchoolYears' => $inactiveSchoolYears
            ]);
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.school_years.create', 'You do not have permission to create school years');
            $code = $_POST['sy_code'] ?? '';
            $semesterId = $_POST['sy_semester_id'] ?? null;
            $startDate = $_POST['sy_start_date'] ?? null;
            $endDate = $_POST['sy_end_date'] ?? null;

            if (empty($code) || empty($semesterId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School Year Code and Semester are required.']);
                exit;
            }

            $stmt = $pdo->prepare("INSERT INTO tbl_csdl_school_years (sy_code, sy_semester_id, sy_start_date, sy_end_date, sy_status) VALUES (?, ?, ?, ?, 1)");
            $stmt->execute([$code, $semesterId, $startDate ?: null, $endDate ?: null]);
            echo json_encode(['success' => true, 'message' => 'School Year added successfully.']);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.school_years.edit', 'You do not have permission to edit school years');
            $id = $_POST['sy_id'] ?? null;
            $code = $_POST['sy_code'] ?? '';
            $semesterId = $_POST['sy_semester_id'] ?? null;
            $startDate = $_POST['sy_start_date'] ?? null;
            $endDate = $_POST['sy_end_date'] ?? null;

            if (empty($id) || empty($code) || empty($semesterId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School Year ID, Code, and Semester are required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_school_years SET sy_code = ?, sy_semester_id = ?, sy_start_date = ?, sy_end_date = ? WHERE sy_id = ?");
            $stmt->execute([$code, $semesterId, $startDate ?: null, $endDate ?: null, $id]);
            echo json_encode(['success' => true, 'message' => 'School Year updated successfully.']);
            break;

        case 'toggle':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.school_years.edit', 'You do not have permission to edit school years');
            $id = $_POST['sy_id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School Year ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_school_years SET sy_status = (1 - sy_status) WHERE sy_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'School Year status updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.school_years.delete', 'You do not have permission to delete school years');
            $id = $_POST['sy_id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School Year ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("DELETE FROM tbl_csdl_school_years WHERE sy_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'School Year deleted successfully.']);
            break;

        case 'semesters':
            RBAC::requireMasterfileRead($employeeId, 'school_years', 'You do not have permission to view school years');
            $stmt = $pdo->query("SELECT semester_id AS id, semester_name AS name FROM tbl_csdl_semesters ORDER BY semester_name ASC");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'rows' => $rows]);
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (Throwable $e) {
    error_log("API Error in masterfiles-school-years.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
?>

