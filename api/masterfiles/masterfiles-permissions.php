<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$action = $_GET['action'] ?? '';

// get_my_permissions is accessible by all authenticated users
if ($action !== 'get_my_permissions') {
    // Permission management requires an authenticated employee account.
    if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_role_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied. Employee authentication required.']);
        exit;
    }

    $employeeId = (int) $_SESSION['user_id'];
    RBAC::init($pdo);
    if (!RBAC::hasPermission($employeeId, 'csdl.masterfiles.access')
        || !RBAC::hasPermission($employeeId, 'csdl.masterfiles.employees.access')
        || !RBAC::hasPermission($employeeId, 'csdl.masterfiles.employees.edit')) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied. You do not have permission to manage employee permissions.']);
        exit;
    }
}

try {
    switch ($action) {
        case 'get_employee_permissions':
            getEmployeePermissions($pdo);
            break;
        case 'update_employee_permissions':
            updateEmployeePermissions($pdo);
            break;
        case 'get_all_permissions':
            getAllPermissions($pdo);
            break;
        case 'get_my_permissions':
            getMyPermissions($pdo);
            break;
        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid action']);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server error: ' . $e->getMessage()]);
}

function getEmployeePermissions($pdo) {
    $employeeId = $_GET['employee_id'] ?? null;
    
    if (!$employeeId) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Employee ID required']);
        return;
    }
    
    // Get employee info
    $stmt = $pdo->prepare("
        SELECT e.employee_id, e.employee_role_id, 
               CONCAT(e.employee_first_name, ' ', e.employee_last_name) as full_name,
               r.role_name
        FROM tbl_csdl_employees e
        JOIN tbl_csdl_roles r ON e.employee_role_id = r.role_id
        WHERE e.employee_id = ?
    ");
    $stmt->execute([$employeeId]);
    $employee = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if (!$employee) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Employee not found']);
        return;
    }
    
    // Get all permissions with role defaults and employee overrides
    $stmt = $pdo->prepare("
        SELECT 
            p.permission_id,
            p.permission_name,
            p.permission_key,
            p.permission_type,
            p.permission_module,
            p.permission_description,
            CASE 
                WHEN ep.employee_permission_id IS NOT NULL THEN ep.is_granted
                WHEN rp.role_permission_id IS NOT NULL THEN 1
                ELSE 0
            END as is_granted,
            CASE 
                WHEN ep.employee_permission_id IS NOT NULL THEN 'employee'
                WHEN rp.role_permission_id IS NOT NULL THEN 'role'
                ELSE 'default'
            END as grant_source
        FROM tbl_csdl_permissions p
        LEFT JOIN tbl_csdl_role_permissions rp ON p.permission_id = rp.permission_id AND rp.role_id = ?
        LEFT JOIN tbl_csdl_employee_permissions ep ON p.permission_id = ep.permission_id AND ep.employee_id = ?
        ORDER BY p.permission_module, p.permission_type, p.permission_name
    ");
    $stmt->execute([$employee['employee_role_id'], $employeeId]);
    $permissions = $stmt->fetchAll(PDO::FETCH_ASSOC);
    applyMasterfilesManageInheritance($permissions);
    
    echo json_encode([
        'success' => true,
        'employee' => $employee,
        'permissions' => $permissions
    ]);
}

function updateEmployeePermissions($pdo) {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'message' => 'Method not allowed']);
        return;
    }

    // Parse JSON first so CSRF token in JSON body is available to validator
    $rawBody = file_get_contents('php://input');
    $input = [];
    if (!empty($rawBody)) {
        $decoded = json_decode($rawBody, true);
        if (is_array($decoded)) {
            $input = $decoded;
            if (!isset($_POST['csrf_token']) && isset($input['csrf_token'])) {
                $_POST['csrf_token'] = $input['csrf_token'];
            }
        }
    }

    CSRFProtection::validateRequest();

    // Fallback to form payload if JSON body is empty
    if (empty($input) && !empty($_POST)) {
        $input = $_POST;
    }

    $employeeId = $input['employee_id'] ?? null;
    $permissions = $input['permissions'] ?? [];
    
    if (!$employeeId || !is_array($permissions)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid input']);
        return;
    }
    
    $employeeStmt = $pdo->prepare('SELECT employee_role_id FROM tbl_csdl_employees WHERE employee_id = ? LIMIT 1');
    $employeeStmt->execute([$employeeId]);
    $targetRoleId = $employeeStmt->fetchColumn();
    if ($targetRoleId === false) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Employee not found']);
        return;
    }

    $availableStmt = $pdo->prepare("SELECT p.permission_id, p.permission_key,
            CASE WHEN rp.role_permission_id IS NOT NULL THEN 1 ELSE 0 END AS role_granted,
            ep.is_granted AS employee_override
        FROM tbl_csdl_permissions p
        LEFT JOIN tbl_csdl_role_permissions rp ON rp.role_id = ? AND rp.permission_id = p.permission_id
        LEFT JOIN tbl_csdl_employee_permissions ep ON ep.employee_id = ? AND ep.permission_id = p.permission_id");
    $availableStmt->execute([(int) $targetRoleId, (int) $employeeId]);
    $available = [];
    $managePermissionId = null;
    foreach ($availableStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $id = (int) $row['permission_id'];
        $available[$id] = $row;
        if ($row['permission_key'] === 'csdl.masterfiles.manage') $managePermissionId = $id;
    }

    $requested = [];
    foreach ($permissions as $permission) {
        $id = filter_var($permission['permission_id'] ?? null, FILTER_VALIDATE_INT);
        $grant = $permission['is_granted'] ?? null;
        if (!$id || !isset($available[$id]) || !in_array((string) $grant, ['0', '1'], true) || isset($requested[$id])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid permission selection']);
            return;
        }
        $requested[$id] = (int) $grant;
    }

    $manageGranted = false;
    if ($managePermissionId !== null) {
        $manageRow = $available[$managePermissionId];
        $manageGranted = (bool) ($requested[$managePermissionId]
            ?? ($manageRow['employee_override'] !== null
                ? (int) $manageRow['employee_override']
                : (int) $manageRow['role_granted']));
    }

    $pdo->beginTransaction();
    try {
        $grantedBy = $_SESSION['user_id'];
        $deleteStmt = $pdo->prepare('DELETE FROM tbl_csdl_employee_permissions WHERE employee_id = ? AND permission_id = ?');
        $insertStmt = $pdo->prepare("
            INSERT INTO tbl_csdl_employee_permissions 
            (employee_id, permission_id, is_granted, granted_by) 
            VALUES (?, ?, ?, ?)
        ");
        foreach ($requested as $permissionId => $isGranted) {
            $permission = $available[$permissionId];
            $baseline = (int) $permission['role_granted'];
            $key = (string) $permission['permission_key'];
            if (!$baseline && $manageGranted && str_starts_with($key, 'csdl.masterfiles.')
                && !in_array($key, ['csdl.masterfiles.access', 'csdl.masterfiles.manage'], true)) {
                $baseline = 1;
            }
            $deleteStmt->execute([$employeeId, $permissionId]);
            if ($isGranted !== $baseline) {
                $insertStmt->execute([$employeeId, $permissionId, $isGranted, $grantedBy]);
            }
        }
        
        // Log the change
        $auditStmt = $pdo->prepare("
            INSERT INTO tbl_csdl_audit_log 
            (audit_log_employee_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
            VALUES (?, 'UPDATE_PERMISSIONS', 1, ?, ?, ?)
        ");
        $auditStmt->execute([
            $grantedBy,
            "Updated permissions for employee ID: $employeeId",
            $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0',
            $_SERVER['HTTP_USER_AGENT'] ?? ''
        ]);
        
        $pdo->commit();
        
        echo json_encode([
            'success' => true,
            'message' => 'Permissions updated successfully'
        ]);
        
    } catch (Exception $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function getAllPermissions($pdo) {
    $stmt = $pdo->query("
        SELECT permission_id, permission_name, permission_key, permission_type, 
               permission_module, permission_description
        FROM tbl_csdl_permissions
        ORDER BY permission_module, permission_type, permission_name
    ");
    $permissions = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode([
        'success' => true,
        'permissions' => $permissions
    ]);
}

function getMyPermissions($pdo) {
    // This endpoint is accessible by all authenticated users (not just CSDL Admin)
    // Remove the role check at the top for this specific action
    
    if (!isset($_SESSION['user_id'])) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Not authenticated']);
        return;
    }
    if (($_SESSION['user_type'] ?? '') !== 'employee') {
        echo json_encode(['success' => true, 'permissions' => []]);
        return;
    }
    
    $employeeId = $_SESSION['user_id'];
    
    // Get employee permissions
    $stmt = $pdo->prepare("
        SELECT 
            p.permission_id,
            p.permission_name,
            p.permission_key,
            p.permission_type,
            p.permission_module,
            CASE 
                WHEN ep.employee_permission_id IS NOT NULL THEN ep.is_granted
                WHEN rp.role_permission_id IS NOT NULL THEN 1
                ELSE 0
            END as is_granted,
            CASE
                WHEN ep.employee_permission_id IS NOT NULL THEN 'employee'
                WHEN rp.role_permission_id IS NOT NULL THEN 'role'
                ELSE 'default'
            END as grant_source
        FROM tbl_csdl_employees e
        CROSS JOIN tbl_csdl_permissions p
        LEFT JOIN tbl_csdl_role_permissions rp ON rp.role_id = e.employee_role_id AND rp.permission_id = p.permission_id
        LEFT JOIN tbl_csdl_employee_permissions ep ON ep.employee_id = e.employee_id AND ep.permission_id = p.permission_id
        WHERE e.employee_id = ?
        ORDER BY p.permission_module, p.permission_type, p.permission_name
    ");
    $stmt->execute([$employeeId]);
    $permissions = $stmt->fetchAll(PDO::FETCH_ASSOC);
    applyMasterfilesManageInheritance($permissions);
    
    echo json_encode([
        'success' => true,
        'permissions' => $permissions
    ]);
}

/**
 * The existing CSDL Manage Masterfiles grant is the full CRUD grant for every
 * masterfile. Show granular permissions as inherited from it, while preserving
 * any explicit employee-level grant or denial.
 */
function applyMasterfilesManageInheritance(array &$permissions): void {
    $hasManage = false;
    foreach ($permissions as $permission) {
        if (($permission['permission_key'] ?? '') === 'csdl.masterfiles.manage' && !empty($permission['is_granted'])) {
            $hasManage = true;
            break;
        }
    }

    if (!$hasManage) {
        return;
    }

    foreach ($permissions as &$permission) {
        $key = (string) ($permission['permission_key'] ?? '');
        $isGranularMasterfilePermission = str_starts_with($key, 'csdl.masterfiles.')
            && !in_array($key, ['csdl.masterfiles.access', 'csdl.masterfiles.manage'], true);
        if ($isGranularMasterfilePermission && ($permission['grant_source'] ?? 'default') === 'default') {
            $permission['is_granted'] = 1;
            $permission['grant_source'] = 'manage';
        }
    }
    unset($permission);
}
?>
