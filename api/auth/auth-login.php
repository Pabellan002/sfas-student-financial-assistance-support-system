<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-audit.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../includes/includes-active-session.php';
require_once __DIR__ . '/../includes/includes-password-policy.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

$input = [];
if (!empty($_POST)) {
    $input = $_POST;
} else {
    $json = file_get_contents('php://input');
    $input = json_decode($json, true) ?? [];
}

$_POST = array_merge($_POST, $input);

$headers = getallheaders();
if ($headers === false) {
    $headers = [];
    foreach ($_SERVER as $key => $value) {
        if (strpos($key, 'HTTP_') === 0) {
            $headerName = str_replace(' ', '-', ucwords(str_replace('_', ' ', strtolower(substr($key, 5)))));
            $headers[$headerName] = $value;
        }
    }
}

CSRFProtection::validateRequest();

$schoolId = trim($_POST['school_id'] ?? $input['school_id'] ?? '');
$password = $_POST['password'] ?? $input['password'] ?? '';
$turnstileToken = $_POST['cf-turnstile-response'] ?? '';

$schoolId = filter_var($schoolId, FILTER_SANITIZE_FULL_SPECIAL_CHARS, FILTER_FLAG_NO_ENCODE_QUOTES);



if (empty($schoolId) || empty($password)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'School ID and password are required']);
    exit;
}

if (!InputValidation::validateSchoolId($schoolId)) {
    
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid school ID format']);
    exit;
}

$turnstileResult = TurnstileVerification::validate($turnstileToken, 'login');
if (!$turnstileResult['success']) {
    http_response_code($turnstileResult['status']);
    unset($turnstileResult['status']);
    echo json_encode($turnstileResult);
    exit;
}

if (InputValidation::detectSQLInjection($schoolId)) {
    
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid input detected']);
    exit;
}

try {
    // Get configurable security settings
    $maxAttemptsStmt = $pdo->prepare("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'max_login_attempts' LIMIT 1");
    $maxAttemptsStmt->execute();
    $maxAttemptsRow = $maxAttemptsStmt->fetch();
    $maxLoginAttempts = $maxAttemptsRow ? intval($maxAttemptsRow['setting_value']) : 5;
    
    $lockDurationStmt = $pdo->prepare("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'account_lock_duration' LIMIT 1");
    $lockDurationStmt->execute();
    $lockDurationRow = $lockDurationStmt->fetch();
    $accountLockDuration = $lockDurationRow ? intval($lockDurationRow['setting_value']) : 30;
    
    // First check if student exists (regardless of status)
    $regColumnAvailable = false;
    try {
        $colStmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_registration_status'");
        $regColumnAvailable = (bool) $colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $regColumnAvailable = false;
    }

    $regSelect = $regColumnAvailable ? ', student_registration_status' : ", 'approved' AS student_registration_status";
    $checkStmt = $pdo->prepare("
        SELECT student_id, student_is_active{$regSelect}
        FROM tbl_csdl_students
        WHERE student_school_id = ?
        LIMIT 1
    ");
    $checkStmt->execute([$schoolId]);
    $studentCheck = $checkStmt->fetch();
    
    if ($studentCheck) {
        $registrationStatus = (string) ($studentCheck['student_registration_status'] ?? 'approved');
        if ($registrationStatus === 'pending') {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'Your registration is pending CSDL approval. You may sign in once CSDL approves your registration.',
            ]);
            exit;
        }
        if ($registrationStatus === 'rejected') {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'Your registration was not approved. You may submit a new registration with the same School ID. Contact the CSDL office if you need help.',
            ]);
            exit;
        }
    }

    // If student exists but is inactive, return specific error
    if ($studentCheck && intval($studentCheck['student_is_active']) !== 1) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Your account has been deactivated. Please contact the administrator.'
        ]);
        exit;
    }

    $stmt = $pdo->prepare("
        SELECT 
            student_id,
            student_school_id,
            student_first_name,
            student_middle_name,
            student_last_name,
            student_password_hash,
            student_role_id,
            student_email,
            student_is_active,
            student_status_id,
            student_created_at,
            student_password_changed_at
        FROM tbl_csdl_students
        WHERE student_school_id = ? AND student_is_active = 1
        LIMIT 1
    ");
    $stmt->execute([$schoolId]);
    $student = $stmt->fetch();
    
    // Check if account is locked
    if ($student) {
        $securityCheckStmt = $pdo->prepare("
            SELECT security_failed_login_attempts, security_last_login_attempt, security_account_locked_until
            FROM tbl_csdl_account_security
            WHERE security_student_id = ?
            LIMIT 1
        ");
        $securityCheckStmt->execute([$student['student_id']]);
        $securityData = $securityCheckStmt->fetch();
        
        if ($securityData) {
            // Check if account is currently locked
            if ($securityData['security_account_locked_until'] && strtotime($securityData['security_account_locked_until']) > time()) {
                $lockUntil = date('Y-m-d H:i:s', strtotime($securityData['security_account_locked_until']));
                http_response_code(403);
                echo json_encode([
                    'success' => false,
                    'message' => 'Account is locked due to too many failed login attempts. Please try again after ' . $lockUntil
                ]);
                exit;
            }
            
            // Check if max attempts exceeded
            if (intval($securityData['security_failed_login_attempts']) >= $maxLoginAttempts) {
                // Lock the account
                $lockUntil = date('Y-m-d H:i:s', time() + ($accountLockDuration * 60));
                $lockStmt = $pdo->prepare("
                    UPDATE tbl_csdl_account_security
                    SET security_account_locked_until = ?
                    WHERE security_student_id = ?
                ");
                $lockStmt->execute([$lockUntil, $student['student_id']]);
                
                http_response_code(403);
                echo json_encode([
                    'success' => false,
                    'message' => 'Account locked due to too many failed login attempts. Please try again after ' . $lockUntil
                ]);
                exit;
            }
        }
    }
    
    $passwordValid = $student
        ? password_verify($password, $student['student_password_hash'])
        : false;

    if ($student && $passwordValid) {
        if (password_needs_rehash($student['student_password_hash'], PASSWORD_DEFAULT)) {
            try {
                $upgradedPasswordHash = password_hash($password, PASSWORD_DEFAULT);
                $upgradeHashStmt = $pdo->prepare('UPDATE tbl_csdl_students SET student_password_hash = ? WHERE student_id = ?');
                $upgradeHashStmt->execute([$upgradedPasswordHash, $student['student_id']]);
                $student['student_password_hash'] = $upgradedPasswordHash;
            } catch (Throwable $rehashError) {
                error_log('Student password rehash failed: ' . $rehashError->getMessage());
            }
        }
        session_regenerate_id(true);
        $_SESSION['user_id'] = $student['student_id'];
        $_SESSION['user_type'] = 'student';
        $_SESSION['user_role_id'] = $student['student_role_id'];
        $_SESSION['school_id'] = $student['student_school_id'];
        $_SESSION['user_name'] = trim($student['student_first_name'] . ' ' . ($student['student_middle_name'] ?? '') . ' ' . $student['student_last_name']);
        $loginAt = time();
        $_SESSION['login_time'] = $loginAt;
        $_SESSION['last_activity'] = $loginAt;

        $passwordChangeReason = PasswordPolicy::getChangeReason(
            $student['student_password_hash'],
            $student['student_school_id'],
            $student['student_password_changed_at'] ?? null,
            $student['student_created_at'] ?? null
        );
        $requiresPasswordChange = $passwordChangeReason !== null;
        
        // Store password change requirement in session
        if ($requiresPasswordChange) {
            $_SESSION['requires_password_change'] = true;
            $_SESSION['password_change_reason'] = $passwordChangeReason;
        } else {
            unset($_SESSION['requires_password_change'], $_SESSION['password_change_reason']);
        }

        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';

        $auditStmt = $pdo->prepare("
            INSERT INTO tbl_csdl_audit_log 
            (audit_log_student_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
            VALUES (?, 'LOGIN', 1, ?, ?, ?)
        ");
        $auditStmt->execute([
            $student['student_id'],
            'Student login successful',
            $ipAddress,
            $userAgent
        ]);

        $existingSec = $pdo->prepare("SELECT security_id FROM tbl_csdl_account_security WHERE security_student_id = ? LIMIT 1");
        $existingSec->execute([$student['student_id']]);
        $existing = $existingSec->fetch();
        if ($existing) {
            $upd = $pdo->prepare("UPDATE tbl_csdl_account_security SET security_failed_login_attempts = 0, security_last_login_attempt = NOW(), security_account_locked_until = NULL, security_role_id = ? WHERE security_id = ?");
            $upd->execute([$student['student_role_id'], $existing['security_id']]);
        } else {
            $ins = $pdo->prepare("INSERT INTO tbl_csdl_account_security (security_student_id, security_role_id, security_failed_login_attempts, security_last_login_attempt) VALUES (?, ?, 0, NOW())");
            $ins->execute([$student['student_id'], $student['student_role_id']]);
        }

        $rateLimiter = new RateLimiter();
        $rateLimiter->resetRateLimit('login_failed', $student['student_id'], null);
        ActiveSession::issue($pdo, 'student', (int) $student['student_id']);
        CSRFProtection::regenerateToken();

        header('Content-Type: application/json');
        echo json_encode([
            'success' => true,
            'message' => 'Login successful',
            'requires_password_change' => $requiresPasswordChange,
            'password_change_reason' => $passwordChangeReason,
            'password_max_age_days' => PasswordPolicy::MAX_AGE_DAYS,
            'user' => [
                'id' => $student['student_id'],
                'type' => 'student',
                'role_id' => $student['student_role_id'],
                'name' => $_SESSION['user_name'],
                'school_id' => $student['student_school_id']
            ]
        ]);
        exit;
    }

    // First check if employee exists (regardless of status)
    $checkEmpStmt = $pdo->prepare("
        SELECT employee_id, employee_status
        FROM tbl_csdl_employees
        WHERE employee_school_id = ?
        LIMIT 1
    ");
    $checkEmpStmt->execute([$schoolId]);
    $employeeCheck = $checkEmpStmt->fetch();
    
    // If employee exists but is inactive, return specific error
    if ($employeeCheck && intval($employeeCheck['employee_status']) !== 1) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Your account has been deactivated. Please contact the administrator.'
        ]);
        exit;
    }

    $stmt = $pdo->prepare("
        SELECT 
            employee_id,
            employee_school_id,
            employee_first_name,
            employee_middle_name,
            employee_last_name,
            employee_password_hash,
            employee_role_id,
            employee_email,
            employee_status,
            employee_campus_id,
            employee_created_at,
            employee_password_changed_at
        FROM tbl_csdl_employees
        WHERE employee_school_id = ? AND employee_status = 1
        LIMIT 1
    ");
    $stmt->execute([$schoolId]);
    $employee = $stmt->fetch();
    
    // Check if account is locked
    if ($employee) {
        $securityCheckStmt = $pdo->prepare("
            SELECT security_failed_login_attempts, security_last_login_attempt, security_account_locked_until
            FROM tbl_csdl_account_security
            WHERE security_employee_id = ?
            LIMIT 1
        ");
        $securityCheckStmt->execute([$employee['employee_id']]);
        $securityData = $securityCheckStmt->fetch();
        
        if ($securityData) {
            // Check if account is currently locked
            if ($securityData['security_account_locked_until'] && strtotime($securityData['security_account_locked_until']) > time()) {
                $lockUntil = date('Y-m-d H:i:s', strtotime($securityData['security_account_locked_until']));
                http_response_code(403);
                echo json_encode([
                    'success' => false,
                    'message' => 'Account is locked due to too many failed login attempts. Please try again after ' . $lockUntil
                ]);
                exit;
            }
            
            // Check if max attempts exceeded
            if (intval($securityData['security_failed_login_attempts']) >= $maxLoginAttempts) {
                // Lock the account
                $lockUntil = date('Y-m-d H:i:s', time() + ($accountLockDuration * 60));
                $lockStmt = $pdo->prepare("
                    UPDATE tbl_csdl_account_security
                    SET security_account_locked_until = ?
                    WHERE security_employee_id = ?
                ");
                $lockStmt->execute([$lockUntil, $employee['employee_id']]);
                
                http_response_code(403);
                echo json_encode([
                    'success' => false,
                    'message' => 'Account locked due to too many failed login attempts. Please try again after ' . $lockUntil
                ]);
                exit;
            }
        }
    }
    
    if ($employee) {
        $passwordValid = $employee['employee_password_hash'] ? password_verify($password, $employee['employee_password_hash']) : false;
    }

    if ($employee && $employee['employee_password_hash'] && password_verify($password, $employee['employee_password_hash'])) {
        session_regenerate_id(true);
        $_SESSION['user_id'] = $employee['employee_id'];
        $_SESSION['user_type'] = 'employee';
        $_SESSION['user_role_id'] = $employee['employee_role_id'];
        $_SESSION['school_id'] = $employee['employee_school_id'];
        $_SESSION['user_name'] = trim($employee['employee_first_name'] . ' ' . ($employee['employee_middle_name'] ?? '') . ' ' . $employee['employee_last_name']);
        $_SESSION['campus_id'] = $employee['employee_campus_id'];
        $loginAt = time();
        $_SESSION['login_time'] = $loginAt;
        $_SESSION['last_activity'] = $loginAt;

        $passwordChangeReason = PasswordPolicy::getChangeReason(
            $employee['employee_password_hash'],
            $employee['employee_school_id'],
            $employee['employee_password_changed_at'] ?? null,
            $employee['employee_created_at'] ?? null
        );
        $requiresPasswordChange = $passwordChangeReason !== null;
        
        // Store password change requirement in session
        if ($requiresPasswordChange) {
            $_SESSION['requires_password_change'] = true;
            $_SESSION['password_change_reason'] = $passwordChangeReason;
        } else {
            unset($_SESSION['requires_password_change'], $_SESSION['password_change_reason']);
        }

        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';

        $auditStmt = $pdo->prepare("
            INSERT INTO tbl_csdl_audit_log 
            (audit_log_employee_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
            VALUES (?, 'LOGIN', 1, ?, ?, ?)
        ");
        $auditStmt->execute([
            $employee['employee_id'],
            'Staff login successful',
            $ipAddress,
            $userAgent
        ]);

        $existingSec = $pdo->prepare("SELECT security_id FROM tbl_csdl_account_security WHERE security_employee_id = ? LIMIT 1");
        $existingSec->execute([$employee['employee_id']]);
        $existing = $existingSec->fetch();
        if ($existing) {
            $upd = $pdo->prepare("UPDATE tbl_csdl_account_security SET security_failed_login_attempts = 0, security_last_login_attempt = NOW(), security_account_locked_until = NULL, security_role_id = ? WHERE security_id = ?");
            $upd->execute([$employee['employee_role_id'], $existing['security_id']]);
        } else {
            $ins = $pdo->prepare("INSERT INTO tbl_csdl_account_security (security_employee_id, security_role_id, security_failed_login_attempts, security_last_login_attempt) VALUES (?, ?, 0, NOW())");
            $ins->execute([$employee['employee_id'], $employee['employee_role_id']]);
        }

        $rateLimiter = new RateLimiter();
        $rateLimiter->resetRateLimit('login_failed', null, $employee['employee_id']);
        ActiveSession::issue($pdo, 'employee', (int) $employee['employee_id']);
        CSRFProtection::regenerateToken();

        header('Content-Type: application/json');
        echo json_encode([
            'success' => true,
            'message' => 'Login successful',
            'requires_password_change' => $requiresPasswordChange,
            'password_change_reason' => $passwordChangeReason,
            'password_max_age_days' => PasswordPolicy::MAX_AGE_DAYS,
            'user' => [
                'id' => $employee['employee_id'],
                'type' => 'employee',
                'role_id' => $employee['employee_role_id'],
                'name' => $_SESSION['user_name'],
                'school_id' => $employee['employee_school_id'],
                'campus_id' => $employee['employee_campus_id']
            ]
        ]);
        exit;
    }

    // Failed login - increment rate limit and failed attempts
    $rateLimiter = new RateLimiter();
    $rateCheck = $rateLimiter->checkRateLimit('login_failed', 5, 300);
    
    if (!$rateCheck['allowed']) {
        http_response_code(429);
        echo json_encode([
            'success' => false,
            'message' => 'Too many failed login attempts. Please try again later.',
            'reset_time' => $rateCheck['reset_time']
        ]);
        exit;
    }

    $failedStmt = $pdo->prepare("
        SELECT security_id, security_failed_login_attempts FROM tbl_csdl_account_security
        WHERE (security_student_id = (SELECT student_id FROM tbl_csdl_students WHERE student_school_id = ? LIMIT 1)
               OR security_employee_id = (SELECT employee_id FROM tbl_csdl_employees WHERE employee_school_id = ? LIMIT 1))
        LIMIT 1
    ");
    $failedStmt->execute([$schoolId, $schoolId]);
    $securityRecord = $failedStmt->fetch();
    $failedAttempts = null;

    if ($securityRecord) {
        $updateStmt = $pdo->prepare("
            UPDATE tbl_csdl_account_security
            SET security_failed_login_attempts = security_failed_login_attempts + 1,
                security_last_login_attempt = NOW()
            WHERE security_id = ?
        ");
        $updateStmt->execute([$securityRecord['security_id']]);
        $failedAttempts = intval($securityRecord['security_failed_login_attempts']) + 1;
    } else {
        if ($student) {
            $insertStmt = $pdo->prepare("
                INSERT INTO tbl_csdl_account_security 
                (security_student_id, security_role_id, security_failed_login_attempts, security_last_login_attempt)
                VALUES (?, ?, 1, NOW())
            ");
            $insertStmt->execute([$student['student_id'], $student['student_role_id']]);
            $failedAttempts = 1;
        } elseif ($employee) {
            $insertStmt = $pdo->prepare("
                INSERT INTO tbl_csdl_account_security 
                (security_employee_id, security_role_id, security_failed_login_attempts, security_last_login_attempt)
                VALUES (?, ?, 1, NOW())
            ");
            $insertStmt->execute([$employee['employee_id'], $employee['employee_role_id']]);
            $failedAttempts = 1;
        }
    }

    $message = 'Invalid School ID or Password.';
    if (($student || $employee) && $failedAttempts !== null) {
        $remainingAttempts = max(0, $maxLoginAttempts - $failedAttempts);
        $message .= ' ' . $remainingAttempts . ' login attempts remaining.';
    }

    http_response_code(401);
    echo json_encode([
        'success' => false,
        'message' => $message
    ]);

} catch(PDOException $e) {
    
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An error occurred. Please try again later.']);
}
?>
