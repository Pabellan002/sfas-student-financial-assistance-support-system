<?php
session_start();
require_once __DIR__ . '/../../../api/includes/includes-rbac.php';
require_once __DIR__ . '/../../../api/config/connection-pdo.php';

error_log("Assessment Loans Security Check:");
error_log("Session user_id: " . ($_SESSION['user_id'] ?? 'NOT SET'));
error_log("Session user_type: " . ($_SESSION['user_type'] ?? 'NOT SET'));
error_log("Session user_role_id: " . ($_SESSION['user_role_id'] ?? 'NOT SET'));

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    error_log("Assessment Loans: Missing user_id or not employee - redirecting to login");
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

// Allow Assessment role (101) OR CSDL Admin (100)
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 101 && $userRoleId != 100) {
    error_log("Assessment Loans: Invalid role_id ($userRoleId) - redirecting to login");
    header('Location: ' . AppPath::url('views/auth/login.html'));
    exit;
}

error_log("Assessment Loans: Access granted for role_id $userRoleId");

RBAC::init($pdo);
$employeeId = (int) $_SESSION['user_id'];

if (!RBAC::hasPermission($employeeId, 'assessment.loans.access')) {
    http_response_code(403);
    echo '<!DOCTYPE html><html><head><title>Access Denied</title></head><body><h1>403 - Access Denied</h1><p>You do not have permission to access this page.</p></body></html>';
    exit;
}

echo RBAC::renderStaffHtml(file_get_contents(__DIR__ . '/../../assessment/assessment-loans-management.html'), $employeeId);
?>
