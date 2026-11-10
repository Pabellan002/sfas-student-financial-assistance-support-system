<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rate-limit.php';
require_once __DIR__ . '/../includes/includes-email-templates.php';
require_once __DIR__ . '/../includes/includes-student-notification-emails.php';
require_once __DIR__ . '/../includes/includes-email-mailer.php';
require_once __DIR__ . '/../includes/includes-audit.php';
require_once __DIR__ . '/../config/config-env.php';
// Composer autoload (required for Symfony Mailer)
require_once __DIR__ . '/../../vendor/autoload.php';

use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mime\Email;

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

CSRFProtection::validateRequest();

$action = $_POST['action'] ?? '';
$schoolId = trim($_POST['school_id'] ?? '');

if (!in_array($action, ['request_otp', 'reset_password'], true)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    exit;
}

if ($action === 'request_otp') {
    TurnstileVerification::requireValid($_POST['cf-turnstile-response'] ?? '', 'forgot_password');
}

try {
    $user = null;
    $userType = null;

    if ($schoolId) {
        $stmt = $pdo->prepare("SELECT student_id AS id, student_email AS email, student_personal_email, student_first_name AS first, student_last_name AS last, student_role_id AS role_id, student_password_hash AS password_hash, 'student' AS utype FROM tbl_csdl_students WHERE student_school_id = ? AND student_is_active = 1 LIMIT 1");
        $stmt->execute([$schoolId]);
        $user = $stmt->fetch();
        $userType = $user ? 'student' : null;
    }
    if (!$user && $schoolId) {
        $stmt = $pdo->prepare("SELECT employee_id AS id, employee_email AS email, employee_first_name AS first, employee_last_name AS last, employee_role_id AS role_id, employee_password_hash AS password_hash, 'employee' AS utype FROM tbl_csdl_employees WHERE employee_school_id = ? AND employee_status = 1 LIMIT 1");
        $stmt->execute([$schoolId]);
        $user = $stmt->fetch();
        $userType = $user ? 'employee' : null;
    }

    if (!$user) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Account not found']);
        exit;
    }
    
    if ($action === 'request_otp') {
        $rateLimiter = new RateLimiter();
        $sendOtpRate = $rateLimiter->checkRateLimit(
            'forgot_password_otp_send',
            3,
            600,
            $userType === 'student' ? (int)$user['id'] : null,
            $userType === 'employee' ? (int)$user['id'] : null
        );
        if (!$sendOtpRate['allowed']) {
            http_response_code(429);
            echo json_encode(['success' => false, 'message' => 'Too many OTP requests. Please try again later.']);
            exit;
        }

        $mailerConfig = emailMailerCreate('system');
        if ($mailerConfig === null) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Email not configured. Please contact administrator.']);
            exit;
        }

        $studentEmailData = $userType === 'student'
            ? ['student_email' => $user['email'] ?? '', 'student_personal_email' => $user['student_personal_email'] ?? '']
            : ['student_email' => $user['email'] ?? ''];
        if ($userType === 'student' && !studentHasNotificationEmail($studentEmailData)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'No email on file for this account. Please contact support.']);
            exit;
        }
        if ($userType !== 'student' && empty($user['email'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'No email on file for this account. Please contact support.']);
            exit;
        }
        $otpRecipients = $userType === 'student'
            ? getStudentNotificationEmails($studentEmailData)
            : [trim((string)($user['email'] ?? ''))];
        $primaryEmail = $otpRecipients[0] ?? '';

        // Generate OTP and store only its hash (OTP is never stored in plaintext).
        $otp = str_pad(strval(random_int(0, 999999)), 6, '0', STR_PAD_LEFT);
        $otpHash = password_hash($otp, PASSWORD_DEFAULT);

        // Remove old tokens for this account
        if ($userType === 'student') {
            $del = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_student_id = ?");
            $del->execute([$user['id']]);
        } else {
            $del = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_employee_id = ?");
            $del->execute([$user['id']]);
        }

        $ins = $pdo->prepare("INSERT INTO tbl_csdl_password_resets (pr_employee_id, pr_student_id, pr_role_id, pr_email, pr_school_id, pr_otp, pr_expires_at, pr_used, pr_created_at) VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0, NOW())");
        $ins->execute([
            $userType === 'employee' ? $user['id'] : null,
            $userType === 'student' ? $user['id'] : null,
            $user['role_id'] ?? ($userType === 'student' ? 96 : 99),
            $primaryEmail,
            $schoolId,
            $otpHash
        ]);

        $fullName = trim(($user['first'] ?? '') . ' ' . ($user['last'] ?? ''));
        $htmlBody = EmailTemplates::otpEmail($fullName, $otp, $mailerConfig['from_name'], $mailerConfig['support_email']);
        $emailMsg = (new Email())
            ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
            ->subject('Your One-Time Passcode (OTP)')
            ->html($htmlBody);
            EmailTemplates::embedSchoolLogo($emailMsg);
        if ($userType === 'student') {
            applyStudentNotificationRecipients($emailMsg, $studentEmailData);
        } else {
            $emailMsg->to($user['email']);
        }

        try {
            $mailerConfig['mailer']->send($emailMsg);
        } catch (TransportExceptionInterface $e) {
            error_log('Forgot-password OTP email send failed: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Email send failed. Please verify SMTP settings.']);
            exit;
        }

        $otpMessage = ($userType === 'student' && count($otpRecipients) > 1)
            ? 'OTP sent to your school and personal email'
            : 'OTP sent';
        echo json_encode(['success' => true, 'message' => $otpMessage]);
        exit;
    }

    if ($action === 'reset_password') {
        $rateLimiter = new RateLimiter();
        $verifyOtpRate = $rateLimiter->checkRateLimit(
            'forgot_password_otp_verify',
            5,
            600,
            $userType === 'student' ? (int)$user['id'] : null,
            $userType === 'employee' ? (int)$user['id'] : null
        );
        if (!$verifyOtpRate['allowed']) {
            http_response_code(429);
            echo json_encode(['success' => false, 'message' => 'Too many OTP verification attempts. Please try again later.']);
            exit;
        }

        $otp = trim($_POST['otp'] ?? '');
        $newPassword = $_POST['new_password'] ?? '';
        if (!$otp || strlen($otp) !== 6 || !$newPassword) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid data']);
            exit;
        }

        // Get latest OTP record
        if ($userType === 'student') {
            $rst = $pdo->prepare("SELECT pr_id, pr_otp, pr_expires_at, pr_used, (pr_expires_at <= NOW()) AS pr_expired FROM tbl_csdl_password_resets WHERE pr_student_id = ? ORDER BY pr_id DESC LIMIT 1");
            $rst->execute([$user['id']]);
        } else {
            $rst = $pdo->prepare("SELECT pr_id, pr_otp, pr_expires_at, pr_used, (pr_expires_at <= NOW()) AS pr_expired FROM tbl_csdl_password_resets WHERE pr_employee_id = ? ORDER BY pr_id DESC LIMIT 1");
            $rst->execute([$user['id']]);
        }
        $reset = $rst->fetch();
        if (!$reset) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'No OTP found. Please request again.']);
            exit;
        }
        if ((int)$reset['pr_expired'] === 1 || intval($reset['pr_used']) === 1) {
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

        // Validate password strength
        $errors = [];
        if (!InputValidation::validatePassword($newPassword, $errors)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => implode('\n', $errors)]);
            exit;
        }

        if (!empty($user['password_hash']) && password_verify($newPassword, $user['password_hash'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'New password must be different from your current password']);
            exit;
        }

        $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
        if ($userType === 'student') {
            $up = $pdo->prepare("UPDATE tbl_csdl_students SET student_password_hash = ?, student_password_changed_at = NOW(), student_updated_at = NOW() WHERE student_id = ?");
            $up->execute([$newHash, $user['id']]);
        } else {
            $up = $pdo->prepare("UPDATE tbl_csdl_employees SET employee_password_hash = ?, employee_password_changed_at = NOW(), employee_updated_at = NOW() WHERE employee_id = ?");
            $up->execute([$newHash, $user['id']]);
        }

        // Mark token as used
        $updOtp = $pdo->prepare("UPDATE tbl_csdl_password_resets SET pr_used = 1 WHERE pr_id = ?");
        $updOtp->execute([$reset['pr_id']]);
        $rateLimiter->resetRateLimit(
            'forgot_password_otp_verify',
            $userType === 'student' ? (int)$user['id'] : null,
            $userType === 'employee' ? (int)$user['id'] : null
        );

        try {
            AuditLogger::log(
                $pdo,
                'RESET_PASSWORD_SELF_SERVICE',
                'Account holder reset a password using email verification.',
                $userType === 'student' ? (int) $user['id'] : null,
                $userType === 'employee' ? (int) $user['id'] : null
            );
        } catch (Throwable $e) {
            error_log('Self-service password reset audit error: ' . $e->getMessage());
        }
        echo json_encode(['success' => true, 'message' => 'Password reset successful']);
        exit;
    }

} catch (Throwable $e) {
    error_log('Forgot-password error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Server error. Please try again later.'
    ]);
}

?>


