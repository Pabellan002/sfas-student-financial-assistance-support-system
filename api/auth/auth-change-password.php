<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-audit.php';
require_once __DIR__ . '/../includes/includes-input-validation.php';
require_once __DIR__ . '/../includes/includes-rate-limit.php';
require_once __DIR__ . '/../includes/includes-email-templates.php';
require_once __DIR__ . '/../includes/includes-student-notification-emails.php';
require_once __DIR__ . '/../includes/includes-email-mailer.php';
require_once __DIR__ . '/../config/config-env.php';
require_once __DIR__ . '/../../vendor/autoload.php';

use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mime\Email;

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
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

CSRFProtection::validateRequest();

/**
 * Keep students signed in after their first password update so they can proceed
 * directly to the student dashboard. Employees retain the existing sign-in-again flow.
 */
function endSessionAfterForcedPasswordChange(bool $isForced, string $userType): void
{
    if (!$isForced || $userType === 'student') {
        return;
    }
    $_SESSION = [];
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_destroy();
    }
    $name = session_name();
    if ($name && isset($_COOKIE[$name])) {
        $p = session_get_cookie_params();
        setcookie(
            $name,
            '',
            time() - 3600,
            $p['path'] ?? '/',
            $p['domain'] ?? '',
            $p['secure'] ?? false,
            $p['httponly'] ?? true
        );
    }
}

$action = $input['action'] ?? 'change_password';
$userId = $_SESSION['user_id'];
$userType = $_SESSION['user_type'];

// Handle OTP sending
if ($action === 'send_otp') {
    TurnstileVerification::requireValid($_POST['cf-turnstile-response'] ?? '', 'password_change');
    try {
        $rateLimiter = new RateLimiter();
        $sendOtpRate = $rateLimiter->checkRateLimit(
            'change_password_otp_send',
            5,
            900,
            $userType === 'student' ? (int)$userId : null,
            $userType === 'employee' ? (int)$userId : null
        );
        if (!$sendOtpRate['allowed']) {
            http_response_code(429);
            echo json_encode(['success' => false, 'message' => 'Too many OTP requests. Please try again later.']);
            exit;
        }

        // Get old password if provided (for validation before sending OTP)
        $oldPassword = trim($input['old_password'] ?? '');
        
        $email = '';
        $schoolId = '';
        $roleId = 96;
        $fullName = '';
        
        if ($userType === 'student') {
            $stmt = $pdo->prepare("SELECT student_email, student_personal_email, student_school_id, student_first_name, student_last_name, student_password_hash, COALESCE(student_role_id, 96) as student_role_id FROM tbl_csdl_students WHERE student_id = ?");
            $stmt->execute([$userId]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$user || !studentHasNotificationEmail($user)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'No email on file. Please contact support.']);
                exit;
            }
            $studentOtpRecipients = getStudentNotificationEmails($user);
            
            // Validate old password if provided
            if (!empty($oldPassword)) {
                if (!password_verify($oldPassword, $user['student_password_hash'])) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Current password is incorrect']);
                    exit;
                }
            }
            
            $email = $studentOtpRecipients[0];
            $schoolId = $user['student_school_id'];
            $roleId = $user['student_role_id'];
            $fullName = trim(($user['student_first_name'] ?? '') . ' ' . ($user['student_last_name'] ?? ''));
        } else if ($userType === 'employee') {
            $stmt = $pdo->prepare("SELECT employee_email, employee_school_id, employee_first_name, employee_last_name, employee_password_hash, COALESCE(employee_role_id, 99) as employee_role_id FROM tbl_csdl_employees WHERE employee_id = ?");
            $stmt->execute([$userId]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$user || empty($user['employee_email'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'No email on file. Please contact support.']);
                exit;
            }
            
            // Validate old password if provided
            if (!empty($oldPassword)) {
                if (!password_verify($oldPassword, $user['employee_password_hash'])) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Current password is incorrect']);
                    exit;
                }
            }
            
            $email = $user['employee_email'];
            $schoolId = $user['employee_school_id'];
            $roleId = $user['employee_role_id'];
            $fullName = trim(($user['employee_first_name'] ?? '') . ' ' . ($user['employee_last_name'] ?? ''));
        } else {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid user type']);
            exit;
        }
        
        $mailerConfig = emailMailerCreate('system');
        if ($mailerConfig === null) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Email not configured. Please contact administrator.']);
            exit;
        }
        
        // Generate OTP and store only its hash (OTP is never stored in plaintext).
        $otp = str_pad(strval(random_int(0, 999999)), 6, '0', STR_PAD_LEFT);
        $otpHash = password_hash($otp, PASSWORD_DEFAULT);
        
        // Remove old tokens
        if ($userType === 'student') {
            $del = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_student_id = ?");
            $del->execute([$userId]);
            
            $ins = $pdo->prepare("INSERT INTO tbl_csdl_password_resets (pr_student_id, pr_role_id, pr_email, pr_school_id, pr_otp, pr_expires_at, pr_used, pr_created_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0, NOW())");
            $ins->execute([$userId, $roleId, $email, $schoolId, $otpHash]);
        } else {
            $del = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_employee_id = ?");
            $del->execute([$userId]);
            
            $ins = $pdo->prepare("INSERT INTO tbl_csdl_password_resets (pr_employee_id, pr_role_id, pr_email, pr_school_id, pr_otp, pr_expires_at, pr_used, pr_created_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0, NOW())");
            $ins->execute([$userId, $roleId, $email, $schoolId, $otpHash]);
        }
        
        $htmlBody = EmailTemplates::otpEmail($fullName, $otp, $mailerConfig['from_name'], $mailerConfig['support_email']);
        $emailMsg = (new Email())
            ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
            ->subject('Your One-Time Passcode (OTP) - Password Change')
            ->html($htmlBody);
            EmailTemplates::embedSchoolLogo($emailMsg);
        if ($userType === 'student') {
            applyStudentNotificationRecipients($emailMsg, $user);
        } else {
            $emailMsg->to($email);
        }
        
        try {
            $mailerConfig['mailer']->send($emailMsg);
        } catch (TransportExceptionInterface $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Email send failed. Please verify SMTP settings.']);
            exit;
        }
        
        $otpMessage = ($userType === 'student' && isset($studentOtpRecipients) && count($studentOtpRecipients) > 1)
            ? 'OTP sent to your school and personal email. Please check your inbox.'
            : 'OTP sent to your email. Please check your inbox.';
        echo json_encode(['success' => true, 'message' => $otpMessage]);
        exit;
    } catch (Throwable $e) {
        error_log('Send OTP error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Error sending OTP. Please try again.']);
        exit;
    }
}

// Handle password change with OTP verification
$oldPassword = trim($input['old_password'] ?? '');
$newPassword = trim($input['new_password'] ?? '');
$confirmPassword = trim($input['confirm_password'] ?? '');
$otp = trim($input['otp'] ?? '');

// Only require new password and confirm password (old password is optional for default password changes)
if (empty($newPassword) || empty($confirmPassword)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'New password and confirm password are required']);
    exit;
}

// Login-enforced default/expired changes do not require another OTP. All other
// password changes must provide the current password and a verified OTP.
$isForcedPasswordChange = empty($oldPassword);
if ($isForcedPasswordChange && (($_SESSION['requires_password_change'] ?? false) !== true)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Current password is required']);
    exit;
}
if (!$isForcedPasswordChange) {
    if (empty($otp) || strlen($otp) !== 6) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'OTP is required']);
        exit;
    }
}

if ($newPassword !== $confirmPassword) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Passwords do not match']);
    exit;
}

// Only check if old password matches new password if old password is provided
if (!empty($oldPassword) && $oldPassword === $newPassword) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'New password must be different from old password']);
    exit;
}

// Validate password strength
$errors = [];
if (!InputValidation::validatePassword($newPassword, $errors)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => implode(' ', $errors)]);
    exit;
}

try {
    $rateLimiter = new RateLimiter();
    // Verify OTP only if not a default password change
    if (!$isForcedPasswordChange) {
        $verifyOtpRate = $rateLimiter->checkRateLimit(
            'change_password_otp_verify',
            10,
            900,
            $userType === 'student' ? (int)$userId : null,
            $userType === 'employee' ? (int)$userId : null
        );
        if (!$verifyOtpRate['allowed']) {
            http_response_code(429);
            echo json_encode(['success' => false, 'message' => 'Too many OTP verification attempts. Please try again later.']);
            exit;
        }

        if ($userType === 'student') {
            $rst = $pdo->prepare("SELECT pr_id, pr_otp, pr_expires_at, pr_used, (pr_expires_at <= NOW()) AS pr_expired FROM tbl_csdl_password_resets WHERE pr_student_id = ? ORDER BY pr_id DESC LIMIT 1");
            $rst->execute([$userId]);
        } else {
            $rst = $pdo->prepare("SELECT pr_id, pr_otp, pr_expires_at, pr_used, (pr_expires_at <= NOW()) AS pr_expired FROM tbl_csdl_password_resets WHERE pr_employee_id = ? ORDER BY pr_id DESC LIMIT 1");
            $rst->execute([$userId]);
        }
        
        $reset = $rst->fetch(PDO::FETCH_ASSOC);
        
        if (!$reset) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'No OTP found. Please request again.']);
            exit;
        }
        
        if ($reset['pr_used'] == 1 || (int)$reset['pr_expired'] === 1) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'OTP expired or already used. Please request again.']);
            exit;
        }
        
        $storedOtp = (string)($reset['pr_otp'] ?? '');
        $otpValid = (strpos($storedOtp, '$2') === 0 || strpos($storedOtp, '$argon2') === 0)
            ? password_verify($otp, $storedOtp)
            : hash_equals($storedOtp, $otp);
        if (!$otpValid) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid OTP.']);
            exit;
        }
        
        $resetId = $reset['pr_id'];
    } else {
        $resetId = null;
    }

    if ($userType === 'employee') {
        // Verify employee exists and get password hash
        $stmt = $pdo->prepare("SELECT employee_school_id, employee_password_hash FROM tbl_csdl_employees WHERE employee_id = ? LIMIT 1");
        $stmt->execute([$userId]);
        $employee = $stmt->fetch();

        if (!$employee) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Employee not found']);
            exit;
        }

        // Verify old password only if provided (skip for default password changes)
        if (!empty($oldPassword)) {
            if (!password_verify($oldPassword, $employee['employee_password_hash'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Current password is incorrect']);
                exit;
            }
        }

        // Hash new password
        $newPasswordHash = password_hash($newPassword, PASSWORD_DEFAULT);

        // Update password
        if (password_verify($newPassword, $employee['employee_password_hash'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'New password must be different from your current password']);
            exit;
        }

        $updateStmt = $pdo->prepare("UPDATE tbl_csdl_employees SET employee_password_hash = ?, employee_password_changed_at = NOW(), employee_updated_at = NOW() WHERE employee_id = ?");
        $updateStmt->execute([$newPasswordHash, $userId]);
        
        // Clear password change requirement from session
        unset($_SESSION['requires_password_change'], $_SESSION['password_change_reason']);

        // Mark OTP as used only if OTP was used
        if ($resetId !== null) {
            $updOtp = $pdo->prepare("UPDATE tbl_csdl_password_resets SET pr_used = 1 WHERE pr_id = ?");
            $updOtp->execute([$resetId]);
            $rateLimiter->resetRateLimit(
                'change_password_otp_verify',
                null,
                (int)$userId
            );
        }

        // Log password change
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $auditStmt = $pdo->prepare("
            INSERT INTO tbl_csdl_audit_log 
            (audit_log_employee_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
            VALUES (?, 'CHANGE_PASSWORD', 1, ?, ?, ?)
        ");
        $auditStmt->execute([
            $userId,
            json_encode(['password_changed' => true]),
            $ipAddress,
            $userAgent
        ]);

        endSessionAfterForcedPasswordChange($isForcedPasswordChange, $userType);

        echo json_encode([
            'success' => true,
            'message' => 'Password changed successfully',
            'require_login' => $isForcedPasswordChange && $userType !== 'student'
        ]);
    } else if ($userType === 'student') {
        // Verify student exists and get password hash
        $stmt = $pdo->prepare("SELECT student_school_id, student_password_hash FROM tbl_csdl_students WHERE student_id = ? LIMIT 1");
        $stmt->execute([$userId]);
        $student = $stmt->fetch();

        if (!$student) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Student not found']);
            exit;
        }

        // Verify old password only if provided (skip for default password changes)
        if (!empty($oldPassword)) {
            if (!password_verify($oldPassword, $student['student_password_hash'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Current password is incorrect']);
                exit;
            }
        }

        // Hash new password
        $newPasswordHash = password_hash($newPassword, PASSWORD_DEFAULT);

        // Update password
        if (password_verify($newPassword, $student['student_password_hash'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'New password must be different from your current password']);
            exit;
        }

        $updateStmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_password_hash = ?, student_password_changed_at = NOW(), student_updated_at = NOW() WHERE student_id = ?");
        $updateStmt->execute([$newPasswordHash, $userId]);
        
        // Clear password change requirement from session
        unset($_SESSION['requires_password_change'], $_SESSION['password_change_reason']);

        // Mark OTP as used only if OTP was used
        if ($resetId !== null) {
            $updOtp = $pdo->prepare("UPDATE tbl_csdl_password_resets SET pr_used = 1 WHERE pr_id = ?");
            $updOtp->execute([$resetId]);
            $rateLimiter->resetRateLimit(
                'change_password_otp_verify',
                (int)$userId,
                null
            );
        }

        // Log password change
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $auditStmt = $pdo->prepare("
            INSERT INTO tbl_csdl_audit_log 
            (audit_log_student_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
            VALUES (?, 'CHANGE_PASSWORD', 1, ?, ?, ?)
        ");
        $auditStmt->execute([
            $userId,
            json_encode(['password_changed' => true]),
            $ipAddress,
            $userAgent
        ]);

        endSessionAfterForcedPasswordChange($isForcedPasswordChange, $userType);

        echo json_encode(['success' => true, 'message' => 'Password changed successfully', 'require_login' => false]);
    } else {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid user type']);
    }
} catch (PDOException $e) {
    error_log("Password change error: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An error occurred. Please try again.']);
} catch (Throwable $e) {
    error_log("Password change error: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An error occurred. Please try again.']);
}
?>
