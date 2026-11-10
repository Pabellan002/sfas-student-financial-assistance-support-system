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

$action = $_GET['action'] ?? 'list';

// Read JSON input for POST requests if $_POST is empty
$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && $input !== null) {
    $_POST = $input;
}

// Enforce CSRF for any state-changing action
$csrfProtectedActions = ['create', 'update', 'toggle', 'delete', 'import'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

function scholarshipsCsvColumn(array $headers, array $aliases): ?int
{
    $normalized = array_map(static function ($header) {
        $header = preg_replace('/^\xEF\xBB\xBF/', '', trim((string) $header));
        return strtolower((string) preg_replace('/[^a-z0-9]+/i', '', $header));
    }, $headers);
    foreach ($aliases as $alias) {
        $index = array_search(strtolower((string) preg_replace('/[^a-z0-9]+/i', '', $alias)), $normalized, true);
        if ($index !== false) return (int) $index;
    }
    return null;
}

function scholarshipsCsvStatus(string $value): ?int
{
    $value = strtolower(trim($value));
    if ($value === '') return null;
    if (in_array($value, ['active', '1', 'yes'], true)) return 1;
    if (in_array($value, ['inactive', '0', 'no'], true)) return 0;
    return -1;
}

try {
    switch ($action) {
        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'scholarships', 'You do not have permission to view scholarships');
            $stmt = $pdo->query(
                "SELECT 
                    s.scholarship_id AS id,
                    s.scholarship_code AS code,
                    s.scholarship_name AS name,
                    s.scholarship_description AS description,
                    s.scholarship_percentage AS percentage,
                    s.scholarship_type AS type,
                    s.scholarship_status AS status,
                    COALESCE(st.student_count, 0) AS students
                 FROM tbl_csdl_scholarships s
                 LEFT JOIN (
                    SELECT assigned.scholarship_id AS schol_id, COUNT(DISTINCT assigned.student_id) AS student_count
                    FROM (
                        SELECT student_id, student_scholarship_id AS scholarship_id
                        FROM tbl_csdl_students
                        WHERE student_scholarship_id IS NOT NULL
                        UNION ALL
                        SELECT student_id, scholarship_id
                        FROM tbl_csdl_student_scholarships
                    ) assigned
                    GROUP BY assigned.scholarship_id
                 ) st ON st.schol_id = s.scholarship_id
                 ORDER BY s.scholarship_name ASC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate counts
            $totalScholarships = count($rows);
            $activeScholarships = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['status'] ?? '0') === '1' ? 1 : 0), 0);
            $inactiveScholarships = $totalScholarships - $activeScholarships;

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'totalScholarships' => $totalScholarships,
                'activeScholarships' => $activeScholarships,
                'inactiveScholarships' => $inactiveScholarships
            ]);
            break;

        case 'import':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.scholarships.create', 'You do not have permission to import scholarships');
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.scholarships.edit', 'You do not have permission to update scholarships through import');
            if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_FILES['file'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select a CSV file to import.']);
                break;
            }
            [$validUpload, $uploadMessage] = UploadSecurity::validateUploadedFile(
                $_FILES['file'], ['csv'],
                ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'],
                5 * 1024 * 1024
            );
            if (!$validUpload) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => $uploadMessage === 'Invalid file extension.' ? 'Only CSV files can be imported.' : $uploadMessage]);
                break;
            }

            $handle = fopen($_FILES['file']['tmp_name'], 'r');
            if ($handle === false) throw new RuntimeException('Unable to read the uploaded CSV file.');
            try {
                $headers = fgetcsv($handle);
                if ($headers === false) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'The CSV file is empty.']);
                    break;
                }
                $codeColumn = scholarshipsCsvColumn($headers, ['Code', 'Scholarship Code']);
                $nameColumn = scholarshipsCsvColumn($headers, ['Scholarship', 'Scholarship Name', 'Name']);
                $typeColumn = scholarshipsCsvColumn($headers, ['Type', 'Scholarship Type']);
                $descriptionColumn = scholarshipsCsvColumn($headers, ['Description', 'Scholarship Description']);
                $percentageColumn = scholarshipsCsvColumn($headers, ['Percentage', 'Scholarship Percentage']);
                $statusColumn = scholarshipsCsvColumn($headers, ['Status']);
                if ($codeColumn === null || $nameColumn === null) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid template. Required columns: Code and Scholarship.']);
                    break;
                }

                $find = $pdo->prepare('SELECT scholarship_id, scholarship_type FROM tbl_csdl_scholarships WHERE scholarship_code = ? LIMIT 1');
                $insert = $pdo->prepare('INSERT INTO tbl_csdl_scholarships (scholarship_code, scholarship_name, scholarship_description, scholarship_percentage, scholarship_type, scholarship_status) VALUES (?, ?, ?, ?, ?, ?)');
                $update = $pdo->prepare('UPDATE tbl_csdl_scholarships SET scholarship_name = ?, scholarship_description = COALESCE(?, scholarship_description), scholarship_percentage = COALESCE(?, scholarship_percentage), scholarship_type = COALESCE(?, scholarship_type), scholarship_status = COALESCE(?, scholarship_status) WHERE scholarship_id = ?');
                $moveExternal = $pdo->prepare('INSERT IGNORE INTO tbl_csdl_student_scholarships (student_id, scholarship_id) SELECT student_id, ? FROM tbl_csdl_students WHERE student_scholarship_id = ?');
                $clearPrimary = $pdo->prepare('UPDATE tbl_csdl_students SET student_scholarship_id = NULL WHERE student_scholarship_id = ?');
                $created = 0;
                $updated = 0;
                $skipped = 0;
                $errors = [];
                $seenCodes = [];
                $line = 1;
                $pdo->beginTransaction();
                while (($row = fgetcsv($handle)) !== false) {
                    $line++;
                    if (!array_filter($row, static fn($value) => trim((string) $value) !== '')) continue;
                    $code = trim((string) ($row[$codeColumn] ?? ''));
                    $name = trim((string) ($row[$nameColumn] ?? ''));
                    $typeRaw = $typeColumn === null ? '' : trim((string) ($row[$typeColumn] ?? ''));
                    $type = $typeRaw === '' ? null : ucfirst(strtolower($typeRaw));
                    $description = $descriptionColumn === null ? null : trim((string) ($row[$descriptionColumn] ?? ''));
                    $percentageRaw = $percentageColumn === null ? '' : trim((string) ($row[$percentageColumn] ?? ''));
                    $percentage = $percentageRaw === '' ? null : rtrim($percentageRaw, '%');
                    $status = $statusColumn === null ? null : scholarshipsCsvStatus((string) ($row[$statusColumn] ?? ''));
                    $reason = null;
                    if ($code === '' || $name === '') $reason = 'Code and Scholarship are required.';
                    elseif (strlen($code) > 20 || strlen($name) > 100) $reason = 'Code must be at most 20 characters and Scholarship at most 100 characters.';
                    elseif ($description !== null && strlen($description) > 65535) $reason = 'Description is too long.';
                    elseif ($type !== null && !in_array($type, ['Internal', 'External'], true)) $reason = 'Type must be Internal or External.';
                    elseif ($percentage !== null && (!preg_match('/^\d{1,3}(?:\.\d{1,2})?$/', $percentage) || (float) $percentage > 100)) $reason = 'Percentage must be between 0 and 100 with up to two decimal places.';
                    elseif ($status === -1) $reason = 'Status must be Active or Inactive.';
                    elseif (isset($seenCodes[strtolower($code)])) $reason = 'Code appears more than once in the file.';
                    if ($reason !== null) {
                        $skipped++;
                        if (count($errors) < 30) $errors[] = "Row {$line}: {$reason}";
                        continue;
                    }
                    $seenCodes[strtolower($code)] = true;
                    $find->execute([$code]);
                    $existing = $find->fetch(PDO::FETCH_ASSOC);
                    if ($existing) {
                        $id = (int) $existing['scholarship_id'];
                        $update->execute([$name, $description, $percentage, $type, $status, $id]);
                        if ($type === 'External' && $existing['scholarship_type'] !== 'External') {
                            $moveExternal->execute([$id, $id]);
                            $clearPrimary->execute([$id]);
                        }
                        $updated++;
                    } else {
                        $insert->execute([$code, $name, $description, $percentage ?? '0.00', $type ?? 'Internal', $status ?? 1]);
                        $created++;
                    }
                }
                $pdo->commit();
                echo json_encode(['success' => true, 'message' => "Import completed. {$created} added, {$updated} updated, {$skipped} skipped.", 'created' => $created, 'updated' => $updated, 'skipped' => $skipped, 'errors' => $errors]);
            } finally {
                fclose($handle);
            }
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.scholarships.create', 'You do not have permission to create scholarships');
            $code = $_POST['scholarship_code'] ?? '';
            $name = $_POST['scholarship_name'] ?? '';
            $description = $_POST['scholarship_description'] ?? '';
            $percentage = $_POST['scholarship_percentage'] ?? 0.00;
            $type = ucfirst(strtolower(trim((string)($_POST['scholarship_type'] ?? 'Internal'))));
            if (!in_array($type, ['Internal', 'External'], true)) $type = 'Internal';

            if (empty($code) || empty($name)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Scholarship Code and Name are required.']);
                exit;
            }

            $stmt = $pdo->prepare("INSERT INTO tbl_csdl_scholarships (scholarship_code, scholarship_name, scholarship_description, scholarship_percentage, scholarship_type) VALUES (?, ?, ?, ?, ?)");
            $stmt->execute([$code, $name, $description, $percentage, $type]);
            echo json_encode(['success' => true, 'message' => 'Scholarship added successfully.']);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.scholarships.edit', 'You do not have permission to edit scholarships');
            $id = $_POST['scholarship_id'] ?? null;
            $code = $_POST['scholarship_code'] ?? '';
            $name = $_POST['scholarship_name'] ?? '';
            $description = $_POST['scholarship_description'] ?? '';
            $percentage = $_POST['scholarship_percentage'] ?? 0.00;
            $type = ucfirst(strtolower(trim((string)($_POST['scholarship_type'] ?? 'Internal'))));
            if (!in_array($type, ['Internal', 'External'], true)) $type = 'Internal';

            if (empty($id) || empty($code) || empty($name)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Scholarship ID, Code, and Name are required.']);
                exit;
            }

            $pdo->beginTransaction();
            $stmt = $pdo->prepare("UPDATE tbl_csdl_scholarships SET scholarship_code = ?, scholarship_name = ?, scholarship_description = ?, scholarship_percentage = ?, scholarship_type = ? WHERE scholarship_id = ?");
            $stmt->execute([$code, $name, $description, $percentage, $type, $id]);
            if ($type === 'External') {
                $pdo->prepare("INSERT IGNORE INTO tbl_csdl_student_scholarships (student_id, scholarship_id) SELECT student_id, ? FROM tbl_csdl_students WHERE student_scholarship_id = ?")->execute([$id, $id]);
                $pdo->prepare("UPDATE tbl_csdl_students SET student_scholarship_id = NULL WHERE student_scholarship_id = ?")->execute([$id]);
            }
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Scholarship updated successfully.']);
            break;

        case 'toggle':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.scholarships.edit', 'You do not have permission to edit scholarships');
            $id = $_POST['scholarship_id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Scholarship ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_scholarships SET scholarship_status = (1 - scholarship_status) WHERE scholarship_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Scholarship status updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.scholarships.delete', 'You do not have permission to delete scholarships');
            $id = $_POST['scholarship_id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Scholarship ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("DELETE FROM tbl_csdl_scholarships WHERE scholarship_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Scholarship deleted successfully.']);
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log("API Error in masterfiles-scholarships.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
?>
