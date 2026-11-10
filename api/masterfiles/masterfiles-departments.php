<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-rbac.php';

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);
$userRoleId = (int)($_SESSION['user_role_id'] ?? 0);
$userType = (string)($_SESSION['user_type'] ?? '');
$isCsdlAdminRole = ($userType === 'employee' && $userRoleId === 100);

$action = isset($_GET['action']) ? $_GET['action'] : 'list';

// Pre-parse JSON payload so CSRF token in JSON body is visible to validator
$parsedJsonPayload = [];
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    $rawBody = file_get_contents('php://input');
    if (!empty($rawBody)) {
        $decoded = json_decode($rawBody, true);
        if (is_array($decoded)) {
            $parsedJsonPayload = $decoded;
            // Allow CSRF validator (which checks $_POST/$_GET/headers) to see token from JSON body.
            if (!isset($_POST['csrf_token']) && isset($parsedJsonPayload['csrf_token'])) {
                $_POST['csrf_token'] = $parsedJsonPayload['csrf_token'];
            }
        }
    }
}

// Enforce CSRF for any state-changing action
$csrfProtectedActions = ['create', 'update', 'toggle', 'delete', 'bulk_delete', 'import'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

// Helper: read JSON body when $_POST is empty (Axios sends JSON by default)
function read_payload(): array {
    $jsonPayload = $GLOBALS['parsedJsonPayload'] ?? [];

    if (!empty($_POST)) {
        return array_merge($jsonPayload, $_POST);
    }
    return is_array($jsonPayload) ? $jsonPayload : [];
}

function departmentsNormalizeCsvHeader(string $value): string {
    $value = preg_replace('/^\xEF\xBB\xBF/', '', trim($value));
    return strtolower((string) preg_replace('/[^a-z0-9]+/i', '', $value));
}

function departmentsCsvColumn(array $headers, array $aliases): ?int {
    $normalized = array_map('departmentsNormalizeCsvHeader', $headers);
    foreach ($aliases as $alias) {
        $index = array_search(departmentsNormalizeCsvHeader($alias), $normalized, true);
        if ($index !== false) return (int) $index;
    }
    return null;
}

function departmentsCsvStatus(string $value): ?int {
    $value = strtolower(trim($value));
    if ($value === '') return null;
    if (in_array($value, ['active', '1', 'yes', 'enabled'], true)) return 1;
    if (in_array($value, ['inactive', '0', 'no', 'disabled'], true)) return 0;
    return -1;
}

try {
    if ($action === 'list') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfileRead($employeeId, 'departments', 'You do not have permission to view departments');
        }
        $stmt = $pdo->query(
            "SELECT 
                d.department_id AS id,
                d.department_code AS code,
                d.department_name AS name,
                d.departments_status AS status,
                d.department_created_at AS created_at,
                COALESCE(s.student_count, 0) AS students
             FROM tbl_csdl_departments d
             LEFT JOIN (
                 SELECT p.program_department_id AS dept_id, COUNT(DISTINCT st.student_id) AS student_count
                 FROM tbl_csdl_programs p
                 LEFT JOIN tbl_csdl_students st ON st.student_program_id = p.program_id
                 GROUP BY p.program_department_id
             ) s ON s.dept_id = d.department_id
             ORDER BY d.department_name ASC"
        );
        $rows = $stmt->fetchAll();

        // counts in the same response
        $totalDepartments = (int)$pdo->query("SELECT COUNT(*) FROM tbl_csdl_departments")->fetchColumn();
        // programs may not exist; fallback to 0
        try {
            $totalPrograms = (int)$pdo->query("SELECT COUNT(*) FROM tbl_csdl_programs")->fetchColumn();
        } catch (Throwable $e) {
            $totalPrograms = 0;
        }
        try {
            $cStmt = $pdo->query("SELECT 
                SUM(CASE WHEN COALESCE(status, department_status, departments_status, 1) = 1 THEN 1 ELSE 0 END) AS active_cnt,
                SUM(CASE WHEN COALESCE(status, department_status, departments_status, 1) = 0 THEN 1 ELSE 0 END) AS inactive_cnt
                FROM tbl_csdl_departments");
            $c = $cStmt->fetch(PDO::FETCH_ASSOC);
            $activeDepartments = (int)($c['active_cnt'] ?? 0);
            $inactiveDepartments = (int)($c['inactive_cnt'] ?? 0);
        } catch (Throwable $e) {
            $activeDepartments = $totalDepartments;
            $inactiveDepartments = 0;
        }

        echo json_encode([
            'success' => true,
            'rows' => $rows,
            'totalDepartments' => $totalDepartments,
            'totalPrograms' => $totalPrograms,
            'activeDepartments' => $activeDepartments,
            'inactiveDepartments' => $inactiveDepartments
        ]);
        exit;
    }

    if ($action === 'import' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.create', 'You do not have permission to import departments');
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.edit', 'You do not have permission to update departments through import');
        }
        if (!isset($_FILES['file'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Select a CSV file to import.']);
            exit;
        }

        [$validUpload, $uploadMessage] = UploadSecurity::validateUploadedFile(
            $_FILES['file'],
            ['csv'],
            ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'],
            5 * 1024 * 1024
        );
        if (!$validUpload) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => $uploadMessage === 'Invalid file extension.' ? 'Only CSV files can be imported.' : $uploadMessage]);
            exit;
        }

        $handle = fopen($_FILES['file']['tmp_name'], 'r');
        if ($handle === false) {
            throw new RuntimeException('Unable to read the uploaded CSV file.');
        }
        $headers = fgetcsv($handle);
        if ($headers === false) {
            fclose($handle);
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'The CSV file is empty.']);
            exit;
        }

        $codeColumn = departmentsCsvColumn($headers, ['Code', 'Department Code']);
        $nameColumn = departmentsCsvColumn($headers, ['Department', 'Department Name', 'Name']);
        $statusColumn = departmentsCsvColumn($headers, ['Status']);
        if ($codeColumn === null || $nameColumn === null) {
            fclose($handle);
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid template. Required columns: Code and Department.']);
            exit;
        }

        $findStmt = $pdo->prepare('SELECT department_id, departments_status FROM tbl_csdl_departments WHERE department_code = ? LIMIT 1');
        $insertStmt = $pdo->prepare('INSERT INTO tbl_csdl_departments (department_code, department_name, departments_status) VALUES (?, ?, ?)');
        $updateWithStatusStmt = $pdo->prepare('UPDATE tbl_csdl_departments SET department_name = ?, departments_status = ? WHERE department_id = ?');
        $updateStmt = $pdo->prepare('UPDATE tbl_csdl_departments SET department_name = ? WHERE department_id = ?');
        $created = 0;
        $updated = 0;
        $skipped = 0;
        $errors = [];
        $lineNumber = 1;

        $pdo->beginTransaction();
        try {
            while (($row = fgetcsv($handle)) !== false) {
                $lineNumber++;
                if (count(array_filter($row, static fn($value) => trim((string) $value) !== '')) === 0) continue;
                $code = strtoupper(trim((string) ($row[$codeColumn] ?? '')));
                $name = trim((string) ($row[$nameColumn] ?? ''));
                $status = $statusColumn === null ? null : departmentsCsvStatus((string) ($row[$statusColumn] ?? ''));

                if ($code === '' || $name === '') {
                    $errors[] = "Row {$lineNumber}: Code and Department are required.";
                    $skipped++;
                    continue;
                }
                if (strlen($code) > 10 || strlen($name) > 100) {
                    $errors[] = "Row {$lineNumber}: Code must be at most 10 characters and Department at most 100 characters.";
                    $skipped++;
                    continue;
                }
                if ($status === -1) {
                    $errors[] = "Row {$lineNumber}: Status must be Active or Inactive.";
                    $skipped++;
                    continue;
                }

                try {
                    $findStmt->execute([$code]);
                    $existing = $findStmt->fetch(PDO::FETCH_ASSOC);
                    if ($existing) {
                        if ($status === null) $updateStmt->execute([$name, (int) $existing['department_id']]);
                        else $updateWithStatusStmt->execute([$name, $status, (int) $existing['department_id']]);
                        $updated++;
                    } else {
                        $insertStmt->execute([$code, $name, $status ?? 1]);
                        $created++;
                    }
                } catch (PDOException $e) {
                    $errors[] = "Row {$lineNumber}: Unable to import department {$code}.";
                    $skipped++;
                }
            }
            fclose($handle);
            $pdo->commit();
        } catch (Throwable $e) {
            fclose($handle);
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }

        echo json_encode([
            'success' => true,
            'message' => "Import completed. {$created} departments added, {$updated} updated, {$skipped} skipped.",
            'created' => $created,
            'updated' => $updated,
            'skipped' => $skipped,
            'errors' => $errors,
        ]);
        exit;
    }

    // Create department
    if ($action === 'create' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.create', 'You do not have permission to create departments');
        }
        $payload = read_payload();
        $code = trim($payload['code'] ?? '');
        $name = trim($payload['name'] ?? '');
        if ($code === '' || $name === '') {
            echo json_encode(['success' => false, 'message' => 'Code and Name are required.']);
            exit;
        }
        $stmt = $pdo->prepare("INSERT INTO tbl_csdl_departments (department_code, department_name, departments_status) VALUES (:code, :name, 1)");
        $stmt->execute([':code' => $code, ':name' => $name]);
        echo json_encode(['success' => true, 'message' => 'Department added successfully.']);
        exit;
    }

    // Update department
    if ($action === 'update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.edit', 'You do not have permission to edit departments');
        }
        $payload = read_payload();
        $id = intval($payload['id'] ?? 0);
        $code = trim($payload['code'] ?? '');
        $name = trim($payload['name'] ?? '');
        if ($id <= 0 || $code === '' || $name === '') {
            echo json_encode(['success' => false, 'message' => 'Invalid payload.']);
            exit;
        }
        $stmt = $pdo->prepare("UPDATE tbl_csdl_departments SET department_code = :code, department_name = :name WHERE department_id = :id");
        $stmt->execute([':code' => $code, ':name' => $name, ':id' => $id]);
        echo json_encode(['success' => true, 'message' => 'Department updated successfully.']);
        exit;
    }

    // Toggle active status
    if ($action === 'toggle' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.edit', 'You do not have permission to edit departments');
        }
        $payload = read_payload();
        $id = intval($payload['id'] ?? 0);
        if ($id <= 0) {
            echo json_encode(['success' => false, 'message' => 'Invalid department id.']);
            exit;
        }
        $stmt = $pdo->prepare("UPDATE tbl_csdl_departments SET departments_status = CASE WHEN COALESCE(departments_status,1)=1 THEN 0 ELSE 1 END WHERE department_id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true, 'message' => 'Department status updated.']);
        exit;
    }

    // Delete department
    if ($action === 'bulk_delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.delete', 'You do not have permission to delete departments');
        }
        $payload = read_payload();
        $rawIds = $payload['department_ids'] ?? [];
        if (!is_array($rawIds)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Department IDs must be provided as a list.']);
            exit;
        }
        $ids = array_values(array_unique(array_filter(
            array_map('intval', $rawIds),
            static fn(int $id): bool => $id > 0
        )));
        if (count($ids) === 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Select at least one department to delete.']);
            exit;
        }
        if (count($ids) > 100) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'You can delete up to 100 departments at a time.']);
            exit;
        }

        $findStmt = $pdo->prepare('SELECT department_code, department_name FROM tbl_csdl_departments WHERE department_id = ? LIMIT 1');
        $programCountStmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_programs WHERE program_department_id = ?');
        $deleteStmt = $pdo->prepare('DELETE FROM tbl_csdl_departments WHERE department_id = ?');
        $deletedIds = [];
        $failed = [];

        $pdo->beginTransaction();
        try {
            foreach ($ids as $id) {
                $findStmt->execute([$id]);
                $department = $findStmt->fetch(PDO::FETCH_ASSOC);
                if (!$department) {
                    $failed[] = ['department_id' => $id, 'code' => '', 'name' => '', 'reason' => 'Department was not found.'];
                    continue;
                }

                $programCountStmt->execute([$id]);
                $programCount = (int)$programCountStmt->fetchColumn();
                if ($programCount > 0) {
                    $failed[] = [
                        'department_id' => $id,
                        'code' => $department['department_code'] ?? '',
                        'name' => $department['department_name'] ?? '',
                        'reason' => "Department contains {$programCount} program(s)."
                    ];
                    continue;
                }

                try {
                    $deleteStmt->execute([$id]);
                    if ($deleteStmt->rowCount() === 1) {
                        $deletedIds[] = $id;
                    } else {
                        $failed[] = [
                            'department_id' => $id,
                            'code' => $department['department_code'] ?? '',
                            'name' => $department['department_name'] ?? '',
                            'reason' => 'Department was not found.'
                        ];
                    }
                } catch (PDOException $deleteError) {
                    $failed[] = [
                        'department_id' => $id,
                        'code' => $department['department_code'] ?? '',
                        'name' => $department['department_name'] ?? '',
                        'reason' => 'Department is linked to another record.'
                    ];
                }
            }
            $pdo->commit();
        } catch (Throwable $bulkDeleteError) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $bulkDeleteError;
        }

        echo json_encode([
            'success' => true,
            'message' => count($deletedIds) . ' department(s) deleted.',
            'deleted_count' => count($deletedIds),
            'deleted_ids' => $deletedIds,
            'failed' => $failed,
        ]);
        exit;
    }

    if ($action === 'delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isCsdlAdminRole) {
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.departments.delete', 'You do not have permission to delete departments');
        }
        $payload = read_payload();
        $id = intval($payload['id'] ?? 0);
        if ($id <= 0) {
            echo json_encode(['success' => false, 'message' => 'Invalid department id.']);
            exit;
        }
        $programCountStmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_programs WHERE program_department_id = :id');
        $programCountStmt->execute([':id' => $id]);
        if ((int)$programCountStmt->fetchColumn() > 0) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'This department still contains programs and cannot be deleted.']);
            exit;
        }
        $stmt = $pdo->prepare("DELETE FROM tbl_csdl_departments WHERE department_id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true, 'message' => 'Department deleted.']);
        exit;
    }

    http_response_code(400);
    echo json_encode([ 'success' => false, 'message' => 'Unsupported action' ]);
} catch (Throwable $e) {
    error_log('masterfiles-departments.php error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Server error while processing departments request.',
        'error_code' => 'DEPARTMENTS_API_ERROR'
    ]);
}
?>
