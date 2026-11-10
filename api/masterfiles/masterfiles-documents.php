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

if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, ['create', 'update', 'toggle', 'delete'], true)) {
    CSRFProtection::validateRequest();
}

try {
    switch ($action) {
        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'documents', 'You do not have permission to view document types');
            $rows = $pdo->query("SELECT doc_type_id AS id, doc_type_name AS name, doc_type_description AS description, doc_type_is_required AS is_required, doc_type_status AS status FROM tbl_csdl_document_types ORDER BY doc_type_name ASC")->fetchAll(PDO::FETCH_ASSOC);
            $active = count(array_filter($rows, fn($row) => (int)$row['status'] === 1));
            echo json_encode(['success' => true, 'rows' => $rows, 'total' => count($rows), 'active' => $active, 'inactive' => count($rows) - $active]);
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.documents.create', 'You do not have permission to add document types');
            $name = trim($_POST['doc_type_name'] ?? '');
            $description = trim($_POST['doc_type_description'] ?? '');
            $required = !empty($_POST['doc_type_is_required']) ? 1 : 0;
            if ($name === '') throw new InvalidArgumentException('Document type name is required.');
            $stmt = $pdo->prepare('INSERT INTO tbl_csdl_document_types (doc_type_name, doc_type_description, doc_type_is_required, doc_type_status) VALUES (?, ?, ?, 1)');
            $stmt->execute([$name, $description ?: null, $required]);
            echo json_encode(['success' => true, 'message' => 'Document type added successfully.']);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.documents.edit', 'You do not have permission to edit document types');
            $id = (int)($_POST['doc_type_id'] ?? 0);
            $name = trim($_POST['doc_type_name'] ?? '');
            $description = trim($_POST['doc_type_description'] ?? '');
            $required = !empty($_POST['doc_type_is_required']) ? 1 : 0;
            if ($id < 1 || $name === '') throw new InvalidArgumentException('Document type name is required.');
            $stmt = $pdo->prepare('UPDATE tbl_csdl_document_types SET doc_type_name = ?, doc_type_description = ?, doc_type_is_required = ? WHERE doc_type_id = ?');
            $stmt->execute([$name, $description ?: null, $required, $id]);
            echo json_encode(['success' => true, 'message' => 'Document type updated successfully.']);
            break;

        case 'toggle':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.documents.edit', 'You do not have permission to change document type status');
            $id = (int)($_POST['doc_type_id'] ?? 0);
            if ($id < 1) throw new InvalidArgumentException('Document type is required.');
            $pdo->prepare('UPDATE tbl_csdl_document_types SET doc_type_status = 1 - doc_type_status WHERE doc_type_id = ?')->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Document type status updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.documents.delete', 'You do not have permission to delete document types');
            $id = (int)($_POST['doc_type_id'] ?? 0);
            if ($id < 1) throw new InvalidArgumentException('Document type is required.');
            $used = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loan_documents WHERE loan_document_doc_type_id = ?');
            $used->execute([$id]);
            if ((int)$used->fetchColumn() > 0) {
                http_response_code(409);
                echo json_encode(['success' => false, 'message' => 'This document type is already used by a loan application. Deactivate it instead.']);
                break;
            }
            $pdo->prepare('DELETE FROM tbl_csdl_document_types WHERE doc_type_id = ?')->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Document type deleted successfully.']);
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action.']);
    }
} catch (InvalidArgumentException $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('Document types API error: ' . $e->getMessage());
    http_response_code(500);
    $message = str_contains($e->getMessage(), 'doc_type_status')
        ? 'Document type status is not configured yet. Run the database update first.'
        : 'An unexpected error occurred.';
    echo json_encode(['success' => false, 'message' => $message]);
}
