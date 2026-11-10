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

function programsDuplicateCodeMessage(): string
{
    return 'Program code already exists. Each program needs a unique code (for example BSN or BSMT). Multiple programs can belong to the same department.';
}

function programsFindDuplicateCode(PDO $pdo, string $code, ?int $excludeId = null): bool
{
    if ($excludeId !== null && $excludeId > 0) {
        $stmt = $pdo->prepare('SELECT program_id FROM tbl_csdl_programs WHERE program_code = ? AND program_id != ? LIMIT 1');
        $stmt->execute([$code, $excludeId]);
    } else {
        $stmt = $pdo->prepare('SELECT program_id FROM tbl_csdl_programs WHERE program_code = ? LIMIT 1');
        $stmt->execute([$code]);
    }
    return (bool) $stmt->fetchColumn();
}

function programsDepartmentExists(PDO $pdo, int $departmentId): bool
{
    if ($departmentId <= 0) {
        return false;
    }
    $stmt = $pdo->prepare('SELECT department_id FROM tbl_csdl_departments WHERE department_id = ? LIMIT 1');
    $stmt->execute([$departmentId]);
    return (bool) $stmt->fetchColumn();
}

function programsRespondDuplicateCode(): void
{
    http_response_code(409);
    echo json_encode(['success' => false, 'message' => programsDuplicateCodeMessage()]);
    exit;
}

function programsHandlePdoError(PDOException $e, string $context): void
{
    $msg = $e->getMessage();
    $code = (string) $e->getCode();
    if ($code === '23000' || str_contains($msg, '1062')) {
        if (str_contains($msg, 'program_code')) {
            programsRespondDuplicateCode();
        }
    }
    if ($code === '23000' || str_contains($msg, '1452')) {
        if (str_contains($msg, 'program_department_id') || str_contains($msg, 'fk_programs_department')) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Selected department was not found. Refresh the page and try again.']);
            exit;
        }
    }
    error_log("API Error in masterfiles-programs.php ({$context}): " . $msg);
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
    exit;
}

function programsNormalizeCsvHeader(string $value): string
{
    $value = preg_replace('/^\xEF\xBB\xBF/', '', trim($value));
    return strtolower((string) preg_replace('/[^a-z0-9]+/i', '', $value));
}

function programsCsvColumn(array $headers, array $aliases): ?int
{
    $normalized = array_map('programsNormalizeCsvHeader', $headers);
    foreach ($aliases as $alias) {
        $index = array_search(programsNormalizeCsvHeader($alias), $normalized, true);
        if ($index !== false) return (int) $index;
    }
    return null;
}

function programsCsvStatus(string $value): ?int
{
    $value = strtolower(trim($value));
    if ($value === '') return null;
    if (in_array($value, ['active', '1', 'yes', 'enabled'], true)) return 1;
    if (in_array($value, ['inactive', '0', 'no', 'disabled'], true)) return 0;
    return -1;
}

$action = $_GET['action'] ?? 'list';
// $pdo is initialized in connection-pdo.php

// Read JSON input for POST requests if $_POST is empty
$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && $input !== null) {
    $_POST = $input;
}

// Enforce CSRF for any state-changing action
$csrfProtectedActions = ['create', 'update', 'toggle', 'delete', 'bulk_delete', 'import'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

try {
    switch ($action) {
        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'programs', 'You do not have permission to view programs');
            $stmt = $pdo->query(
                "SELECT 
                    p.program_id AS id,
                    p.program_code AS code,
                    p.program_name AS name,
                    p.program_department_id AS department_id,
                    d.department_name AS department_name,
                    d.department_code AS department_code,
                    p.program_status AS status,
                    p.program_created_at AS created_at,
                    COALESCE(s.student_count, 0) AS students
                 FROM tbl_csdl_programs p
                 LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id
                 LEFT JOIN (
                     SELECT student_program_id AS prog_id, COUNT(*) AS student_count
                     FROM tbl_csdl_students
                     GROUP BY student_program_id
                 ) s ON s.prog_id = p.program_id
                 ORDER BY p.program_name ASC"
            );
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate counts
            $totalPrograms = count($rows);
            $totalDepartments = (int)$pdo->query("SELECT COUNT(*) FROM tbl_csdl_departments")->fetchColumn();
            $activePrograms = array_reduce($rows, fn($carry, $item) => $carry + ((string)($item['status'] ?? '0') === '1' ? 1 : 0), 0);
            $inactivePrograms = $totalPrograms - $activePrograms;

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'totalPrograms' => $totalPrograms,
                'totalDepartments' => $totalDepartments,
                'activePrograms' => $activePrograms,
                'inactivePrograms' => $inactivePrograms
            ]);
            break;

        case 'import':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.create', 'You do not have permission to import programs');
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.edit', 'You do not have permission to update programs through import');
            if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_FILES['file'])) {
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
            if ($handle === false) throw new RuntimeException('Unable to read the uploaded CSV file.');
            $headers = fgetcsv($handle);
            if ($headers === false) {
                fclose($handle);
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'The CSV file is empty.']);
                exit;
            }

            $codeColumn = programsCsvColumn($headers, ['Code', 'Program Code']);
            $nameColumn = programsCsvColumn($headers, ['Program', 'Program Name', 'Name']);
            $departmentColumn = programsCsvColumn($headers, ['Department', 'Department Code', 'Department Name']);
            $statusColumn = programsCsvColumn($headers, ['Status']);
            if ($codeColumn === null || $nameColumn === null || $departmentColumn === null) {
                fclose($handle);
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid template. Required columns: Code, Program, and Department.']);
                exit;
            }

            $departmentRows = $pdo->query('SELECT department_id, department_code, department_name FROM tbl_csdl_departments')->fetchAll(PDO::FETCH_ASSOC);
            $departmentMap = [];
            foreach ($departmentRows as $department) {
                $departmentId = (int) $department['department_id'];
                $departmentMap[strtolower(trim((string) $department['department_code']))] = $departmentId;
                $departmentMap[strtolower(trim((string) $department['department_name']))] = $departmentId;
                $departmentMap[(string) $departmentId] = $departmentId;
            }

            $findStmt = $pdo->prepare('SELECT program_id, program_status FROM tbl_csdl_programs WHERE program_code = ? LIMIT 1');
            $insertStmt = $pdo->prepare('INSERT INTO tbl_csdl_programs (program_code, program_name, program_department_id, program_status) VALUES (?, ?, ?, ?)');
            $updateWithStatusStmt = $pdo->prepare('UPDATE tbl_csdl_programs SET program_name = ?, program_department_id = ?, program_status = ? WHERE program_id = ?');
            $updateStmt = $pdo->prepare('UPDATE tbl_csdl_programs SET program_name = ?, program_department_id = ? WHERE program_id = ?');
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
                    $departmentValue = strtolower(trim((string) ($row[$departmentColumn] ?? '')));
                    $departmentId = $departmentMap[$departmentValue] ?? 0;
                    $status = $statusColumn === null ? null : programsCsvStatus((string) ($row[$statusColumn] ?? ''));

                    if ($code === '' || $name === '' || $departmentValue === '') {
                        $errors[] = "Row {$lineNumber}: Code, Program, and Department are required.";
                        $skipped++;
                        continue;
                    }
                    if (strlen($code) > 20 || strlen($name) > 100) {
                        $errors[] = "Row {$lineNumber}: Code must be at most 20 characters and Program at most 100 characters.";
                        $skipped++;
                        continue;
                    }
                    if ($departmentId <= 0) {
                        $errors[] = "Row {$lineNumber}: Department '{$row[$departmentColumn]}' was not found. Import departments first or use an existing department code/name.";
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
                            if ($status === null) $updateStmt->execute([$name, $departmentId, (int) $existing['program_id']]);
                            else $updateWithStatusStmt->execute([$name, $departmentId, $status, (int) $existing['program_id']]);
                            $updated++;
                        } else {
                            $insertStmt->execute([$code, $name, $departmentId, $status ?? 1]);
                            $created++;
                        }
                    } catch (PDOException $e) {
                        $errors[] = "Row {$lineNumber}: Unable to import program {$code}.";
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
                'message' => "Import completed. {$created} programs added, {$updated} updated, {$skipped} skipped.",
                'created' => $created,
                'updated' => $updated,
                'skipped' => $skipped,
                'errors' => $errors,
            ]);
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.create', 'You do not have permission to create programs');
            // Accept both legacy and new field names from the frontend
            $code = trim((string)($_POST['program_code'] ?? $_POST['code'] ?? ''));
            $name = trim((string)($_POST['program_name'] ?? $_POST['name'] ?? ''));
            $departmentId = (int)($_POST['program_department_id'] ?? $_POST['department_id'] ?? 0);

            if ($code === '' || $name === '' || $departmentId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Program Code, Name, and Department are required.']);
                exit;
            }

            if (!programsDepartmentExists($pdo, $departmentId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Selected department was not found. Refresh the page and try again.']);
                exit;
            }

            if (programsFindDuplicateCode($pdo, $code)) {
                programsRespondDuplicateCode();
            }

            try {
                $stmt = $pdo->prepare("INSERT INTO tbl_csdl_programs (program_code, program_name, program_department_id) VALUES (?, ?, ?)");
                $stmt->execute([$code, $name, $departmentId]);
            } catch (PDOException $e) {
                programsHandlePdoError($e, 'create');
            }
            echo json_encode(['success' => true, 'message' => 'Program added successfully.']);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.edit', 'You do not have permission to edit programs');
            // Support both `program_id` and generic `id` from the JS payload
            $id = (int)($_POST['program_id'] ?? $_POST['id'] ?? 0);
            $code = trim((string)($_POST['program_code'] ?? $_POST['code'] ?? ''));
            $name = trim((string)($_POST['program_name'] ?? $_POST['name'] ?? ''));
            $departmentId = (int)($_POST['program_department_id'] ?? $_POST['department_id'] ?? 0);

            if ($id <= 0 || $code === '' || $name === '' || $departmentId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Program ID, Code, Name, and Department are required.']);
                exit;
            }

            if (!programsDepartmentExists($pdo, $departmentId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Selected department was not found. Refresh the page and try again.']);
                exit;
            }

            if (programsFindDuplicateCode($pdo, $code, $id)) {
                programsRespondDuplicateCode();
            }

            try {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_programs SET program_code = ?, program_name = ?, program_department_id = ? WHERE program_id = ?");
                $stmt->execute([$code, $name, $departmentId, $id]);
            } catch (PDOException $e) {
                programsHandlePdoError($e, 'update');
            }
            echo json_encode(['success' => true, 'message' => 'Program updated successfully.']);
            break;

        case 'toggle':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.edit', 'You do not have permission to edit programs');
            $id = $_POST['program_id'] ?? $_POST['id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Program ID is required.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_programs SET program_status = (1 - program_status) WHERE program_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Program status updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.delete', 'You do not have permission to delete programs');
            $id = $_POST['program_id'] ?? $_POST['id'] ?? null;
            if (empty($id)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Program ID is required.']);
                exit;
            }

            $studentCountStmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_students WHERE student_program_id = ?');
            $studentCountStmt->execute([$id]);
            if ((int)$studentCountStmt->fetchColumn() > 0) {
                http_response_code(409);
                echo json_encode(['success' => false, 'message' => 'This program is assigned to students and cannot be deleted.']);
                exit;
            }
            $stmt = $pdo->prepare("DELETE FROM tbl_csdl_programs WHERE program_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Program deleted successfully.']);
            break;

        case 'bulk_delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.programs.delete', 'You do not have permission to delete programs');
            $rawIds = $_POST['program_ids'] ?? [];
            if (!is_array($rawIds)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Program IDs must be provided as a list.']);
                exit;
            }
            $ids = array_values(array_unique(array_filter(
                array_map('intval', $rawIds),
                static fn(int $id): bool => $id > 0
            )));
            if (count($ids) === 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select at least one program to delete.']);
                exit;
            }
            if (count($ids) > 100) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'You can delete up to 100 programs at a time.']);
                exit;
            }

            $findStmt = $pdo->prepare('SELECT program_code, program_name FROM tbl_csdl_programs WHERE program_id = ? LIMIT 1');
            $studentCountStmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_students WHERE student_program_id = ?');
            $deleteStmt = $pdo->prepare('DELETE FROM tbl_csdl_programs WHERE program_id = ?');
            $deletedIds = [];
            $failed = [];

            $pdo->beginTransaction();
            try {
                foreach ($ids as $id) {
                    $findStmt->execute([$id]);
                    $program = $findStmt->fetch(PDO::FETCH_ASSOC);
                    if (!$program) {
                        $failed[] = ['program_id' => $id, 'code' => '', 'name' => '', 'reason' => 'Program was not found.'];
                        continue;
                    }

                    $studentCountStmt->execute([$id]);
                    $studentCount = (int)$studentCountStmt->fetchColumn();
                    if ($studentCount > 0) {
                        $failed[] = [
                            'program_id' => $id,
                            'code' => $program['program_code'] ?? '',
                            'name' => $program['program_name'] ?? '',
                            'reason' => "Program is assigned to {$studentCount} student(s)."
                        ];
                        continue;
                    }

                    try {
                        $deleteStmt->execute([$id]);
                        if ($deleteStmt->rowCount() === 1) {
                            $deletedIds[] = $id;
                        } else {
                            $failed[] = [
                                'program_id' => $id,
                                'code' => $program['program_code'] ?? '',
                                'name' => $program['program_name'] ?? '',
                                'reason' => 'Program was not found.'
                            ];
                        }
                    } catch (PDOException $deleteError) {
                        $failed[] = [
                            'program_id' => $id,
                            'code' => $program['program_code'] ?? '',
                            'name' => $program['program_name'] ?? '',
                            'reason' => 'Program is linked to another record.'
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
                'message' => count($deletedIds) . ' program(s) deleted.',
                'deleted_count' => count($deletedIds),
                'deleted_ids' => $deletedIds,
                'failed' => $failed,
            ]);
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (PDOException $e) {
    programsHandlePdoError($e, $action);
} catch (Throwable $e) {
    error_log("API Error in masterfiles-programs.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
?>
