<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-input-validation.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-audit.php';

/** Read the employee template without changing any employee records. */
function readEmployeeImportRows(string $path, string $extension): array
{
    $headers = ['Employee ID', 'First Name', 'Middle Name', 'Last Name', 'Department', 'Email', 'Campus', 'Contact Number', 'Date of Birth', 'Gender', 'Status'];
    $required = ['Employee ID', 'First Name', 'Last Name', 'Department'];
    $spreadsheet = null;
    $handle = null;

    try {
        if ($extension === 'csv') {
            $handle = fopen($path, 'r');
            if ($handle === false) {
                throw new RuntimeException('Failed to open CSV file.');
            }
            // Strip the UTF-8 BOM before CSV parsing so a quoted first header is read correctly.
            if (fread($handle, 3) !== "\xEF\xBB\xBF") {
                rewind($handle);
            }
            $records = (function () use ($handle) {
                while (($record = fgetcsv($handle, 0, ',', '"', '')) !== false) {
                    yield $record;
                }
            })();
        } elseif (in_array($extension, ['xls', 'xlsx'], true)) {
            require_once __DIR__ . '/../../vendor/autoload.php';
            $reader = \PhpOffice\PhpSpreadsheet\IOFactory::createReader($extension === 'xlsx' ? 'Xlsx' : 'Xls');
            $sheets = $reader->listWorksheetNames($path);
            if (empty($sheets)) {
                throw new RuntimeException('The Excel file has no worksheets.');
            }
            $reader->setLoadSheetsOnly($sheets[0]);
            $reader->setReadEmptyCells(false);
            $spreadsheet = $reader->load($path);
            $sheet = $spreadsheet->getSheet(0);
            $records = $sheet->rangeToArrayYieldRows('A1:' . $sheet->getHighestDataColumn() . $sheet->getHighestDataRow(), null, false, true);
        } else {
            throw new RuntimeException('Only CSV and Excel files are allowed.');
        }

        $headerMap = null;
        $rows = [];
        $line = 0;
        foreach ($records as $record) {
            $line++;
            if ($headerMap === null) {
                $record = array_map(static fn($value) => trim((string)$value), $record);
                $record[0] = preg_replace('/^\xEF\xBB\xBF/', '', $record[0] ?? '');
                if (array_diff($required, $record)) {
                    throw new RuntimeException('File must contain required headers: ' . implode(', ', $required));
                }
                $headerMap = [];
                foreach ($headers as $header) {
                    $column = array_search($header, $record, true);
                    if ($column !== false) {
                        $headerMap[strtolower(str_replace(' ', '_', $header))] = $column;
                    }
                }
                continue;
            }

            $row = [];
            foreach ($headerMap as $key => $column) {
                $value = $record[$column] ?? '';
                if ($spreadsheet !== null && $key === 'date_of_birth') {
                    $rawValue = $sheet->getCell([$column + 1, $line])->getValue();
                    if (is_numeric($rawValue)) {
                        $value = \PhpOffice\PhpSpreadsheet\Shared\Date::excelToDateTimeObject((float)$rawValue, null, $spreadsheet->getExcelCalendar())->format('Y-m-d');
                    }
                }
                $row[$key] = trim((string)$value);
            }
            if (array_filter($row, static fn($value) => $value !== '')) {
                // Keep the original row number for validation errors, including blank rows.
                $rows[$line - 2] = $row;
            }
        }
        if (empty($rows)) {
            throw new RuntimeException('File must contain at least a header row and one data row.');
        }
        return $rows;
    } finally {
        if (is_resource($handle)) {
            fclose($handle);
        }
        if ($spreadsheet !== null) {
            $spreadsheet->disconnectWorksheets();
        }
    }
}

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);

$action = $_GET['action'] ?? 'list';

// Read JSON input for POST requests if $_POST is empty
$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && $input !== null) {
    $_POST = $input;
}

if ($action === 'reset_password' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['success' => false, 'message' => 'Use POST to reset a password.']);
    exit;
}

// Enforce CSRF for any state-changing action
$csrfProtectedActions = ['reset_password', 'create', 'update', 'toggle', 'delete', 'import', 'import_preview'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

try {
    switch ($action) {
        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'employees', 'You do not have permission to view employees');
            $stmt = $pdo->query(
                "SELECT 
                    e.employee_id AS id,
                    e.employee_school_id AS school_id,
                    e.employee_role_id AS role_id,
                    r.role_name AS role_name,
                    e.employee_first_name AS first_name,
                    e.employee_middle_name AS middle_name,
                    e.employee_last_name AS last_name,
                    e.employee_date_of_birth AS date_of_birth,
                    e.employee_gender AS gender,
                    e.employee_contact_number AS contact_number,
                    e.employee_email AS email,
                    e.employee_campus_id AS campus_id,
                    c.campus_name AS campus_name,
                    CASE
                        WHEN COALESCE(pa.role_permission_count, 0) > 0
                         AND COALESCE(pa.granted_permission_count, 0) = pa.role_permission_count
                        THEN 'All Access'
                        ELSE 'Limited Access'
                    END AS access_granted,
                    e.employee_status AS status,
                    e.employee_created_at AS created_at
                 FROM tbl_csdl_employees e
                 LEFT JOIN tbl_csdl_roles r ON e.employee_role_id = r.role_id
                 LEFT JOIN tbl_csdl_campuses c ON e.employee_campus_id = c.campus_id
                 LEFT JOIN (
                    SELECT
                        er.employee_id,
                        COUNT(rp.permission_id) AS role_permission_count,
                        SUM(CASE WHEN COALESCE(ep.is_granted, 1) = 1 THEN 1 ELSE 0 END) AS granted_permission_count
                    FROM tbl_csdl_employees er
                    LEFT JOIN tbl_csdl_role_permissions rp ON rp.role_id = er.employee_role_id
                    LEFT JOIN tbl_csdl_employee_permissions ep
                        ON ep.employee_id = er.employee_id
                       AND ep.permission_id = rp.permission_id
                    GROUP BY er.employee_id
                 ) pa ON pa.employee_id = e.employee_id
                 ORDER BY e.employee_last_name ASC, e.employee_first_name ASC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate counts
            $totalEmployees = count($rows);
            $activeEmployees = array_reduce($rows, fn($carry, $item) => $carry + ((int)($item['status'] ?? 0) === 1 ? 1 : 0), 0);
            $inactiveEmployees = $totalEmployees - $activeEmployees;
            
            // Count by role
            $csdlEmployees = array_reduce($rows, fn($carry, $item) => $carry + ((int)($item['role_id'] ?? 0) === 100 ? 1 : 0), 0);
            $financeEmployees = array_reduce($rows, fn($carry, $item) => $carry + ((int)($item['role_id'] ?? 0) === 99 ? 1 : 0), 0);
            $branchAdminEmployees = array_reduce($rows, fn($carry, $item) => $carry + ((int)($item['role_id'] ?? 0) === 98 ? 1 : 0), 0);
            $cooEmployees = array_reduce($rows, fn($carry, $item) => $carry + ((int)($item['role_id'] ?? 0) === 97 ? 1 : 0), 0);

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'totalEmployees' => $totalEmployees,
                'activeEmployees' => $activeEmployees,
                'inactiveEmployees' => $inactiveEmployees,
                'csdlEmployees' => $csdlEmployees,
                'financeEmployees' => $financeEmployees,
                'branchAdminEmployees' => $branchAdminEmployees,
                'cooEmployees' => $cooEmployees
            ]);
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.employees.create', 'You do not have permission to create employees');
            $schoolId = trim($_POST['school_id'] ?? '');
            $roleId = intval($_POST['role_id'] ?? 0);
            $firstName = trim($_POST['first_name'] ?? '');
            $middleName = trim($_POST['middle_name'] ?? '');
            $lastName = trim($_POST['last_name'] ?? '');
            $dateOfBirth = $_POST['date_of_birth'] ?? null;
            $gender = $_POST['gender'] ?? null;
            $contactNumber = trim($_POST['contact_number'] ?? '');
            $email = trim($_POST['email'] ?? '');
            $campusId = intval($_POST['campus_id'] ?? 0);

            if (empty($schoolId) || empty($firstName) || empty($lastName) || $roleId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School ID, First Name, Last Name, and Role are required.']);
                exit;
            }

            if (!InputValidation::validateSchoolId($schoolId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid school ID format.']);
                exit;
            }

            // Check if school_id already exists
            $checkStmt = $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_school_id = ? LIMIT 1");
            $checkStmt->execute([$schoolId]);
            if ($checkStmt->fetch()) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School ID already exists.']);
                exit;
            }

            // Validate email if provided
            if (!empty($email) && !InputValidation::validateEmail($email)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid email format.']);
                exit;
            }

            // Validate phone if provided
            if (!empty($contactNumber) && !InputValidation::validatePhone($contactNumber)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid contact number format.']);
                exit;
            }

            $passwordHash = password_hash($schoolId, PASSWORD_DEFAULT);

            $stmt = $pdo->prepare("INSERT INTO tbl_csdl_employees (employee_school_id, employee_role_id, employee_first_name, employee_middle_name, employee_last_name, employee_date_of_birth, employee_gender, employee_contact_number, employee_email, employee_password_hash, employee_campus_id, employee_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)");
            $stmt->execute([$schoolId, $roleId, $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender ?: null, $contactNumber ?: null, $email ?: null, $passwordHash, $campusId ?: null]);
            
            echo json_encode(['success' => true, 'message' => 'Employee added successfully.']);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.employees.edit', 'You do not have permission to edit employees');
            $id = intval($_POST['employee_id'] ?? 0);
            $schoolId = trim($_POST['school_id'] ?? '');
            $roleId = intval($_POST['role_id'] ?? 0);
            $firstName = trim($_POST['first_name'] ?? '');
            $middleName = trim($_POST['middle_name'] ?? '');
            $lastName = trim($_POST['last_name'] ?? '');
            $dateOfBirth = $_POST['date_of_birth'] ?? null;
            $gender = $_POST['gender'] ?? null;
            $contactNumber = trim($_POST['contact_number'] ?? '');
            $email = trim($_POST['email'] ?? '');
            $campusId = intval($_POST['campus_id'] ?? 0);

            if ($id <= 0 || empty($schoolId) || empty($firstName) || empty($lastName) || $roleId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Employee ID, School ID, First Name, Last Name, and Role are required.']);
                exit;
            }

            if (!InputValidation::validateSchoolId($schoolId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid school ID format.']);
                exit;
            }

            // Check if school_id already exists for another employee
            $checkStmt = $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_school_id = ? AND employee_id != ? LIMIT 1");
            $checkStmt->execute([$schoolId, $id]);
            if ($checkStmt->fetch()) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School ID already exists.']);
                exit;
            }

            // Validate email if provided
            if (!empty($email) && !InputValidation::validateEmail($email)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid email format.']);
                exit;
            }

            // Validate phone if provided
            if (!empty($contactNumber) && !InputValidation::validatePhone($contactNumber)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid contact number format.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_employees SET employee_school_id = ?, employee_role_id = ?, employee_first_name = ?, employee_middle_name = ?, employee_last_name = ?, employee_date_of_birth = ?, employee_gender = ?, employee_contact_number = ?, employee_email = ?, employee_campus_id = ? WHERE employee_id = ?");
            $stmt->execute([$schoolId, $roleId, $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender ?: null, $contactNumber ?: null, $email ?: null, $campusId ?: null, $id]);
            
            echo json_encode(['success' => true, 'message' => 'Employee updated successfully.']);
            break;

        case 'reset_password':
            if (($_SESSION['user_type'] ?? '') !== 'employee' || $employeeId <= 0) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Employee authentication is required.']);
                break;
            }
            RBAC::requirePermission($employeeId, 'csdl.masterfiles.employees.edit', 'You do not have permission to reset employee passwords');
            $id = filter_var($_POST['employee_id'] ?? null, FILTER_VALIDATE_INT);
            if (!$id || $id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'A valid employee ID is required.']);
                break;
            }

            $pdo->beginTransaction();
            $accountStmt = $pdo->prepare("SELECT employee_school_id FROM tbl_csdl_employees WHERE employee_id = ? FOR UPDATE");
            $accountStmt->execute([$id]);
            $schoolId = $accountStmt->fetchColumn();
            if ($schoolId === false || trim((string)$schoolId) === '') {
                $pdo->rollBack();
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'The employee account could not be found.']);
                break;
            }
            // The existing policy requires a school-ID password to be changed at sign-in.
            $newHash = password_hash((string)$schoolId, PASSWORD_DEFAULT);
            $update = $pdo->prepare("UPDATE tbl_csdl_employees SET employee_password_hash = ?, employee_password_changed_at = NOW(), employee_updated_at = NOW() WHERE employee_id = ?");
            $update->execute([$newHash, $id]);
            $revoke = $pdo->prepare("DELETE FROM tbl_csdl_active_sessions WHERE active_session_user_type = ? AND active_session_user_id = ?");
            $revoke->execute(['employee', $id]);
            $clearOtp = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_employee_id = ?");
            $clearOtp->execute([$id]);
            $unlock = $pdo->prepare("UPDATE tbl_csdl_account_security SET security_failed_login_attempts = 0, security_account_locked_until = NULL WHERE security_employee_id = ?");
            $unlock->execute([$id]);
            $clearAttempts = $pdo->prepare("DELETE FROM tbl_csdl_rate_limits WHERE rate_limit_employee_id = ? AND rate_limit_action = 'login_failed'");
            $clearAttempts->execute([$id]);
            AuditLogger::log($pdo, 'RESET_PASSWORD', json_encode([
                'target_user_type' => 'employee', 'target_user_id' => $id,
                'reset_to_default' => true,
            ]), null, $employeeId);
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Password reset to the school ID. The account must change its password at the next sign-in.']);
            break;

        case 'toggle':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.employees.edit', 'You do not have permission to edit employees');
            $id = intval($_POST['employee_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid employee ID.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_employees SET employee_status = CASE WHEN COALESCE(employee_status, 1) = 1 THEN 0 ELSE 1 END WHERE employee_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Employee status updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.employees.delete', 'You do not have permission to delete employees');
            $id = intval($_POST['employee_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Employee ID is required.']);
                exit;
            }

            if ($id === $employeeId) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'You cannot delete your own account while logged in.']);
                exit;
            }

            try {
                $stmt = $pdo->prepare("DELETE FROM tbl_csdl_employees WHERE employee_id = ?");
                $stmt->execute([$id]);
                if ($stmt->rowCount() === 0) {
                    http_response_code(404);
                    echo json_encode(['success' => false, 'message' => 'Employee not found or already removed.']);
                    exit;
                }
                echo json_encode(['success' => true, 'message' => 'Employee deleted successfully.']);
            } catch (PDOException $e) {
                $msg = $e->getMessage();
                $code = (string) $e->getCode();
                if (
                    $code === '23000'
                    || str_contains($msg, '1451')
                    || str_contains($msg, 'foreign key constraint')
                    || str_contains($msg, 'Cannot delete or update a parent row')
                ) {
                    http_response_code(409);
                    echo json_encode([
                        'success' => false,
                        'message' => 'This employee cannot be deleted because related records still exist in the system. Remove or reassign dependent data first, or deactivate the account instead.',
                    ]);
                    exit;
                }
                throw $e;
            }
            break;

        case 'get_roles':
            RBAC::requireMasterfileRead($employeeId, 'employees', 'You do not have permission to view employees');
            $stmt = $pdo->query("SELECT role_id, role_name FROM tbl_csdl_roles WHERE role_id IN (97, 98, 99, 100, 101) ORDER BY role_id ASC");
            $roles = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'roles' => $roles]);
            break;

        case 'get_campuses':
            RBAC::requireMasterfileRead($employeeId, 'employees', 'You do not have permission to view employees');
            $stmt = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses ORDER BY campus_name ASC");
            $campuses = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'campuses' => $campuses]);
            break;

        case 'import_preview':
        case 'import':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.employees.create', 'You do not have permission to import employees');
            if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_FILES['file'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'No file uploaded.']);
                exit;
            }

            $file = $_FILES['file'];
            $fileExt = strtolower(pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
            $allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
            $allowedExtensions = ['csv', 'xls', 'xlsx'];

            [$uploadValid, $uploadMessage] = UploadSecurity::validateUploadedFile(
                $file,
                $allowedExtensions,
                $allowedTypes,
                5 * 1024 * 1024
            );
            if (!$uploadValid) {
                http_response_code(400);
                if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                    $uploadMessage = 'Invalid file type. Only CSV and Excel files are allowed.';
                }
                echo json_encode(['success' => false, 'message' => $uploadMessage]);
                exit;
            }

            $rows = [];
            $errors = [];

            try {
                $rows = readEmployeeImportRows($file['tmp_name'], $fileExt);
                if ($action === 'import_preview') {
                    echo json_encode([
                        'success' => true,
                        'rows' => array_values(array_slice($rows, 0, 10)),
                        'total' => count($rows),
                    ]);
                    break;
                }

                // Validate and import rows
                $imported = 0;
                $skipped = 0;
                $roleMap = [];
                $campusMap = [];

                // Get role mapping
                $roleStmt = $pdo->query("SELECT role_id, role_name FROM tbl_csdl_roles WHERE role_id IN (97, 98, 99, 100, 101)");
                $roles = $roleStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($roles as $role) {
                    $roleMap[strtolower(trim($role['role_name']))] = $role['role_id'];
                }

                // Get campus mapping
                $campusStmt = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses");
                $campuses = $campusStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($campuses as $campus) {
                    $campusMap[strtolower(trim($campus['campus_name']))] = $campus['campus_id'];
                }

                $pdo->beginTransaction();

                foreach ($rows as $idx => $row) {
                    $schoolId = trim($row['employee_id'] ?? '');
                    $firstName = trim($row['first_name'] ?? '');
                    $lastName = trim($row['last_name'] ?? '');
                    $middleName = trim($row['middle_name'] ?? '');
                    $department = trim($row['department'] ?? '');
                    $email = trim($row['email'] ?? '');
                    $campus = trim($row['campus'] ?? '');
                    $contactNumber = trim($row['contact_number'] ?? '');
                    $dateOfBirth = !empty($row['date_of_birth']) ? trim($row['date_of_birth']) : null;
                    $gender = !empty($row['gender']) ? trim($row['gender']) : null;
                    $status = isset($row['status']) ? (strtolower(trim($row['status'])) === 'active' || trim($row['status']) === '1' ? 1 : 0) : 1;

                    if (empty($schoolId) || empty($firstName) || empty($lastName) || empty($department)) {
                        $errors[] = "Row " . ($idx + 2) . ": Missing required fields (Employee ID, First Name, Last Name, or Department)";
                        $skipped++;
                        continue;
                    }

                    if (!InputValidation::validateSchoolId($schoolId)) {
                        $errors[] = "Row " . ($idx + 2) . ": Invalid Employee ID format: " . $schoolId;
                        $skipped++;
                        continue;
                    }

                    $roleId = $roleMap[strtolower($department)] ?? null;
                    if (!$roleId) {
                        $errors[] = "Row " . ($idx + 2) . ": Invalid Department: " . $department;
                        $skipped++;
                        continue;
                    }

                    $campusId = !empty($campus) ? ($campusMap[strtolower($campus)] ?? null) : null;

                    if (!empty($email) && !InputValidation::validateEmail($email)) {
                        $errors[] = "Row " . ($idx + 2) . ": Invalid email format: " . $email;
                        $skipped++;
                        continue;
                    }

                    if (!empty($contactNumber) && !InputValidation::validatePhone($contactNumber)) {
                        $errors[] = "Row " . ($idx + 2) . ": Invalid contact number format: " . $contactNumber;
                        $skipped++;
                        continue;
                    }

                    // Check if employee already exists
                    $checkStmt = $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_school_id = ? LIMIT 1");
                    $checkStmt->execute([$schoolId]);
                    if ($checkStmt->fetch()) {
                        $errors[] = "Row " . ($idx + 2) . ": Employee ID already exists: " . $schoolId;
                        $skipped++;
                        continue;
                    }

                    // Insert employee
                    $passwordHash = password_hash($schoolId, PASSWORD_DEFAULT);
                    $insertStmt = $pdo->prepare("INSERT INTO tbl_csdl_employees (employee_school_id, employee_role_id, employee_first_name, employee_middle_name, employee_last_name, employee_date_of_birth, employee_gender, employee_contact_number, employee_email, employee_password_hash, employee_campus_id, employee_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                    $insertStmt->execute([
                        $schoolId,
                        $roleId,
                        $firstName,
                        $middleName ?: null,
                        $lastName,
                        $dateOfBirth ?: null,
                        $gender ?: null,
                        $contactNumber ?: null,
                        $email ?: null,
                        $passwordHash,
                        $campusId ?: null,
                        $status
                    ]);
                    $imported++;
                }

                $pdo->commit();

                echo json_encode([
                    'success' => true,
                    'message' => "Import completed. {$imported} employees imported, {$skipped} skipped.",
                    'imported' => $imported,
                    'skipped' => $skipped,
                    'errors' => $errors
                ]);

            } catch (Exception $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Import failed: ' . $e->getMessage()]);
            }
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (PDOException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("API Error in masterfiles-employees.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error occurred.']);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("API Error in masterfiles-employees.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
?>
