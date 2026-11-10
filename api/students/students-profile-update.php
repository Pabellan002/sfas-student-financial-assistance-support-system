<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-input-validation.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-rate-limit.php';
require_once __DIR__ . '/../includes/includes-email-templates.php';
require_once __DIR__ . '/../includes/includes-student-notification-emails.php';
require_once __DIR__ . '/../includes/includes-email-mailer.php';
require_once __DIR__ . '/../includes/includes-audit.php';
require_once __DIR__ . '/../config/config-env.php';
require_once __DIR__ . '/../../vendor/autoload.php';

use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mime\Email;

header('Content-Type: application/json');

// Check if user is a student
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$studentId = $_SESSION['user_id'];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Handle file upload separately (FormData doesn't work with json_decode)
    $hasFileUpload = isset($_FILES['profile_image']) && $_FILES['profile_image']['error'] === UPLOAD_ERR_OK;
    
    $input = [];
    if (!$hasFileUpload) {
        if (!empty($_POST)) {
            $input = $_POST;
        } else {
            $json = file_get_contents('php://input');
            $input = json_decode($json, true) ?? [];
        }
        $_POST = array_merge($_POST, $input);
    }
    
    // Validate CSRF token
    try {
        CSRFProtection::validateRequest();
    } catch (Exception $e) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'CSRF validation failed']);
        exit;
    }
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'send_otp') {
        TurnstileVerification::requireValid($_POST['cf-turnstile-response'] ?? '', 'profile_update');
        try {
            $rateLimiter = new RateLimiter();
            $sendOtpRate = $rateLimiter->checkRateLimit('student_profile_otp_send', 3, 600, (int)$studentId, null);
            if (!$sendOtpRate['allowed']) {
                http_response_code(429);
                echo json_encode(['success' => false, 'message' => 'Too many OTP requests. Please try again later.']);
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
                    http_response_code(400);
                    if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                        $uploadMessage = 'Invalid file type. Only JPG and PNG are allowed.';
                    }
                    echo json_encode(['success' => false, 'message' => $uploadMessage]);
                    exit;
                }
                
                // Create upload directory if it doesn't exist
                $uploadDir = __DIR__ . '/../../uploads/profiles/';
                if (!is_dir($uploadDir)) {
                    mkdir($uploadDir, 0755, true);
                }
                
                // Generate unique filename
                $fileExt = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
                $fileName = 'student_' . $studentId . '_' . time() . '.' . $fileExt;
                $filePath = $uploadDir . $fileName;
                
                // Move uploaded file
                if (!move_uploaded_file($file['tmp_name'], $filePath)) {
                    http_response_code(500);
                    echo json_encode(['success' => false, 'message' => 'Failed to upload profile image.']);
                    exit;
                }
                
                // Store relative path
                $profileImagePath = 'uploads/profiles/' . $fileName;
            }
            
            // Store profile image path in session for later use
            if ($profileImagePath) {
                $_SESSION['pending_profile_image'] = $profileImagePath;
            }
            
            // Get student email and info
            $stmt = $pdo->prepare("SELECT student_email, student_personal_email, student_school_id, student_first_name, student_last_name, COALESCE(student_role_id, 96) as student_role_id FROM tbl_csdl_students WHERE student_id = ?");
            $stmt->execute([$studentId]);
            $student = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$student || !studentHasNotificationEmail($student)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'No email on file. Please contact support.']);
                exit;
            }
            $otpRecipients = getStudentNotificationEmails($student);
            $primaryEmail = $otpRecipients[0];
            
            $mailerConfig = emailMailerCreate('system');
            if ($mailerConfig === null) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Email not configured. Please contact administrator.']);
                exit;
            }
            
            // Generate OTP and store only its hash.
            $otp = str_pad(strval(random_int(0, 999999)), 6, '0', STR_PAD_LEFT);
            $otpHash = password_hash($otp, PASSWORD_DEFAULT);
            $_SESSION['student_profile_otp_hash'] = $otpHash;
            
            // Remove old tokens for this student
            $del = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_student_id = ?");
            $del->execute([$studentId]);
            
            // Insert new OTP
            $ins = $pdo->prepare("INSERT INTO tbl_csdl_password_resets (pr_student_id, pr_role_id, pr_email, pr_school_id, pr_otp, pr_expires_at, pr_used, pr_created_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0, NOW())");
            $ins->execute([
                $studentId,
                $student['student_role_id'] ?? 96,
                $primaryEmail,
                $student['student_school_id'],
                $otpHash
            ]);
            
            // Send email
            $fullName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
            $htmlBody = EmailTemplates::otpEmail($fullName, $otp, $mailerConfig['from_name'], $mailerConfig['support_email']);
            $emailMsg = (new Email())
                ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
                ->subject('Your One-Time Passcode (OTP) - Profile Update')
                ->html($htmlBody);
            EmailTemplates::embedSchoolLogo($emailMsg);
            applyStudentNotificationRecipients($emailMsg, $student);
            
            try {
                $mailerConfig['mailer']->send($emailMsg);
            } catch (TransportExceptionInterface $e) {
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Email send failed. Please verify SMTP settings.']);
                exit;
            }
            
            $otpMessage = count($otpRecipients) > 1
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
    
    if ($action === 'update_profile') {
        try {
            $rateLimiter = new RateLimiter();
            $verifyOtpRate = $rateLimiter->checkRateLimit('student_profile_otp_verify', 5, 600, (int)$studentId, null);
            if (!$verifyOtpRate['allowed']) {
                http_response_code(429);
                echo json_encode(['success' => false, 'message' => 'Too many OTP verification attempts. Please try again later.']);
                exit;
            }

            $otp = trim($_POST['otp'] ?? '');
            $firstName = trim($_POST['first_name'] ?? '');
            $middleName = trim($_POST['middle_name'] ?? '');
            $lastName = trim($_POST['last_name'] ?? '');
            $dateOfBirth = $_POST['date_of_birth'] ?? null;
            $gender = $_POST['gender'] ?? '';
            $contactNumber = trim($_POST['contact_number'] ?? '');
            $personalEmailRaw = trim($_POST['personal_email'] ?? '');

            $personalEmail = null;
            if ($personalEmailRaw !== '') {
                $validPersonal = InputValidation::validateEmail($personalEmailRaw);
                if (!$validPersonal) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid personal email format.']);
                    exit;
                }
                if (str_ends_with(strtolower($validPersonal), InputValidation::PHINMAED_DOMAIN)) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Personal email cannot be a @phinmaed.com address. Use School Email for that.']);
                    exit;
                }
                $personalEmail = $validPersonal;
            }
            
            // Validate required fields
            if (empty($firstName) || empty($lastName)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'First name and last name are required.']);
                exit;
            }
            
            if (!$otp || strlen($otp) !== 6) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid OTP.']);
                exit;
            }
            
            // Verify OTP
            $rst = $pdo->prepare("SELECT pr_id, pr_otp, pr_expires_at, pr_used, (pr_expires_at <= NOW()) AS pr_expired FROM tbl_csdl_password_resets WHERE pr_student_id = ? ORDER BY pr_id DESC LIMIT 1");
            $rst->execute([$studentId]);
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
            
            $sessionOtpHash = (string)($_SESSION['student_profile_otp_hash'] ?? '');
            if ($sessionOtpHash !== '') {
                $otpValid = password_verify($otp, $sessionOtpHash);
            } else {
                // Fallback for sessions that were reset between send and verify.
                $storedOtp = (string)($reset['pr_otp'] ?? '');
                $otpValid = password_verify($otp, $storedOtp);
            }
            if (!$otpValid) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid OTP.']);
                exit;
            }
            
            // Validate phone if provided
            if (!empty($contactNumber) && !InputValidation::validatePhone($contactNumber)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid contact number format.']);
                exit;
            }
            
            // Validate gender
            if (!empty($gender) && !in_array($gender, ['Male', 'Female', 'Other'], true)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid gender value.']);
                exit;
            }
            
            // Get profile image path from session if it was uploaded
            $profileImagePath = $_SESSION['pending_profile_image'] ?? null;
            
            // Update profile (school email is not editable by students)
            if ($profileImagePath) {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_students SET 
                    student_first_name = ?,
                    student_middle_name = ?,
                    student_last_name = ?,
                    student_date_of_birth = ?,
                    student_gender = ?,
                    student_contact_number = ?,
                    student_personal_email = ?,
                    student_profile_image = ?,
                    student_updated_at = NOW()
                    WHERE student_id = ?");
                $stmt->execute([
                    $firstName,
                    !empty($middleName) ? $middleName : null,
                    $lastName,
                    !empty($dateOfBirth) ? $dateOfBirth : null,
                    !empty($gender) ? $gender : null,
                    !empty($contactNumber) ? $contactNumber : null,
                    $personalEmail,
                    $profileImagePath,
                    $studentId
                ]);
                
                // Clear pending profile image from session
                unset($_SESSION['pending_profile_image']);
            } else {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_students SET 
                    student_first_name = ?,
                    student_middle_name = ?,
                    student_last_name = ?,
                    student_date_of_birth = ?,
                    student_gender = ?,
                    student_contact_number = ?,
                    student_personal_email = ?,
                    student_updated_at = NOW()
                    WHERE student_id = ?");
                $stmt->execute([
                    $firstName,
                    !empty($middleName) ? $middleName : null,
                    $lastName,
                    !empty($dateOfBirth) ? $dateOfBirth : null,
                    !empty($gender) ? $gender : null,
                    !empty($contactNumber) ? $contactNumber : null,
                    $personalEmail,
                    $studentId
                ]);
            }
            
            // Mark OTP as used
            $updOtp = $pdo->prepare("UPDATE tbl_csdl_password_resets SET pr_used = 1 WHERE pr_id = ?");
            $updOtp->execute([$reset['pr_id']]);
            unset($_SESSION['student_profile_otp_hash']);

            // Reset OTP verification rate limit after a successful verification.
            $rateLimiter->resetRateLimit('student_profile_otp_verify', (int)$studentId, null);
            
            // Log audit
            AuditLogger::log($pdo, 'UPDATE_PROFILE', json_encode([
                'field' => 'profile',
                'student_id' => $studentId
            ]), $studentId);
            
            echo json_encode(['success' => true, 'message' => 'Profile updated successfully.']);
            exit;
            
        } catch (Throwable $e) {
            error_log('Profile update error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error updating profile. Please try again.']);
            exit;
        }
    }
    
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
?>

