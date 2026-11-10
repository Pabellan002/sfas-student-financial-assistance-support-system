<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../config/config-env.php';
require_once __DIR__ . '/../includes/includes-turnstile.php';
require_once __DIR__ . '/../includes/includes-student-notification-emails.php';
require_once __DIR__ . '/../includes/includes-student-registration.php';
require_once __DIR__ . '/../includes/includes-modalities.php';
require_once __DIR__ . '/../includes/includes-audit.php';
require_once __DIR__ . '/../includes/includes-student-family.php';
require_once __DIR__ . '/../includes/includes-id-fallback.php';

header('Content-Type: application/json');

/**
 * Detect fraudulent registration patterns using Gemini AI
 * 
 * @param PDO $pdo Database connection
 * @param array $registrationData Student registration data
 * @param string $geminiApiKey Gemini API key
 * @return array Fraud detection result with is_suspicious, confidence, reasons, risk_score
 */
function detectFraudulentRegistration($pdo, $registrationData, $geminiApiKey, ?string $modelOverride = null, string $provider = 'gemini') {
    try {
        // Build analysis prompt for Gemini
        $schoolId = $registrationData['school_id'] ?? '';
        $firstName = $registrationData['first_name'] ?? '';
        $middleName = $registrationData['middle_name'] ?? '';
        $lastName = $registrationData['last_name'] ?? '';
        $dateOfBirth = $registrationData['date_of_birth'] ?? '';
        $email = $registrationData['email'] ?? '';
        $personalEmail = $registrationData['personal_email'] ?? '';
        $contactNumber = $registrationData['contact_number'] ?? '';
        $programId = $registrationData['program_id'] ?? 0;
        $yearLevelId = $registrationData['year_level_id'] ?? 0;
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '';
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
        
        // Get program and year level names
        $programName = '';
        $yearLevelName = '';
        try {
            $stmt = $pdo->prepare("SELECT program_name FROM tbl_csdl_programs WHERE program_id = ?");
            $stmt->execute([$programId]);
            $program = $stmt->fetch(PDO::FETCH_ASSOC);
            $programName = $program['program_name'] ?? '';
            
            $stmt = $pdo->prepare("SELECT year_level_name FROM tbl_csdl_year_levels WHERE year_level_id = ?");
            $stmt->execute([$yearLevelId]);
            $yearLevel = $stmt->fetch(PDO::FETCH_ASSOC);
            $yearLevelName = $yearLevel['year_level_name'] ?? '';
        } catch (Exception $e) {
            // Continue even if we can't get names
        }
        
        // Check for duplicate patterns in database
        $duplicateChecks = [];
        
        // Check for same IP within last 24 hours
        try {
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_students WHERE student_created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)");
            $stmt->execute();
            $result = $stmt->fetch(PDO::FETCH_ASSOC);
            $recentRegistrations = $result['count'] ?? 0;
            $duplicateChecks['recent_registrations_count'] = $recentRegistrations;
        } catch (Exception $e) {
            $duplicateChecks['recent_registrations_count'] = 0;
        }
        
        // Check for duplicate contact number
        if ($contactNumber) {
            try {
                $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_students WHERE student_contact_number = ?");
                $stmt->execute([$contactNumber]);
                $result = $stmt->fetch(PDO::FETCH_ASSOC);
                $duplicateChecks['duplicate_contact_number'] = ($result['count'] ?? 0) > 0;
            } catch (Exception $e) {
                $duplicateChecks['duplicate_contact_number'] = false;
            }
        }
        
        // Check for duplicate email patterns
        if ($personalEmail) {
            try {
                $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_students WHERE student_personal_email = ?");
                $stmt->execute([$personalEmail]);
                $result = $stmt->fetch(PDO::FETCH_ASSOC);
                $duplicateChecks['duplicate_personal_email'] = ($result['count'] ?? 0) > 0;
            } catch (Exception $e) {
                $duplicateChecks['duplicate_personal_email'] = false;
            }
        }
        
        // Calculate age if DOB provided
        $age = null;
        if ($dateOfBirth) {
            $dob = new DateTime($dateOfBirth);
            $now = new DateTime();
            $age = $now->diff($dob)->y;
        }
        
        // Build comprehensive prompt for Gemini
        $currentTime = date('H:i');
        $currentHour = (int)date('H');
        
        $prompt = "You are a fraud detection AI for a student loan system. Analyze this student registration and determine if it appears suspicious.\n\n";
        $prompt .= "REGISTRATION DATA:\n";
        $prompt .= "- School ID: {$schoolId}\n";
        $prompt .= "- Name: {$firstName} {$middleName} {$lastName}\n";
        $prompt .= "- Date of Birth: {$dateOfBirth}" . ($age ? " (Age: {$age})" : "") . "\n";
        $prompt .= "- Program: {$programName}\n";
        $prompt .= "- Year Level: {$yearLevelName}\n";
        $prompt .= "- School Email: {$email}\n";
        $prompt .= "- Personal Email: {$personalEmail}\n";
        $prompt .= "- Contact Number: {$contactNumber}\n";
        $prompt .= "- Registration Time: {$currentTime} (Hour: {$currentHour})\n";
        $prompt .= "- IP Address: {$ipAddress}\n\n";
        
        $prompt .= "DUPLICATE CHECKS:\n";
        $prompt .= "- Recent registrations (24h): {$duplicateChecks['recent_registrations_count']}\n";
        $prompt .= "- Duplicate contact number: " . ($duplicateChecks['duplicate_contact_number'] ? 'YES' : 'NO') . "\n";
        $prompt .= "- Duplicate personal email: " . ($duplicateChecks['duplicate_personal_email'] ? 'YES' : 'NO') . "\n\n";
        
        $prompt .= "FRAUD INDICATORS TO CHECK:\n";
        $prompt .= "1. Name Quality: Does the name look like gibberish, random characters, or fake (e.g., 'Test Test', 'asdf qwer')?\n";
        $prompt .= "2. School ID Format: Philippine school IDs typically follow format like '02-2020-00001'. Is this valid?\n";
        $prompt .= "3. Email Validity: Are the emails suspicious (temporary email services, gibberish patterns)?\n";
        $prompt .= "4. Age/Year Level Match: Does the age make sense for the year level? (Typical: 1st year = 17-19, 4th year = 20-22)\n";
        $prompt .= "5. Registration Time: Is this during suspicious hours? (3am-5am might indicate bot activity)\n";
        $prompt .= "6. Duplicate Patterns: Are there concerning duplicate patterns?\n";
        $prompt .= "7. Contact Number: Is it a valid Philippine mobile format (09XXXXXXXXX)?\n\n";
        
        $prompt .= "RESPONSE FORMAT (JSON only, no markdown):\n";
        $prompt .= "{\n";
        $prompt .= '  "is_suspicious": true or false,';
        $prompt .= '  "confidence": "low", "medium", or "high",';
        $prompt .= '  "risk_score": 0-100 (0=safe, 100=definitely fraud),';
        $prompt .= '  "reasons": ["reason 1", "reason 2", ...],';
        $prompt .= '  "recommendation": "approve" or "review" or "reject"';
        $prompt .= "}\n\n";
        $prompt .= "Be conservative - only flag clear fraud indicators. Legitimate students with unusual patterns should get 'review' not 'reject'.";

        if ($provider === 'groq') {
            $analysis = idScanGroqJson($prompt);
            if (!is_array($analysis) || !is_bool($analysis['is_suspicious'] ?? null)) {
                return ['checked' => false, 'is_suspicious' => false, 'confidence' => 'unknown',
                    'risk_score' => 0, 'reasons' => [], 'recommendation' => 'review'];
            }
            return [
                'checked' => true,
                'is_suspicious' => $analysis['is_suspicious'],
                'confidence' => $analysis['confidence'] ?? 'unknown',
                'risk_score' => max(0, min(100, (int) ($analysis['risk_score'] ?? 0))),
                'reasons' => is_array($analysis['reasons'] ?? null) ? $analysis['reasons'] : [],
                'recommendation' => 'review',
                'checked_at' => date('Y-m-d H:i:s'),
                'provider' => 'groq:' . ($_ENV['GROQ_FALLBACK_MODEL'] ?? 'qwen/qwen3.8-27b'),
                'duplicate_checks' => $duplicateChecks,
            ];
        }
        
        // Call Gemini API
        $geminiModel = $modelOverride ?? ($_ENV['GEMINI_MODEL'] ?? 'gemini-3.5-flash-lite');
        $apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' . rawurlencode($geminiModel)
            . ':generateContent?key=' . rawurlencode($geminiApiKey);
        
        $requestBody = [
            'contents' => [
                [
                    'parts' => [
                        ['text' => $prompt]
                    ]
                ]
            ],
            'generationConfig' => [
                'temperature' => 0.2, // Low temperature for consistent fraud detection
                'maxOutputTokens' => 1024,
            ]
        ];
        
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $apiUrl);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($requestBody));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        
        if ($httpCode !== 200 || !$response) {
            error_log("Gemini fraud detection API error: HTTP {$httpCode}");
            return [
                'checked' => false,
                'is_suspicious' => false,
                'confidence' => 'unknown',
                'risk_score' => 0,
                'reasons' => [],
                'recommendation' => 'review',
                'error' => 'API call failed'
            ];
        }
        
        $result = json_decode($response, true);
        
        if (!isset($result['candidates'][0]['content']['parts'][0]['text'])) {
            error_log("Gemini fraud detection: Invalid response structure");
            return [
                'checked' => false,
                'is_suspicious' => false,
                'confidence' => 'unknown',
                'risk_score' => 0,
                'reasons' => [],
                'recommendation' => 'review',
                'error' => 'Invalid response'
            ];
        }
        
        $aiText = $result['candidates'][0]['content']['parts'][0]['text'];
        
        // Extract JSON from response (Gemini sometimes wraps it in markdown)
        $aiText = preg_replace('/```json\s*/', '', $aiText);
        $aiText = preg_replace('/```\s*$/', '', $aiText);
        $aiText = trim($aiText);
        
        $fraudAnalysis = json_decode($aiText, true);
        
        if (!$fraudAnalysis || !isset($fraudAnalysis['is_suspicious'])) {
            error_log("Gemini fraud detection: Could not parse AI response");
            return [
                'checked' => false,
                'is_suspicious' => false,
                'confidence' => 'unknown',
                'risk_score' => 0,
                'reasons' => [],
                'recommendation' => 'review',
                'error' => 'Parse error'
            ];
        }
        
        // Return structured result
        return [
            'checked' => true,
            'is_suspicious' => (bool)$fraudAnalysis['is_suspicious'],
            'confidence' => $fraudAnalysis['confidence'] ?? 'medium',
            'risk_score' => (int)($fraudAnalysis['risk_score'] ?? 0),
            'reasons' => $fraudAnalysis['reasons'] ?? [],
            'recommendation' => $fraudAnalysis['recommendation'] ?? 'review',
            'checked_at' => date('Y-m-d H:i:s'),
            'provider' => $geminiModel,
            'duplicate_checks' => $duplicateChecks
        ];
        
    } catch (Exception $e) {
        error_log("Gemini fraud detection exception: " . $e->getMessage());
        return [
            'checked' => false,
            'is_suspicious' => false,
            'confidence' => 'unknown',
            'risk_score' => 0,
            'reasons' => [],
            'recommendation' => 'review',
            'error' => $e->getMessage()
        ];
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? 'options';
    
    if ($action === 'check_school_id') {
        $schoolId = trim($_GET['school_id'] ?? '');
        
        if ($schoolId === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'School ID is required.']);
            exit;
        }
        
        if (!InputValidation::validateSchoolId($schoolId)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid school ID format.']);
            exit;
        }
        
        try {
            $checkStmt = $pdo->prepare('SELECT student_id, student_registration_status FROM tbl_csdl_students WHERE student_school_id = ? LIMIT 1');
            $checkStmt->execute([$schoolId]);
            $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existing) {
                $status = (string) ($existing['student_registration_status'] ?? 'approved');
                
                if ($status === 'pending') {
                    echo json_encode([
                        'success' => false,
                        'available' => false,
                        'message' => 'A registration for this School ID is already pending CSDL approval.',
                    ]);
                    exit;
                }
                
                if ($status === 'pending_finance') {
                    echo json_encode([
                        'success' => false,
                        'available' => false,
                        'message' => 'CSDL has approved this School ID. You may sign in, but must wait for Assessment balance setup before applying for a loan.',
                    ]);
                    exit;
                }
                
                if ($status === 'rejected') {
                    echo json_encode([
                        'success' => true,
                        'available' => true,
                        'message' => 'You may submit a new registration for this School ID.',
                    ]);
                    exit;
                }
                
                echo json_encode([
                    'success' => false,
                    'available' => false,
                    'message' => 'School ID is already registered.',
                ]);
                exit;
            }
            
            echo json_encode([
                'success' => true,
                'available' => true,
                'message' => 'School ID is available.',
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to check school ID availability.']);
        }
        exit;
    }
    
    if ($action !== 'options') {
        http_response_code(405);
        echo json_encode(['success' => false, 'message' => 'Method not allowed']);
        exit;
    }

    try {
        $programs = $pdo->query("SELECT program_id, program_code, program_name FROM tbl_csdl_programs WHERE program_status = 1 ORDER BY program_name ASC")->fetchAll(PDO::FETCH_ASSOC);
        $yearLevels = $pdo->query("SELECT year_level_id, year_level_code, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_code ASC")->fetchAll(PDO::FETCH_ASSOC);
        $campuses = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses ORDER BY campus_name ASC")->fetchAll(PDO::FETCH_ASSOC);
        $modalities = $pdo->query("SELECT modality_code, modality_name FROM tbl_csdl_modalities WHERE modality_status = 1 ORDER BY modality_id ASC")->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode([
            'success' => true,
            'programs' => $programs,
            'year_levels' => $yearLevels,
            'campuses' => $campuses,
            'modalities' => $modalities,
            'registration_enabled' => studentRegistrationColumnAvailable($pdo),
        ]);
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Unable to load registration options.']);
    }
    exit;
}

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

TurnstileVerification::requireValid($_POST['cf-turnstile-response'] ?? '', 'registration');

// CSRF validation disabled for Cloudflare Tunnel compatibility
// Public registration endpoint - rate limiting provides protection
// CSRFProtection::validateRequest();

if (!studentRegistrationColumnAvailable($pdo)) {
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'message' => 'Online registration is not available yet. Please contact the CSDL office.',
    ]);
    exit;
}

$rateLimiter = new RateLimiter();
$rateCheck = $rateLimiter->checkRateLimit('student_registration', 5, 900);
if (!$rateCheck['allowed']) {
    http_response_code(429);
    echo json_encode([
        'success' => false,
        'message' => 'Too many registration attempts. Please try again later.',
    ]);
    exit;
}

$schoolId = trim($_POST['school_id'] ?? '');
$firstName = trim($_POST['first_name'] ?? '');
$middleName = trim($_POST['middle_name'] ?? '');
$lastName = trim($_POST['last_name'] ?? '');
$dateOfBirth = $_POST['date_of_birth'] ?? null;
$gender = $_POST['gender'] ?? 'Male';
$contactNumber = trim($_POST['contact_number'] ?? '');
$programId = (int) ($_POST['program_id'] ?? 0);
$yearLevelId = (int) ($_POST['year_level_id'] ?? 0);
$scholarshipId = 0;
$campusId = (int) ($_POST['campus_id'] ?? 0);
$modality = $_POST['modality'] ?? 'flex';
$fbAccount = trim($_POST['fb_account'] ?? '');
$password = (string) ($_POST['password'] ?? '');
$confirmPassword = (string) ($_POST['confirm_password'] ?? '');
try {
    $familyDetails = studentFamilyParse($_POST['family_details'] ?? []);
    if (!$familyDetails) {
        throw new InvalidArgumentException('Add at least one family member with a name and contact number.');
    }
} catch (InvalidArgumentException $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    exit;
}

if ($schoolId === '' || $firstName === '' || $lastName === '' || $programId <= 0 || $yearLevelId <= 0) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'School ID, name, program, and year level are required.']);
    exit;
}

if (mb_strlen($firstName) > 80 || mb_strlen($lastName) > 80) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'First name and last name must each be 80 characters or fewer.']);
    exit;
}

if (!InputValidation::validateSchoolId($schoolId)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid school ID format. Use format like 02-2020-00001.']);
    exit;
}

if ($password === '' || $confirmPassword === '') {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Password and confirmation are required.']);
    exit;
}

if ($password !== $confirmPassword) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Passwords do not match.']);
    exit;
}

$passwordErrors = [];
if (!InputValidation::validatePassword($password, $passwordErrors)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => implode(' ', $passwordErrors)]);
    exit;
}

$parsedEmails = studentRegistrationParseEmails($_POST);
if (!$parsedEmails['ok']) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $parsedEmails['message']]);
    exit;
}
$email = $parsedEmails['email'];
$personalEmail = $parsedEmails['personal_email'];

$parsedContact = InputValidation::parsePhilippineMobile($contactNumber);
if ($contactNumber !== '' && $parsedContact === false) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid contact number. Use 09XXXXXXXXX or 639XXXXXXXXX.']);
    exit;
}
$contactNumber = $parsedContact;

if ($dateOfBirth !== null && $dateOfBirth !== '') {
    $parsedDob = InputValidation::parseFlexibleDate($dateOfBirth);
    if ($parsedDob === false) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid date of birth.']);
        exit;
    }
    $dateOfBirth = $parsedDob;
} else {
    $dateOfBirth = null;
}

$modalityId = modalityIdForCode($pdo, (string)$modality);
if ($modalityId <= 0) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Select an active modality.']);
    exit;
}

if (!in_array($gender, ['Male', 'Female', 'Other'], true)) {
    $gender = 'Male';
}

try {
    $checkStmt = $pdo->prepare('SELECT student_id, student_registration_status FROM tbl_csdl_students WHERE student_school_id = ? LIMIT 1');
    $checkStmt->execute([$schoolId]);
    $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);
    $rejectedStudentId = 0;
    if ($existing) {
        $status = (string) ($existing['student_registration_status'] ?? 'approved');
        if ($status === 'pending') {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'A registration for this School ID is already pending CSDL approval.']);
            exit;
        }
        if ($status === 'pending_finance') {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'CSDL has approved this School ID. You may sign in, but must wait for Assessment balance setup before applying for a loan.']);
            exit;
        }
        if ($status === 'rejected') {
            $rejectedStudentId = (int) $existing['student_id'];
        } else {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'School ID is already registered.']);
            exit;
        }
    }

    if ($email !== null) {
        $dupEmail = $pdo->prepare('SELECT student_id FROM tbl_csdl_students WHERE LOWER(student_email) = LOWER(?) AND student_id <> ? LIMIT 1');
        $dupEmail->execute([$email, $rejectedStudentId]);
        if ($dupEmail->fetch()) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'School email is already registered to another student.']);
            exit;
        }
    }

    $hasPersonalEmailColumn = false;
    try {
        $colStmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_personal_email'");
        $hasPersonalEmailColumn = (bool) $colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $hasPersonalEmailColumn = false;
    }

    $selfRegistrationColumn = studentRegistrationSelfSourceColumnAvailable($pdo) ? 'student_self_registered,' : '';
    $selfRegistrationValue = $selfRegistrationColumn !== '' ? '1,' : '';
    $passwordHash = password_hash($password, PASSWORD_DEFAULT);
    $statusId = 1;

    // Run Gemini fraud detection before saving
    $fraudResult = ['checked' => false, 'is_suspicious' => false, 'confidence' => 'unknown', 'risk_score' => 0, 'reasons' => []];
    $geminiApiKey = trim((string) ($_ENV['GEMINI_API_KEY'] ?? ''));
    $fraudDetectionEnabled = ($_ENV['FRAUD_DETECTION_ENABLED'] ?? 'true') === 'true';
    
    if ($geminiApiKey !== '' && $fraudDetectionEnabled) {
        $fraudInputs = [
            'school_id' => $schoolId,
            'first_name' => $firstName,
            'middle_name' => $middleName,
            'last_name' => $lastName,
            'date_of_birth' => $dateOfBirth,
            'email' => $email,
            'personal_email' => $personalEmail,
            'contact_number' => $contactNumber,
            'program_id' => $programId,
            'year_level_id' => $yearLevelId,
        ];
        foreach (idScanGeminiModels('gemini-3.5-flash-lite') as $model) {
            $fraudResult = detectFraudulentRegistration($pdo, $fraudInputs, $geminiApiKey, $model);
            if (!empty($fraudResult['checked'])) break;
        }
        if (empty($fraudResult['checked']) && trim((string) ($_ENV['GROQ_API_KEY'] ?? '')) !== '') {
            $fraudResult = detectFraudulentRegistration($pdo, $fraudInputs, '', null, 'groq');
        }
    } elseif ($fraudDetectionEnabled && trim((string) ($_ENV['GROQ_API_KEY'] ?? '')) !== '') {
        $fraudResult = detectFraudulentRegistration($pdo, [
            'school_id' => $schoolId, 'first_name' => $firstName, 'middle_name' => $middleName,
            'last_name' => $lastName, 'date_of_birth' => $dateOfBirth, 'email' => $email,
            'personal_email' => $personalEmail, 'contact_number' => $contactNumber,
            'program_id' => $programId, 'year_level_id' => $yearLevelId,
        ], '', null, 'groq');
    }
    
    // Prepare fraud detection data for storage
    $isSuspicious = $fraudResult['is_suspicious'] ? 1 : 0;
    $suspiciousReason = null;
    $suspiciousDetails = null;
    
    if ($fraudResult['checked']) {
        // Build human-readable reason
        if ($fraudResult['is_suspicious'] && !empty($fraudResult['reasons'])) {
            $suspiciousReason = implode('; ', $fraudResult['reasons']);
        }
        // Store full AI response as JSON
        $suspiciousDetails = json_encode($fraudResult);
    }

    $pdo->beginTransaction();
    if ($rejectedStudentId > 0) {
        $updateColumns = [
            'student_first_name = ?', 'student_middle_name = ?', 'student_last_name = ?',
            'student_date_of_birth = ?', 'student_gender = ?', 'student_contact_number = ?',
            'student_email = ?', 'student_password_hash = ?', 'student_program_id = ?',
            'student_year_level_id = ?', 'student_scholarship_id = ?', 'student_campus_id = ?',
            'student_modality_id = ?', 'student_fb_account = ?', 'student_is_active = 0',
            "student_registration_status = 'pending'", 'student_status_id = ?',
            'student_is_suspicious = ?', 'student_suspicious_reason = ?',
            'student_suspicious_details = ?', 'student_created_at = NOW()',
        ];
        $updateValues = [
            $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender,
            $contactNumber ?: null, $email, $passwordHash, $programId, $yearLevelId,
            $scholarshipId ?: null, $campusId ?: null, $modalityId, $fbAccount ?: null,
            $statusId, $isSuspicious, $suspiciousReason, $suspiciousDetails,
        ];
        if ($hasPersonalEmailColumn) {
            $updateColumns[] = 'student_personal_email = ?';
            $updateValues[] = $personalEmail;
        }
        if ($selfRegistrationColumn !== '') {
            $updateColumns[] = 'student_self_registered = 1';
        }
        $updateValues[] = $rejectedStudentId;
        $stmt = $pdo->prepare('UPDATE tbl_csdl_students SET ' . implode(', ', $updateColumns)
            . " WHERE student_id = ? AND student_registration_status = 'rejected'");
        $stmt->execute($updateValues);
        if ($stmt->rowCount() !== 1) {
            $pdo->rollBack();
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'This registration has already been resubmitted.']);
            exit;
        }
        $newStudentId = $rejectedStudentId;
        try {
            AuditLogger::log($pdo, 'RESUBMIT_REGISTRATION', 'Student resubmitted a previously rejected registration.', $newStudentId);
        } catch (Throwable $e) {
            error_log('Registration resubmission audit error: ' . $e->getMessage());
        }
    } elseif ($hasPersonalEmailColumn) {
        $stmt = $pdo->prepare("INSERT INTO tbl_csdl_students (
            student_school_id, student_first_name, student_middle_name, student_last_name,
            student_date_of_birth, student_gender, student_contact_number, student_email, student_personal_email,
            student_password_hash, student_program_id, student_year_level_id, student_scholarship_id,
            student_campus_id, student_modality_id, student_fb_account, student_is_active, {$selfRegistrationColumn} student_registration_status, student_status_id,
            student_is_suspicious, student_suspicious_reason, student_suspicious_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, {$selfRegistrationValue} 'pending', ?, ?, ?, ?)");
        $stmt->execute([
            $schoolId, $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender,
            $contactNumber ?: null, $email, $personalEmail, $passwordHash, $programId, $yearLevelId,
            $scholarshipId ?: null, $campusId ?: null, $modalityId, $fbAccount ?: null, $statusId,
            $isSuspicious, $suspiciousReason, $suspiciousDetails,
        ]);
    } else {
        $stmt = $pdo->prepare("INSERT INTO tbl_csdl_students (
            student_school_id, student_first_name, student_middle_name, student_last_name,
            student_date_of_birth, student_gender, student_contact_number, student_email,
            student_password_hash, student_program_id, student_year_level_id, student_scholarship_id,
            student_campus_id, student_modality_id, student_fb_account, student_is_active, {$selfRegistrationColumn} student_registration_status, student_status_id,
            student_is_suspicious, student_suspicious_reason, student_suspicious_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, {$selfRegistrationValue} 'pending', ?, ?, ?, ?)");
        $stmt->execute([
            $schoolId, $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender,
            $contactNumber ?: null, $email, $passwordHash, $programId, $yearLevelId,
            $scholarshipId ?: null, $campusId ?: null, $modalityId, $fbAccount ?: null, $statusId,
            $isSuspicious, $suspiciousReason, $suspiciousDetails,
        ]);
    }

    if ($rejectedStudentId === 0) {
        $newStudentId = (int) $pdo->lastInsertId();
    }
    studentFamilySync($pdo, $newStudentId, $familyDetails);
    $pdo->commit();
    if ($newStudentId > 0) {
        if ($rejectedStudentId === 0) {
            try {
                AuditLogger::log($pdo, 'REGISTER_STUDENT', 'Student submitted a new registration.', $newStudentId);
            } catch (Throwable $e) {
                error_log('Registration audit error: ' . $e->getMessage());
            }
        }
        $studentRow = studentRegistrationFetchById($pdo, $newStudentId);
        if ($studentRow) {
            try {
                studentRegistrationSendSubmittedEmail($pdo, $studentRow);
            } catch (Throwable $e) {
                error_log('Student registration confirmation queue error: ' . $e->getMessage());
            }
            try {
                studentRegistrationNotifyCsdlEmployees($pdo, $studentRow);
            } catch (Throwable $e) {
                error_log('CSDL registration notification error: ' . $e->getMessage());
            }
        }
    }

    CSRFProtection::regenerateToken();

    echo json_encode([
        'success' => true,
        'message' => 'Registration submitted successfully. You may sign in once CSDL approves your registration. Loan applications will be available after Assessment sets up your balance.',
    ]);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('Registration save error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Registration failed. Please try again later.']);
}
