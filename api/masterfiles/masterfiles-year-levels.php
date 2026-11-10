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
$csrfProtectedActions = ['create', 'update', 'delete'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

try {
    switch ($action) {
        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'year_levels', 'You do not have permission to view year levels');
            $stmt = $pdo->query(
                "SELECT 
                    yl.year_level_id AS id,
                    yl.year_level_code AS code,
                    yl.year_level_name AS name,
                    yl.year_level_type AS type,
                    COALESCE(s.student_count, 0) AS students
                 FROM tbl_csdl_year_levels yl
                 LEFT JOIN (
                    SELECT student_year_level_id AS yl_id, COUNT(*) AS student_count
                    FROM tbl_csdl_students
                    GROUP BY student_year_level_id
                 ) s ON s.yl_id = yl.year_level_id
                 ORDER BY yl.year_level_code ASC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate counts
            $totalYearLevels = count($rows);
            $collegeYearLevels = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['type'] ?? '') === 'college' ? 1 : 0), 0);
            $seniorHighYearLevels = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['type'] ?? '') === 'senior_high' ? 1 : 0), 0);
            $basicEducationYearLevels = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['type'] ?? '') === 'basic_education' ? 1 : 0), 0);

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'totalYearLevels' => $totalYearLevels,
                'collegeYearLevels' => $collegeYearLevels,
                'seniorHighYearLevels' => $seniorHighYearLevels,
                'basicEducationYearLevels' => $basicEducationYearLevels
            ]);
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.year_levels.create', 'You do not have permission to create year levels');
            $code = $_POST['year_level_code'] ?? '';
            $name = $_POST['year_level_name'] ?? '';
            $type = $_POST['year_level_type'] ?? 'college';

            if (empty($code) || empty($name)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Year Level Code and Name are required.']);
                exit;
            }

            $stmt = $pdo->prepare("INSERT INTO tbl_csdl_year_levels (year_level_code, year_level_name, year_level_type) VALUES (?, ?, ?)");
            $stmt->execute([$code, $name, $type]);
            echo json_encode(['success' => true, 'message' => 'Year Level added successfully.']);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.year_levels.edit', 'You do not have permission to edit year levels');
            $id = $_POST['year_level_id'] ?? null;
            $code = $_POST['year_level_code'] ?? '';
            $name = $_POST['year_level_name'] ?? '';
            $type = $_POST['year_level_type'] ?? 'college';

            if (empty($id) || empty($code) || empty($name)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Year Level ID, Code, and Name are required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_year_levels SET year_level_code = ?, year_level_name = ?, year_level_type = ? WHERE year_level_id = ?");
            $stmt->execute([$code, $name, $type, $id]);
            echo json_encode(['success' => true, 'message' => 'Year Level updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.year_levels.delete', 'You do not have permission to delete year levels');
            $id = $_POST['year_level_id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Year Level ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("DELETE FROM tbl_csdl_year_levels WHERE year_level_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Year Level deleted successfully.']);
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (Throwable $e) {
    error_log("API Error in masterfiles-year-levels.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
?>

