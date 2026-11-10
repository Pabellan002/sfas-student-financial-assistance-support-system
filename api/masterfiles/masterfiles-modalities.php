<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-rbac.php';

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);
$action = $_GET['action'] ?? 'list';
$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && is_array($input)) $_POST = $input;

function modalityReply(int $status, array $data): void {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

try {
    if ($action === 'list') {
        RBAC::requireMasterfileRead($employeeId, 'modalities', 'You do not have permission to view modalities');
        $rows = $pdo->query('SELECT m.modality_id AS id, m.modality_code AS code, m.modality_name AS name, m.modality_status AS status, COUNT(s.student_id) AS students FROM tbl_csdl_modalities m LEFT JOIN tbl_csdl_students s ON s.student_modality_id = m.modality_id GROUP BY m.modality_id, m.modality_code, m.modality_name, m.modality_status ORDER BY m.modality_id')->fetchAll(PDO::FETCH_ASSOC);
        modalityReply(200, ['success' => true, 'rows' => $rows]);
    }

    if (!in_array($action, ['create', 'update', 'delete'], true) || $_SERVER['REQUEST_METHOD'] !== 'POST') {
        modalityReply(405, ['success' => false, 'message' => 'Unsupported action.']);
    }
    CSRFProtection::validateRequest();
    RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.modalities.' . ($action === 'update' ? 'edit' : $action), 'You do not have permission to change modalities');

    $id = (int)($_POST['modality_id'] ?? 0);
    if ($action === 'delete') {
        if ($id <= 0) modalityReply(400, ['success' => false, 'message' => 'Select a modality.']);
        if ($id === 1) modalityReply(409, ['success' => false, 'message' => 'Flex is the default modality and cannot be deleted.']);
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_students WHERE student_modality_id = ?');
        $stmt->execute([$id]);
        if ((int)$stmt->fetchColumn() > 0) modalityReply(409, ['success' => false, 'message' => 'This modality is assigned to students and cannot be deleted. Deactivate it instead.']);
        $stmt = $pdo->prepare('DELETE FROM tbl_csdl_modalities WHERE modality_id = ?');
        $stmt->execute([$id]);
        modalityReply(200, ['success' => true, 'message' => 'Modality deleted.']);
    }

    $code = strtolower(trim((string)($_POST['modality_code'] ?? '')));
    $name = trim((string)($_POST['modality_name'] ?? ''));
    $status = $action === 'create' ? 1 : (array_key_exists('modality_status', $_POST) ? (!empty($_POST['modality_status']) ? 1 : 0) : null);
    if (!preg_match('/^[a-z][a-z0-9_]{0,31}$/', $code) || $name === '' || mb_strlen($name) > 100) {
        modalityReply(400, ['success' => false, 'message' => 'Enter a valid code and name.']);
    }
    if ($action === 'create') {
        $stmt = $pdo->prepare('INSERT INTO tbl_csdl_modalities (modality_code, modality_name, modality_status) VALUES (?, ?, ?)');
        $stmt->execute([$code, $name, $status]);
        modalityReply(200, ['success' => true, 'message' => 'Modality added.']);
    }
    if ($id <= 0) modalityReply(400, ['success' => false, 'message' => 'Select a modality.']);
    if ($id === 1 && ($status === 0 || $code !== 'flex')) {
        modalityReply(409, ['success' => false, 'message' => 'The default Flex modality must remain active with code flex.']);
    }
    if ($status === 0) {
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_students WHERE student_modality_id = ?');
        $stmt->execute([$id]);
        if ((int)$stmt->fetchColumn() > 0) modalityReply(409, ['success' => false, 'message' => 'This modality is assigned to students and cannot be deactivated.']);
    }
    $stmt = $pdo->prepare('UPDATE tbl_csdl_modalities SET modality_code = ?, modality_name = ?, modality_status = COALESCE(?, modality_status) WHERE modality_id = ?');
    $stmt->execute([$code, $name, $status, $id]);
    modalityReply(200, ['success' => true, 'message' => 'Modality updated.']);
} catch (PDOException $e) {
    error_log('Modality masterfile error: ' . $e->getMessage());
    if ($e->getCode() === '23000') modalityReply(409, ['success' => false, 'message' => 'That modality code already exists or is in use.']);
    modalityReply(500, ['success' => false, 'message' => 'Unable to update modalities.']);
} catch (Throwable $e) {
    error_log('Modality masterfile error: ' . $e->getMessage());
    modalityReply(500, ['success' => false, 'message' => 'Unable to update modalities.']);
}
