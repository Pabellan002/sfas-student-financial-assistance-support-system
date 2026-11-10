<?php
if (($_GET['action'] ?? '') === 'audit-logs' && ($_GET['export'] ?? '') === 'csv') ob_start();
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-rate-limit.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../../vendor/autoload.php';
require_once __DIR__ . '/../includes/includes-email-templates.php';
require_once __DIR__ . '/../includes/includes-email-mailer.php';

use Symfony\Component\Mime\Email;
use Symfony\Component\Mailer\Exception\TransportExceptionInterface;

header('Content-Type: application/json');

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';

    if ($action === 'email-templates') {
        if (($_SESSION['user_type'] ?? '') !== 'employee' || (int) ($_SESSION['user_role_id'] ?? 0) !== 100) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'CSDL access required.']);
            return;
        }
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to edit email templates');
        try {
            $overrides = [];
            $stmt = $pdo->query("SELECT setting_key, setting_value FROM tbl_csdl_settings WHERE LEFT(setting_key, 15) = 'email_template_'");
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $data = json_decode((string) $row['setting_value'], true);
                if (is_array($data) && isset($data['subject'], $data['body'])) {
                    $overrides[$row['setting_key']] = $data;
                }
            }
            $catalog = [];
            foreach (EmailTemplates::editableOffices() as $role => $label) {
                $templates = [];
                foreach (EmailTemplates::editableTypes($role) as $type => $typeLabel) {
                    $key = EmailTemplates::editableKey($role, $type);
                    $templates[] = ['type' => $type, 'label' => $typeLabel,
                        'defaults' => EmailTemplates::editableDefaults($type),
                        'override' => $overrides[$key] ?? null];
                }
                $catalog[] = ['role' => $role, 'label' => $label, 'templates' => $templates];
            }
            echo json_encode(['success' => true, 'offices' => $catalog], JSON_UNESCAPED_UNICODE);
        } catch (Throwable $e) {
            error_log('Email template listing error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Could not load email templates.']);
        }
        return;
    }
    
    if ($action === 'list') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to view settings');
        try {
            $stmt = $pdo->query("SELECT setting_key, setting_value, setting_description FROM tbl_csdl_settings ORDER BY setting_key");
            $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Convert to key-value pairs for easier access
            $settingsMap = [];
            foreach ($settings as $setting) {
                $settingsMap[$setting['setting_key']] = [
                    'value' => $setting['setting_value'],
                    'description' => $setting['setting_description']
                ];
            }
            
            echo json_encode(['success' => true, 'settings' => $settingsMap]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('CSDL settings list error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching settings. Please try again.']);
        }
        return;
    }
    
    if ($action === 'get-profile') {
        if (!isset($_SESSION['user_id']) || $_SESSION['user_type'] !== 'employee') {
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Unauthorized']);
            return;
        }
        
        try {
            $employeeId = $_SESSION['user_id'];
            $stmt = $pdo->prepare("SELECT 
                employee_id,
                employee_school_id,
                employee_first_name,
                employee_middle_name,
                employee_last_name,
                employee_date_of_birth,
                employee_gender,
                employee_contact_number,
                employee_email,
                employee_profile_image
            FROM tbl_csdl_employees 
            WHERE employee_id = ?");
            $stmt->execute([$employeeId]);
            $employee = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if ($employee) {
                echo json_encode(['success' => true, 'employee' => $employee]);
            } else {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Employee not found']);
            }
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('CSDL settings profile error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching profile. Please try again.']);
        }
        return;
    }
    
    if ($action === 'application-periods') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to view application periods');
        try {
            $stmt = $pdo->query("SELECT app_period_id, app_period_name, app_period_status FROM tbl_csdl_application_periods ORDER BY app_period_id");
            $periods = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode(['success' => true, 'periods' => $periods]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('CSDL application periods error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching application periods. Please try again.']);
        }
        return;
    }

    if ($action === 'exam-schedules') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to view exam schedules');
        try {
            $schoolYearsStmt = $pdo->query("SELECT sy_id, sy_code, sy_status FROM tbl_csdl_school_years ORDER BY sy_code DESC");
            $schoolYears = $schoolYearsStmt->fetchAll(PDO::FETCH_ASSOC);

            $periodsStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_id");
            $periods = $periodsStmt->fetchAll(PDO::FETCH_ASSOC);

            $schedules = [];
            try {
                $schedulesStmt = $pdo->query("SELECT 
                        es.exam_schedule_id,
                        es.exam_sy_id,
                        es.exam_period_id,
                        es.exam_start_date,
                        es.exam_end_date,
                        es.exam_status,
                        sy.sy_code,
                        ap.app_period_name
                    FROM tbl_csdl_exam_schedules es
                    INNER JOIN tbl_csdl_school_years sy ON sy.sy_id = es.exam_sy_id
                    INNER JOIN tbl_csdl_application_periods ap ON ap.app_period_id = es.exam_period_id
                    ORDER BY es.exam_start_date DESC, es.exam_schedule_id DESC");
                $schedules = $schedulesStmt->fetchAll(PDO::FETCH_ASSOC);
            } catch (PDOException $e) {
                if (strpos($e->getMessage(), 'tbl_csdl_exam_schedules') === false) {
                    throw $e;
                }
            }

            echo json_encode([
                'success' => true,
                'schedules' => $schedules,
                'schoolYears' => $schoolYears,
                'periods' => $periods
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('CSDL exam schedules error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching exam schedules. Please try again.']);
        }
        return;
    }
    
    if ($action === 'audit-actions') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to view audit logs');
        try {
            $actions = $pdo->query('SELECT DISTINCT audit_log_action FROM tbl_csdl_audit_log ORDER BY audit_log_action')
                ->fetchAll(PDO::FETCH_COLUMN);
            echo json_encode(['success' => true, 'actions' => $actions]);
        } catch (Throwable $e) {
            error_log('Audit action listing error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Could not load audit actions.']);
        }
        return;
    }

    if ($action === 'audit-logs') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to view audit logs');
        try {
            $actionFilter = $_GET['actionFilter'] ?? '';
            $userTypeFilter = $_GET['userTypeFilter'] ?? '';
            $dateFrom = $_GET['dateFrom'] ?? '';
            $dateTo = $_GET['dateTo'] ?? '';
            $search = trim($_GET['search'] ?? '');
            $isExport = ($_GET['export'] ?? '') === '1';
            $isCsvExport = ($_GET['export'] ?? '') === 'csv';
            
            $whereConditions = [];
            $params = [];
            
            if ($actionFilter) {
                $whereConditions[] = "al.audit_log_action = :action";
                $params[':action'] = $actionFilter;
            }
            
            if ($userTypeFilter === 'employee') {
                $whereConditions[] = "al.audit_log_employee_id IS NOT NULL";
            } elseif ($userTypeFilter === 'student') {
                $whereConditions[] = "al.audit_log_student_id IS NOT NULL";
            }
            
            if ($dateFrom) {
                $whereConditions[] = "al.audit_log_created_at >= :dateFrom";
                $params[':dateFrom'] = $dateFrom;
            }
            
            if ($dateTo) {
                $whereConditions[] = "al.audit_log_created_at < DATE_ADD(:dateTo, INTERVAL 1 DAY)";
                $params[':dateTo'] = $dateTo;
            }

            if ($search !== '') {
                $whereConditions[] = "LOWER(CONCAT_WS(' ', e.employee_first_name, e.employee_last_name, s.student_first_name, s.student_last_name, al.audit_log_action, al.audit_log_details)) LIKE :search";
                $params[':search'] = '%' . strtolower($search) . '%';
            }
            
            $whereClause = !empty($whereConditions) ? 'WHERE ' . implode(' AND ', $whereConditions) : '';

            $selectSql = "SELECT 
                        al.audit_log_id,
                        al.audit_log_employee_id,
                        al.audit_log_student_id,
                        al.audit_log_action,
                        al.audit_log_records,
                        al.audit_log_details,
                        al.audit_log_ip_address,
                        al.audit_log_user_agent,
                        al.audit_log_created_at,
                        CASE 
                            WHEN al.audit_log_employee_id IS NOT NULL THEN CONCAT(e.employee_first_name, ' ', e.employee_last_name, ' (Employee)')
                            WHEN al.audit_log_student_id IS NOT NULL THEN CONCAT(s.student_first_name, ' ', s.student_last_name, ' (Student)')
                            ELSE 'System'
                        END as user_name,
                        CASE 
                            WHEN al.audit_log_employee_id IS NOT NULL THEN 'employee'
                            WHEN al.audit_log_student_id IS NOT NULL THEN 'student'
                            ELSE 'system'
                        END as user_type
                    FROM tbl_csdl_audit_log al
                    LEFT JOIN tbl_csdl_employees e ON e.employee_id = al.audit_log_employee_id
                    LEFT JOIN tbl_csdl_students s ON s.student_id = al.audit_log_student_id
                    $whereClause
                    ORDER BY al.audit_log_created_at DESC, al.audit_log_id DESC";

            if ($isCsvExport) {
                $csvStmt = $pdo->prepare($selectSql);
                foreach ($params as $key => $value) {
                    $csvStmt->bindValue($key, $value);
                }
                $csvStmt->execute();
                ob_clean();
                header('Content-Type: text/csv; charset=utf-8');
                header('Content-Disposition: attachment; filename="activity-history-' . date('Y-m-d') . '.csv"');
                header('Cache-Control: no-store');
                $output = fopen('php://output', 'w');
                fwrite($output, "\xEF\xBB\xBF");
                fputcsv($output, ['Audit ID', 'User', 'User Type', 'Employee ID', 'Student ID', 'Action', 'Records', 'Details', 'IP Address', 'Date & Time'], ',', '"', '');
                while ($row = $csvStmt->fetch(PDO::FETCH_ASSOC)) {
                    $cells = [
                        $row['audit_log_id'], $row['user_name'], $row['user_type'],
                        $row['audit_log_employee_id'], $row['audit_log_student_id'],
                        $row['audit_log_action'], $row['audit_log_records'], $row['audit_log_details'],
                        $row['audit_log_ip_address'], $row['audit_log_created_at'],
                    ];
                    $cells = array_map(static function ($cell) {
                        $text = (string) ($cell ?? '');
                        return preg_match('/^[\s\x00-\x1f]*[=+\-@]/', $text) ? "'" . $text : $text;
                    }, $cells);
                    fputcsv($output, $cells, ',', '"', '');
                }
                fclose($output);
                return;
            }

            $countStmt = $pdo->prepare("SELECT COUNT(*) as total
                FROM tbl_csdl_audit_log al
                LEFT JOIN tbl_csdl_employees e ON e.employee_id = al.audit_log_employee_id
                LEFT JOIN tbl_csdl_students s ON s.student_id = al.audit_log_student_id
                $whereClause");
            foreach ($params as $key => $value) {
                $countStmt->bindValue($key, $value);
            }
            $countStmt->execute();
            $total = (int) $countStmt->fetchColumn();

            if ($isExport) {
                $exportSql = $selectSql . ' LIMIT 10000';
                $exportStmt = $pdo->prepare($exportSql);
                foreach ($params as $key => $value) {
                    $exportStmt->bindValue($key, $value);
                }
                $exportStmt->execute();
                $logs = $exportStmt->fetchAll(PDO::FETCH_ASSOC);

                echo json_encode([
                    'success' => true,
                    'logs' => $logs,
                    'total' => $total,
                    'truncated' => $total > count($logs)
                ]);
                return;
            }

            $page = max(1, intval($_GET['page'] ?? 1));
            $perPage = max(10, min(100, intval($_GET['perPage'] ?? 25)));
            $offset = ($page - 1) * $perPage;
            
            $sql = $selectSql . ' LIMIT :limit OFFSET :offset';
            
            $stmt = $pdo->prepare($sql);
            foreach ($params as $key => $value) {
                $stmt->bindValue($key, $value);
            }
            $stmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            $stmt->execute();
            $logs = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            $totalPages = ceil($total / $perPage);
            
            echo json_encode([
                'success' => true,
                'logs' => $logs,
                'total' => $total,
                'page' => $page,
                'perPage' => $perPage,
                'totalPages' => $totalPages
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Audit logs error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching audit logs. Please try again.']);
        }
        return;
    }
    
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    return;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Handle file upload separately (FormData doesn't work with json_decode)
    $hasFileUpload = isset($_FILES['systemLogo']) && $_FILES['systemLogo']['error'] === UPLOAD_ERR_OK;
    
    // Read JSON input for POST requests if $_POST is empty and no file upload
    if (!$hasFileUpload) {
        $input = json_decode(file_get_contents('php://input'), true);
        if (empty($_POST) && $input !== null) {
            $_POST = $input;
        }
    } else {
        // If file upload, settings will be in JSON string
        if (isset($_POST['settings']) && is_string($_POST['settings'])) {
            $_POST['settings'] = json_decode($_POST['settings'], true);
        }
    }

    // Decode JSON before validation so CSRFProtection can read the token from
    // either the JSON body or the request header in proxy/tunnel environments.
    CSRFProtection::validateRequest();
    
    $action = $_POST['action'] ?? '';

    if ($action === 'save-email-template' || $action === 'reset-email-template') {
        if (($_SESSION['user_type'] ?? '') !== 'employee' || (int) ($_SESSION['user_role_id'] ?? 0) !== 100) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'CSDL access required.']);
            return;
        }
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to edit email templates');
        try {
            $role = (string) ($_POST['role'] ?? '');
            $type = (string) ($_POST['type'] ?? '');
            $key = EmailTemplates::editableKey($role, $type);
            if ($action === 'reset-email-template') {
                $pdo->prepare('DELETE FROM tbl_csdl_settings WHERE setting_key = ?')->execute([$key]);
            } else {
                $subject = trim((string) ($_POST['subject'] ?? ''));
                $body = trim((string) ($_POST['body'] ?? ''));
                if ($subject === '' || mb_strlen($subject, 'UTF-8') > 180 || preg_match('/[\r\n\x00-\x1f]/', $subject)
                    || strip_tags($subject) !== $subject || $body === '' || mb_strlen($body, 'UTF-8') > 5000
                    || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f]/', $body)) {
                    throw new InvalidArgumentException('Enter a plain-text subject (up to 180 characters) and message (up to 5,000 characters).');
                }
                preg_match_all('/\{([a-z_]+)\}/', $subject . '\n' . $body, $matches);
                foreach ($matches[1] as $variable) {
                    if (!array_key_exists($variable, EmailTemplates::editableVariables([]))) {
                        throw new InvalidArgumentException('Unsupported placeholder: {' . $variable . '}');
                    }
                }
                $payload = json_encode(['subject' => $subject, 'body' => $body], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                $stmt = $pdo->prepare('INSERT INTO tbl_csdl_settings (setting_key, setting_value, setting_description, setting_updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_updated_by = VALUES(setting_updated_by), setting_updated_at = CURRENT_TIMESTAMP');
                $stmt->execute([$key, $payload, 'Editable email message for ' . $role . ' / ' . $type, $employeeId]);
            }
            echo json_encode(['success' => true, 'message' => $action === 'save-email-template' ? 'Email template saved.' : 'Built-in email template restored.']);
        } catch (InvalidArgumentException $e) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            error_log('Email template update error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Could not update email template.']);
        }
        return;
    }
    
    if ($action === 'update') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to update settings');
        if (!isset($_SESSION['user_id'])) {
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Unauthorized']);
            return;
        }
        
        $settings = $_POST['settings'] ?? [];
        if (empty($settings) || !is_array($settings)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid settings data']);
            return;
        }
        
        try {
            $pdo->beginTransaction();
            $updatedBy = $_SESSION['user_id'];
            
            // Handle logo file upload if present
            if ($hasFileUpload) {
                $file = $_FILES['systemLogo'];
                $allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
                $allowedExtensions = ['png', 'jpg', 'jpeg', 'gif'];
                $maxSize = 2 * 1024 * 1024; // 2MB

                [$uploadValid, $uploadMessage] = UploadSecurity::validateUploadedFile(
                    $file,
                    $allowedExtensions,
                    $allowedTypes,
                    $maxSize
                );
                if (!$uploadValid) {
                    if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                        $uploadMessage = 'Invalid file type. Only PNG, JPG, and GIF are allowed.';
                    }
                    throw new Exception($uploadMessage);
                }
                
                // Create upload directory if it doesn't exist
                $uploadDir = __DIR__ . '/../../uploads/system/';
                if (!is_dir($uploadDir)) {
                    mkdir($uploadDir, 0755, true);
                }
                
                // Generate unique filename
                $fileExt = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
                $fileName = 'logo_' . time() . '.' . $fileExt;
                $filePath = $uploadDir . $fileName;
                
                // Move uploaded file
                if (!move_uploaded_file($file['tmp_name'], $filePath)) {
                    throw new Exception('Failed to upload logo file.');
                }
                
                // Store relative path in database
                $relativePath = 'uploads/system/' . $fileName;
                
                // Check if system_logo setting exists
                $checkLogoStmt = $pdo->prepare("SELECT setting_id FROM tbl_csdl_settings WHERE setting_key = 'system_logo'");
                $checkLogoStmt->execute();
                if ($checkLogoStmt->fetch()) {
                    // Update existing
                    $updateLogoStmt = $pdo->prepare("UPDATE tbl_csdl_settings SET setting_value = ?, setting_updated_by = ?, setting_updated_at = CURRENT_TIMESTAMP WHERE setting_key = 'system_logo'");
                    $updateLogoStmt->execute([$relativePath, $updatedBy]);
                } else {
                    // Insert new
                    $insertLogoStmt = $pdo->prepare("INSERT INTO tbl_csdl_settings (setting_key, setting_value, setting_description, setting_updated_by) VALUES ('system_logo', ?, 'Path to system logo image', ?)");
                    $insertLogoStmt->execute([$relativePath, $updatedBy]);
                }
            }
            
            foreach ($settings as $key => $value) {
                // Validate setting key exists
                $checkStmt = $pdo->prepare("SELECT setting_id FROM tbl_csdl_settings WHERE setting_key = ?");
                $checkStmt->execute([$key]);
                if (!$checkStmt->fetch()) {
                    // This setting is introduced after the original settings seed.
                    // Create only this explicitly allowed key; all other unknown
                    // keys remain rejected.
                    if ($key === 'minimum_amount_can_pay') {
                        $minimumAmount = filter_var($value, FILTER_VALIDATE_FLOAT);
                        if ($minimumAmount === false || $minimumAmount <= 0) {
                            throw new Exception('Minimum amount can pay must be greater than zero.');
                        }
                        $insertStmt = $pdo->prepare("INSERT INTO tbl_csdl_settings
                            (setting_key, setting_value, setting_description, setting_updated_by)
                            VALUES (?, ?, ?, ?)");
                        $insertStmt->execute([
                            'minimum_amount_can_pay',
                            number_format((float) $minimumAmount, 2, '.', ''),
                            'Minimum amount a student can enter for Amount Can Pay',
                            $updatedBy
                        ]);
                    }
                    continue; // Skip invalid keys
                }

                if ($key === 'minimum_amount_can_pay') {
                    $minimumAmount = filter_var($value, FILTER_VALIDATE_FLOAT);
                    if ($minimumAmount === false || $minimumAmount <= 0) {
                        throw new Exception('Minimum amount can pay must be greater than zero.');
                    }
                    $value = number_format((float) $minimumAmount, 2, '.', '');
                }
                
                $stmt = $pdo->prepare("UPDATE tbl_csdl_settings SET setting_value = ?, setting_updated_by = ?, setting_updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?");
                $stmt->execute([$value, $updatedBy, $key]);
            }
            
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Settings updated successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('Settings update error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error updating settings. Please try again.']);
        }
        return;
    }
    
    if ($action === 'update-application-periods') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to update application periods');
        if (!isset($_SESSION['user_id'])) {
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Unauthorized']);
            return;
        }
        
        $periods = $_POST['periods'] ?? [];
        if (empty($periods) || !is_array($periods)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid periods data']);
            return;
        }
        
        try {
            $pdo->beginTransaction();
            
            foreach ($periods as $period) {
                $periodId = intval($period['id'] ?? 0);
                $status = intval($period['status'] ?? 0);
                
                if ($periodId <= 0) {
                    continue;
                }
                
                $checkStmt = $pdo->prepare("SELECT app_period_id FROM tbl_csdl_application_periods WHERE app_period_id = ?");
                $checkStmt->execute([$periodId]);
                if (!$checkStmt->fetch()) {
                    continue;
                }
                
                $stmt = $pdo->prepare("UPDATE tbl_csdl_application_periods SET app_period_status = ? WHERE app_period_id = ?");
                $stmt->execute([$status, $periodId]);
            }
            
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Application periods updated successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('Application periods update error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error updating application periods. Please try again.']);
        }
        return;
    }

    if ($action === 'save-exam-schedules') {
        RBAC::requirePermission($employeeId, 'csdl.settings.edit', 'You do not have permission to update exam schedules');
        if (!isset($_SESSION['user_id'])) {
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Unauthorized']);
            return;
        }

        $schedules = $_POST['schedules'] ?? [];
        $deletedIds = $_POST['deleted_ids'] ?? [];
        if (!is_array($schedules)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid schedules data']);
            return;
        }

        try {
            $pdo->beginTransaction();
            $updatedBy = (int) $_SESSION['user_id'];

            if (is_array($deletedIds)) {
                $deleteStmt = $pdo->prepare("DELETE FROM tbl_csdl_exam_schedules WHERE exam_schedule_id = ?");
                foreach ($deletedIds as $rawId) {
                    $scheduleId = (int) $rawId;
                    if ($scheduleId > 0) {
                        $deleteStmt->execute([$scheduleId]);
                    }
                }
            }

            $insertStmt = $pdo->prepare("INSERT INTO tbl_csdl_exam_schedules
                (exam_sy_id, exam_period_id, exam_start_date, exam_end_date, exam_status, exam_created_by, exam_updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)");
            $updateStmt = $pdo->prepare("UPDATE tbl_csdl_exam_schedules
                SET exam_sy_id = ?, exam_period_id = ?, exam_start_date = ?, exam_end_date = ?, exam_status = ?, exam_updated_by = ?
                WHERE exam_schedule_id = ?");

            foreach ($schedules as $schedule) {
                $scheduleId = (int) ($schedule['id'] ?? 0);
                $syId = (int) ($schedule['sy_id'] ?? 0);
                $periodId = (int) ($schedule['period_id'] ?? 0);
                $startDate = trim((string) ($schedule['start_date'] ?? ''));
                $endDate = trim((string) ($schedule['end_date'] ?? ''));
                $status = (int) ($schedule['status'] ?? 0) === 1 ? 1 : 0;

                if ($syId <= 0 || $periodId <= 0 || $startDate === '') {
                    continue;
                }
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate)) {
                    throw new Exception('Invalid exam start date.');
                }
                if ($endDate !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate)) {
                    throw new Exception('Invalid exam end date.');
                }
                if ($endDate === '') {
                    $endDate = null;
                } elseif ($endDate < $startDate) {
                    throw new Exception('Exam end date cannot be before the start date.');
                }

                $syCheck = $pdo->prepare("SELECT sy_id FROM tbl_csdl_school_years WHERE sy_id = ?");
                $syCheck->execute([$syId]);
                if (!$syCheck->fetch()) {
                    throw new Exception('Invalid school year selected.');
                }

                $periodCheck = $pdo->prepare("SELECT app_period_id FROM tbl_csdl_application_periods WHERE app_period_id = ?");
                $periodCheck->execute([$periodId]);
                if (!$periodCheck->fetch()) {
                    throw new Exception('Invalid application period selected.');
                }

                if ($scheduleId > 0) {
                    $existsStmt = $pdo->prepare("SELECT exam_schedule_id FROM tbl_csdl_exam_schedules WHERE exam_schedule_id = ?");
                    $existsStmt->execute([$scheduleId]);
                    if ($existsStmt->fetch()) {
                        $updateStmt->execute([$syId, $periodId, $startDate, $endDate, $status, $updatedBy, $scheduleId]);
                        continue;
                    }
                }

                $insertStmt->execute([$syId, $periodId, $startDate, $endDate, $status, $updatedBy, $updatedBy]);
            }

            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Exam schedules saved successfully']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            http_response_code(500);
            error_log('Exam schedules save error: ' . $e->getMessage());
            $message = 'Error saving exam schedules. Please try again.';
            if ($e instanceof Exception && $e->getMessage()) {
                $message = $e->getMessage();
            }
            echo json_encode(['success' => false, 'message' => $message]);
        }
        return;
    }
    
    if ($action === 'send-otp') {
        if (!isset($_SESSION['user_id']) || $_SESSION['user_type'] !== 'employee') {
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Unauthorized']);
            return;
        }
        
        TurnstileVerification::requireValid($_POST['cf-turnstile-response'] ?? '', 'profile_update');

        $email = trim($_POST['email'] ?? '');
        
        if (empty($email) || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Valid email is required']);
            return;
        }
        
        try {
            $employeeId = $_SESSION['user_id'];
            $rateLimiter = new RateLimiter();
            $sendOtpRate = $rateLimiter->checkRateLimit('employee_profile_otp_send', 3, 600, null, (int)$employeeId);
            if (!$sendOtpRate['allowed']) {
                http_response_code(429);
                echo json_encode(['success' => false, 'message' => 'Too many OTP requests. Please try again later.']);
                return;
            }
            
            // Get employee details
            $stmt = $pdo->prepare("SELECT employee_first_name, employee_last_name, employee_email FROM tbl_csdl_employees WHERE employee_id = ?");
            $stmt->execute([$employeeId]);
            $employee = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$employee) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Employee not found']);
                return;
            }
            
            // Handle profile image upload if present
            $profileImagePath = null;
            if (isset($_FILES['profile_image']) && $_FILES['profile_image']['error'] === UPLOAD_ERR_OK) {
                $file = $_FILES['profile_image'];
                $allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
                $allowedExtensions = ['jpg', 'jpeg', 'png'];
                $maxSize = 2 * 1024 * 1024; // 2MB

                [$uploadValid, $uploadMessage] = UploadSecurity::validateUploadedFile(
                    $file,
                    $allowedExtensions,
                    $allowedTypes,
                    $maxSize
                );
                if (!$uploadValid) {
                    if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                        $uploadMessage = 'Invalid file type. Only JPG and PNG are allowed.';
                    }
                    throw new Exception($uploadMessage);
                }
                
                // Create upload directory if it doesn't exist
                $uploadDir = __DIR__ . '/../../uploads/profiles/';
                if (!is_dir($uploadDir)) {
                    mkdir($uploadDir, 0755, true);
                }
                
                // Generate unique filename
                $fileExt = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
                $fileName = 'employee_' . $employeeId . '_' . time() . '.' . $fileExt;
                $filePath = $uploadDir . $fileName;
                
                // Move uploaded file
                if (!move_uploaded_file($file['tmp_name'], $filePath)) {
                    throw new Exception('Failed to upload profile image.');
                }
                
                // Store relative path
                $profileImagePath = 'uploads/profiles/' . $fileName;
            }
            
            // Generate 6-digit OTP
            $otpCode = str_pad(rand(0, 999999), 6, '0', STR_PAD_LEFT);
            
            // Store OTP and profile data in session
            $_SESSION['otp_code'] = $otpCode;
            $_SESSION['otp_email'] = $email;
            $_SESSION['otp_generated_at'] = time();
            $_SESSION['otp_type'] = 'profile_update';
            $_SESSION['otp_profile_image'] = $profileImagePath; // Store image path for later
            
            $mailerConfig = emailMailerCreate('system');
            if ($mailerConfig === null) {
                throw new Exception('SMTP configuration is incomplete');
            }

            $fullName = trim(($employee['employee_first_name'] ?? '') . ' ' . ($employee['employee_last_name'] ?? ''));
            $htmlBody = EmailTemplates::otpEmail($fullName, $otpCode, $mailerConfig['from_name'], $mailerConfig['support_email']);
            
            $emailMsg = (new Email())
                ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
                ->to($email)
                ->subject('Your One-Time Passcode (OTP) - Profile Update')
                ->html($htmlBody);
            EmailTemplates::embedSchoolLogo($emailMsg);
            
            try {
                $mailerConfig['mailer']->send($emailMsg);
                echo json_encode(['success' => true, 'message' => 'OTP sent to your email']);
            } catch (TransportExceptionInterface $e) {
                error_log('Email send failed: ' . $e->getMessage());
                throw new Exception('Failed to send OTP email. Please verify SMTP settings.');
            }
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Send OTP error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error sending OTP. Please try again.']);
        }
        return;
    }
    
    if ($action === 'verify-otp') {
        if (!isset($_SESSION['user_id']) || $_SESSION['user_type'] !== 'employee') {
            http_response_code(401);
            echo json_encode(['success' => false, 'message' => 'Unauthorized']);
            return;
        }
        
        $otpCode = trim($_POST['otp_code'] ?? '');
        $birthdate = trim($_POST['birthdate'] ?? '');
        $gender = trim($_POST['gender'] ?? '');
        $contactNumber = trim($_POST['contact_number'] ?? '');
        $email = trim($_POST['email'] ?? '');
        
        // Validate OTP
        if (empty($otpCode)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'OTP code is required']);
            return;
        }
        
        if (!isset($_SESSION['otp_code']) || !isset($_SESSION['otp_generated_at'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'No OTP found. Please request a new one.']);
            return;
        }

        $employeeId = $_SESSION['user_id'];
        $rateLimiter = new RateLimiter();
        $verifyOtpRate = $rateLimiter->checkRateLimit('employee_profile_otp_verify', 5, 600, null, (int)$employeeId);
        if (!$verifyOtpRate['allowed']) {
            http_response_code(429);
            echo json_encode(['success' => false, 'message' => 'Too many OTP verification attempts. Please try again later.']);
            return;
        }
        
        // Match the 10-minute validity stated in the OTP email.
        if (time() - $_SESSION['otp_generated_at'] > 600) {
            unset($_SESSION['otp_code'], $_SESSION['otp_generated_at'], $_SESSION['otp_email'], $_SESSION['otp_type'], $_SESSION['otp_profile_image']);
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'OTP has expired. Please request a new one.']);
            return;
        }
        
        // Verify OTP
        if ($otpCode !== $_SESSION['otp_code']) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid OTP code']);
            return;
        }
        
        try {
            // Get profile image path from session if it was uploaded
            $profileImagePath = $_SESSION['otp_profile_image'] ?? null;
            
            // Update employee profile with or without image
            if ($profileImagePath) {
                $updateStmt = $pdo->prepare("UPDATE tbl_csdl_employees 
                                            SET employee_date_of_birth = ?,
                                                employee_gender = ?,
                                                employee_contact_number = ?,
                                                employee_email = ?,
                                                employee_profile_image = ?
                                            WHERE employee_id = ?");
                $updateStmt->execute([$birthdate, $gender, $contactNumber, $email, $profileImagePath, $employeeId]);
            } else {
                $updateStmt = $pdo->prepare("UPDATE tbl_csdl_employees 
                                            SET employee_date_of_birth = ?,
                                                employee_gender = ?,
                                                employee_contact_number = ?,
                                                employee_email = ?
                                            WHERE employee_id = ?");
                $updateStmt->execute([$birthdate, $gender, $contactNumber, $email, $employeeId]);
            }
            
            // Clear OTP from session
            unset($_SESSION['otp_code'], $_SESSION['otp_generated_at'], $_SESSION['otp_email'], $_SESSION['otp_type'], $_SESSION['otp_profile_image']);
            $rateLimiter->resetRateLimit('employee_profile_otp_verify', null, (int)$employeeId);
            
            echo json_encode(['success' => true, 'message' => 'Profile updated successfully']);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Profile update error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error updating profile. Please try again.']);
        }
        return;
    }
    
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    return;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
?>
