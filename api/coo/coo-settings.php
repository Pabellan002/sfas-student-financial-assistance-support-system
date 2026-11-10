<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';

use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mime\Email;

header('Content-Type: application/json');

if (!isset($_SESSION['user_id'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$userRoleId = $_SESSION['user_role_id'] ?? 0;
// Allow COO (97) and other employee roles since all use same table
$allowedRoles = [97, 98, 99, 100, 101];
if (!in_array($userRoleId, $allowedRoles)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Forbidden: Employee access required', 'role_id' => $userRoleId]);
    exit;
}

$employeeId = $_SESSION['user_id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';

    if ($action === 'profile') {
        try {
            $stmt = $pdo->prepare("SELECT employee_id, employee_school_id, employee_first_name, employee_middle_name, employee_last_name, employee_date_of_birth, employee_gender, employee_contact_number, employee_email, employee_profile_image FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1");
            $stmt->execute([$employeeId]);
            $profile = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$profile) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Profile not found']);
                exit;
            }

            echo json_encode(['success' => true, 'profile' => $profile]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching profile']);
        }
        exit;
    }
    
    if ($action === 'get_info') {
        try {
            $stmt = $pdo->prepare("SELECT employee_id, employee_school_id, employee_first_name, employee_middle_name, employee_last_name, employee_date_of_birth, employee_gender, employee_contact_number, employee_email, employee_profile_image FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1");
            $stmt->execute([$employeeId]);
            $employee = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$employee) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Employee not found']);
                exit;
            }
            
            echo json_encode(['success' => true, 'employee' => $employee]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching employee information']);
        }
        exit;
    }

    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    require_once __DIR__ . '/../includes/includes-csrf.php';
    require_once __DIR__ . '/../includes/includes-input-validation.php';
    require_once __DIR__ . '/../includes/includes-rate-limit.php';
    require_once __DIR__ . '/../includes/includes-email-templates.php';
    require_once __DIR__ . '/../includes/includes-email-mailer.php';
    require_once __DIR__ . '/../config/config-env.php';
    require_once __DIR__ . '/../../vendor/autoload.php';
    
    // Handle both JSON and FormData (for file uploads)
    $input = [];
    if (!empty($_POST)) {
        $input = $_POST;
    } else {
        $json = file_get_contents('php://input');
        $input = json_decode($json, true) ?? [];
    }
    $_POST = array_merge($_POST, $input);
    
    // Validate CSRF token
    try {
        CSRFProtection::validateRequest();
    } catch (Exception $e) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'CSRF validation failed.']);
        exit;
    }
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'send_otp') {
        TurnstileVerification::requireValid($_POST['cf-turnstile-response'] ?? '', 'profile_update');
        try {
            $rateLimiter = new RateLimiter();
            $sendOtpRate = $rateLimiter->checkRateLimit('employee_profile_otp_send', 3, 600, null, (int)$employeeId);
            if (!$sendOtpRate['allowed']) {
                http_response_code(429);
                echo json_encode(['success' => false, 'message' => 'Too many OTP requests. Please try again later.']);
                exit;
            }

            // Get employee email and info
            $stmt = $pdo->prepare("SELECT employee_email, employee_school_id, employee_first_name, employee_last_name, employee_role_id FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1");
            $stmt->execute([$employeeId]);
            $employee = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$employee || empty($employee['employee_email'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'No email on file. Please contact support.']);
                exit;
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
            
            $mailerConfig = emailMailerCreate('system');
            if ($mailerConfig === null) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Email not configured. Please contact administrator.']);
                exit;
            }
            
            // Generate OTP and store only its hash (OTP is never stored in plaintext).
            $otp = str_pad(strval(random_int(0, 999999)), 6, '0', STR_PAD_LEFT);
            $otpHash = password_hash($otp, PASSWORD_DEFAULT);
            
            // Store profile image path in session for later use
            $_SESSION['otp_profile_image'] = $profileImagePath;
            
            // Remove old tokens for this employee
            $del = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_employee_id = ?");
            $del->execute([$employeeId]);
            
            // Insert new OTP
            $ins = $pdo->prepare("INSERT INTO tbl_csdl_password_resets (pr_employee_id, pr_role_id, pr_email, pr_school_id, pr_otp, pr_expires_at, pr_used, pr_created_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0, NOW())");
            $ins->execute([
                $employeeId,
                $employee['employee_role_id'] ?? 97,
                $employee['employee_email'],
                $employee['employee_school_id'],
                $otpHash
            ]);
            
            // Account verification OTPs come from the system mailbox.
            $fullName = trim(($employee['employee_first_name'] ?? '') . ' ' . ($employee['employee_last_name'] ?? ''));
            $htmlBody = EmailTemplates::otpEmail($fullName, $otp, $mailerConfig['from_name'], $mailerConfig['support_email']);
            $emailMsg = (new Email())
                ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
                ->to($employee['employee_email'])
                ->subject('Your One-Time Passcode (OTP) - Contact Update')
                ->html($htmlBody);
            EmailTemplates::embedSchoolLogo($emailMsg);
            
            try {
                $mailerConfig['mailer']->send($emailMsg);
            } catch (TransportExceptionInterface $e) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Email send failed. Please verify SMTP settings.']);
                exit;
            }
            
            echo json_encode(['success' => true, 'message' => 'OTP sent to your email. Please check your inbox.']);
            exit;
            
        } catch (Throwable $e) {
            error_log('Send OTP error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error sending OTP. Please try again.']);
            exit;
        }
    }
    
    if ($action === 'update_contact') {
        try {
            $rateLimiter = new RateLimiter();
            $verifyOtpRate = $rateLimiter->checkRateLimit('employee_profile_otp_verify', 5, 600, null, (int)$employeeId);
            if (!$verifyOtpRate['allowed']) {
                http_response_code(429);
                echo json_encode(['success' => false, 'message' => 'Too many OTP verification attempts. Please try again later.']);
                exit;
            }

            $otp = trim($_POST['otp'] ?? '');
            $dateOfBirth = $_POST['date_of_birth'] ?? null;
            $gender = $_POST['gender'] ?? '';
            $email = trim($_POST['email'] ?? '');
            $contactNumber = trim($_POST['contact_number'] ?? '');
            
            if (!$otp || strlen($otp) !== 6) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid OTP.']);
                exit;
            }
            
            // Verify OTP
            $rst = $pdo->prepare("SELECT pr_id, pr_otp, pr_expires_at, pr_used, (pr_expires_at <= NOW()) AS pr_expired FROM tbl_csdl_password_resets WHERE pr_employee_id = ? ORDER BY pr_id DESC LIMIT 1");
            $rst->execute([$employeeId]);
            $reset = $rst->fetch(PDO::FETCH_ASSOC);
            
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
            
            // Validate email
            if (empty($email) || !InputValidation::validateEmail($email)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid email address']);
                exit;
            }
            
            // Validate contact number (11 digits, starts with 09)
            if (empty($contactNumber) || !InputValidation::validatePhone($contactNumber)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid contact number. Must be 11 digits starting with 09']);
                exit;
            }
            
            // Validate gender
            if (!empty($gender) && !in_array($gender, ['Male', 'Female', 'Other'], true)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid gender value.']);
                exit;
            }
            
            // Get profile image path from session if it was uploaded
            $profileImagePath = $_SESSION['otp_profile_image'] ?? null;
            
            // Update employee contact information with or without image
            if ($profileImagePath) {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_employees SET 
                    employee_date_of_birth = ?,
                    employee_gender = ?,
                    employee_email = ?, 
                    employee_contact_number = ?,
                    employee_profile_image = ?,
                    employee_updated_at = NOW() 
                    WHERE employee_id = ? AND employee_status = 1");
                $stmt->execute([
                    !empty($dateOfBirth) ? $dateOfBirth : null,
                    !empty($gender) ? $gender : null,
                    $email, 
                    $contactNumber,
                    $profileImagePath,
                    $employeeId
                ]);
            } else {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_employees SET 
                    employee_date_of_birth = ?,
                    employee_gender = ?,
                    employee_email = ?, 
                    employee_contact_number = ?, 
                    employee_updated_at = NOW() 
                    WHERE employee_id = ? AND employee_status = 1");
                $stmt->execute([
                    !empty($dateOfBirth) ? $dateOfBirth : null,
                    !empty($gender) ? $gender : null,
                    $email, 
                    $contactNumber, 
                    $employeeId
                ]);
            }
            
            // Clear profile image from session
            unset($_SESSION['otp_profile_image']);
            
            // Mark OTP as used
            $updOtp = $pdo->prepare("UPDATE tbl_csdl_password_resets SET pr_used = 1 WHERE pr_id = ?");
            $updOtp->execute([$reset['pr_id']]);

            // Reset OTP verification limiter on success.
            $rateLimiter->resetRateLimit('employee_profile_otp_verify', null, (int)$employeeId);
            
            echo json_encode(['success' => true, 'message' => 'Contact information updated successfully']);
        } catch (Throwable $e) {
            error_log('Update contact error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error updating contact information']);
        }
        exit;
    }

    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
?>
