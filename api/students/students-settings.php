<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$studentId = (int) $_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $action = $_GET['action'] ?? 'profile';
    
    if ($action === 'profile') {
        try {
            $stmt = $pdo->prepare("SELECT 
                s.student_id,
                s.student_school_id,
                s.student_first_name,
                s.student_middle_name,
                s.student_last_name,
                s.student_date_of_birth,
                s.student_gender,
                s.student_contact_number,
                s.student_email,
                s.student_personal_email,
                s.student_fb_account,
                s.student_profile_image
            FROM tbl_csdl_students s
            WHERE s.student_id = ?");
            $stmt->execute([$studentId]);
            $profile = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$profile) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Profile not found']);
                return;
            }
            
            echo json_encode(['success' => true, 'profile' => $profile]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Settings profile error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching profile']);
        }
    } elseif ($action === 'audit_logs') {
        try {
            // Pagination parameters
            $page = max(1, (int)($_GET['page'] ?? 1));
            $limit = min(50, max(10, (int)($_GET['limit'] ?? 20)));
            $offset = ($page - 1) * $limit;
            
            // Get total count
            $countStmt = $pdo->prepare("SELECT COUNT(*) as total FROM tbl_csdl_audit_log WHERE audit_log_student_id = ?");
            $countStmt->execute([$studentId]);
            $totalRecords = (int)$countStmt->fetch(PDO::FETCH_ASSOC)['total'];
            
            // Get audit logs for this student
            $stmt = $pdo->prepare("SELECT 
                audit_log_id,
                audit_log_action,
                audit_log_records,
                audit_log_details,
                audit_log_ip_address,
                audit_log_user_agent,
                audit_log_created_at
            FROM tbl_csdl_audit_log
            WHERE audit_log_student_id = ?
            ORDER BY audit_log_created_at DESC
            LIMIT ? OFFSET ?");
            $stmt->execute([$studentId, $limit, $offset]);
            $logs = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'logs' => $logs,
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $totalRecords,
                    'pages' => ceil($totalRecords / $limit)
                ]
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Audit logs error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching audit logs']);
        }
    }
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
exit;
?>


