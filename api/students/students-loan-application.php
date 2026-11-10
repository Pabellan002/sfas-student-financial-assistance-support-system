<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-input-validation.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-email-templates.php';
require_once __DIR__ . '/../includes/includes-guardian-id-screening.php';
require_once __DIR__ . '/../includes/includes-student-family.php';

header('Content-Type: application/json');

function saveGuardianIdReview(PDO $pdo, int $loanId, int $documentId, ?array $reviewReceipt): void
{
    // Reapplication supersedes any earlier pending scan for this loan.
    $clear = $pdo->prepare("DELETE r FROM tbl_csdl_loan_document_reviews r
        JOIN tbl_csdl_loan_documents d ON d.loan_document_id = r.review_document_id
        WHERE d.loan_document_loan_id = ? AND (r.review_status = 'pending' OR r.review_document_id = ?)");
    $clear->execute([$loanId, $documentId]);
    if ($reviewReceipt === null) return;
    $screening = $reviewReceipt['screening'] ?? [];
    $evidence = [
        'visible_holder_name' => $screening['visible_holder_name'] ?? null,
        'visible_document_label' => $screening['visible_document_label'] ?? null,
        'name_matches' => $screening['name_matches'] ?? null,
        'holder_matches_student' => $screening['holder_matches_student'] ?? null,
        'document_type_matches' => $screening['document_type_matches'] ?? null,
        'image_quality' => $screening['image_quality'] ?? 'unclear',
        'template_or_sample' => $screening['template_or_sample'] ?? 'unclear',
    ];
    $insert = $pdo->prepare("INSERT INTO tbl_csdl_loan_document_reviews
        (review_document_id, review_status, review_provider, review_evidence_json)
        VALUES (?, 'pending', ?, ?)");
    $provider = in_array($reviewReceipt['provider'] ?? '', ['groq', 'ocr_space'], true)
        ? $reviewReceipt['provider'] : 'ocr_review';
    $insert->execute([$documentId, $provider, json_encode($evidence, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)]);
}

// Check if user is a student
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$studentId = (int) $_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    handleGetFormData($pdo, $studentId);
    exit;
}

if ($method === 'POST') {
    CSRFProtection::validateRequest();
    handleSubmitApplication($pdo, $studentId);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
exit;

/**
 * After echoing JSON, flush output so the client gets an immediate response.
 * PHP-FPM: fastcgi_finish_request(). Apache mod_php: end output buffers + flush.
 */
function flush_loan_submission_response_and_continue(): void {
    if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
        return;
    }
    while (ob_get_level() > 0) {
        ob_end_flush();
    }
    flush();
}

/** Balance setup is separate from permission to sign in. Check again on every submission. */
function studentLoanEligibility(PDO $pdo, int $studentId): array {
    $stmt = $pdo->prepare("SELECT student_is_active, student_registration_status,
        EXISTS (SELECT 1 FROM tbl_csdl_balances WHERE balance_student_id = s.student_id) AS has_balance
        FROM tbl_csdl_students s WHERE student_id = ? LIMIT 1");
    $stmt->execute([$studentId]);
    $student = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$student || (int) $student['student_is_active'] !== 1
        || !in_array($student['student_registration_status'], ['approved', 'pending_finance'], true)) {
        return ['can_apply' => false, 'message' => 'Your account is not eligible to apply for a loan. Please contact CSDL.'];
    }
    if ($student['student_registration_status'] === 'pending_finance' || !(bool) $student['has_balance']) {
        return ['can_apply' => false, 'message' => 'Please wait for Assessment to set up your balance before applying for a loan. You can continue using your account while you wait.'];
    }
    return ['can_apply' => true, 'message' => ''];
}

function handleGetFormData(PDO $pdo, int $studentId): void {
    try {
        // Get student information including campus_id
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
            s.student_campus_id,
            p.program_name,
            yl.year_level_name,
            c.campus_name,
            sch.scholarship_name
        FROM tbl_csdl_students s
        LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
        LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
        LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
        LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
        WHERE s.student_id = ?");
        $stmt->execute([$studentId]);
        $student = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$student) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Student not found']);
            return;
        }

        // Get active balance (most recent)
        $balanceStmt = $pdo->prepare("SELECT balance_id, balance_sy_id, balance_total_balance, balance_previous_balance, balance_current_balance, balance_advice_to_pay 
                                      FROM tbl_csdl_balances 
                                      WHERE balance_student_id = ? 
                                      ORDER BY balance_as_of_date DESC, balance_id DESC 
                                      LIMIT 1");
        $balanceStmt->execute([$studentId]);
        $balance = $balanceStmt->fetch(PDO::FETCH_ASSOC);

        // Get application periods - include globally active periods AND student-specific access
        $periodsStmt = $pdo->prepare("
            SELECT DISTINCT ap.app_period_id, ap.app_period_name, ap.app_period_status,
                   es.exam_start_date,
                   COALESCE(es.exam_end_date, es.exam_start_date) AS exam_end_date,
                   next_es.exam_start_date AS payment_cutoff_exam_start,
                   CASE
                       WHEN next_es.exam_start_date IS NULL THEN NULL
                       ELSE DATE_SUB(next_es.exam_start_date, INTERVAL 1 DAY)
                   END AS payment_deadline
            FROM tbl_csdl_application_periods ap
            LEFT JOIN tbl_csdl_student_period_access spa ON spa.access_period_id = ap.app_period_id AND spa.access_student_id = ?
            LEFT JOIN tbl_csdl_exam_schedules es ON es.exam_schedule_id = (
                SELECT selected_es.exam_schedule_id
                FROM tbl_csdl_exam_schedules selected_es
                WHERE selected_es.exam_period_id = ap.app_period_id
                  AND selected_es.exam_status = 1
                ORDER BY
                    CASE WHEN selected_es.exam_start_date >= CURDATE() THEN 0 ELSE 1 END,
                    CASE WHEN selected_es.exam_start_date >= CURDATE() THEN selected_es.exam_start_date END ASC,
                    selected_es.exam_start_date DESC,
                    selected_es.exam_schedule_id DESC
                LIMIT 1
            )
            LEFT JOIN tbl_csdl_exam_schedules next_es ON next_es.exam_schedule_id = (
                SELECT following_es.exam_schedule_id
                FROM tbl_csdl_exam_schedules following_es
                WHERE following_es.exam_sy_id = es.exam_sy_id
                  AND following_es.exam_status = 1
                  AND following_es.exam_start_date > es.exam_start_date
                ORDER BY following_es.exam_start_date ASC, following_es.exam_schedule_id ASC
                LIMIT 1
            )
            WHERE ap.app_period_status = 1 OR spa.access_id IS NOT NULL
            ORDER BY ap.app_period_id DESC
        ");
        $periodsStmt->execute([$studentId]);
        $periods = $periodsStmt->fetchAll(PDO::FETCH_ASSOC);

        // A student can submit only one active or completed loan application for
        // each period. Returned and cancelled applications do not block a new
        // application for the same period.
        $usedPeriodsStmt = $pdo->prepare("
            SELECT DISTINCT l.loan_app_period_id
            FROM tbl_csdl_loans l
            WHERE l.loan_student_id = ?
              AND l.loan_app_period_id IS NOT NULL
              AND l.loan_status_id NOT IN (6, 9)
        ");
        $usedPeriodsStmt->execute([$studentId]);
        $usedPeriodIds = array_map('intval', $usedPeriodsStmt->fetchAll(PDO::FETCH_COLUMN));

        // Limit a student to two cancellations per application period. This
        // prevents repeated apply/cancel cycles while still allowing mistakes
        // to be corrected. Returned applications are not included here.
        $cancelledPeriodsStmt = $pdo->prepare("
            SELECT l.loan_app_period_id, COUNT(*) AS cancellation_count
            FROM tbl_csdl_loans l
            WHERE l.loan_student_id = ?
              AND l.loan_app_period_id IS NOT NULL
              AND l.loan_status_id = 9
            GROUP BY l.loan_app_period_id
        ");
        $cancelledPeriodsStmt->execute([$studentId]);
        $cancellationCounts = [];
        foreach ($cancelledPeriodsStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $cancellationCounts[(int) $row['loan_app_period_id']] = (int) $row['cancellation_count'];
        }
        foreach ($periods as &$period) {
            $periodId = (int) $period['app_period_id'];
            $period['already_applied'] = in_array($periodId, $usedPeriodIds, true);
            $period['cancellation_limit_reached'] = ($cancellationCounts[$periodId] ?? 0) >= 2;
        }
        unset($period);

        // Get document types
        $docTypesStmt = $pdo->query("SELECT doc_type_id, doc_type_name 
                                     FROM tbl_csdl_document_types
                                     WHERE doc_type_status = 1
                                     ORDER BY doc_type_id ASC");
        $docTypes = $docTypesStmt->fetchAll(PDO::FETCH_ASSOC);

        // Get relationships
        $relationshipsStmt = $pdo->query("SELECT relationship_id, relationship_name 
                                          FROM tbl_csdl_relationships 
                                          WHERE relationship_id IN (1, 2, 3)
                                          ORDER BY relationship_id ASC");
        $relationships = $relationshipsStmt->fetchAll(PDO::FETCH_ASSOC);

        $minimumAmountStmt = $pdo->prepare("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'minimum_amount_can_pay' LIMIT 1");
        $minimumAmountStmt->execute();
        $minimumAmountCanPay = (float) ($minimumAmountStmt->fetchColumn() ?: 1);
        if ($minimumAmountCanPay <= 0) {
            $minimumAmountCanPay = 1;
        }

        echo json_encode([
            'success' => true,
            'student' => $student,
            'balance' => $balance ?: null,
            'loan_eligibility' => studentLoanEligibility($pdo, $studentId),
            'applicationPeriods' => $periods,
            'documentTypes' => $docTypes,
            'relationships' => $relationships,
            'familyMembers' => studentFamilyFetch($pdo, $studentId),
            'minimumAmountCanPay' => $minimumAmountCanPay
        ]);
    } catch (Throwable $e) {
        error_log('Loan application form data error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to load form data']);
    }
}

function handleSubmitApplication(PDO $pdo, int $studentId): void {
    try {
        $eligibility = studentLoanEligibility($pdo, $studentId);
        if (!$eligibility['can_apply']) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => $eligibility['message']]);
            return;
        }

        // Check if this is a reapplication
        $reapplyLoanId = intval($_POST['reapplyLoanId'] ?? 0);
        $isReapplication = $reapplyLoanId > 0;
        
        // Validate required fields
        $dataConsent = $_POST['dataConsent'] ?? '';
        $declaration = isset($_POST['declaration']) && $_POST['declaration'] === 'on' ? true : false;
        $applicationPeriod = intval($_POST['applicationPeriod'] ?? 0);
        $loanReason = trim($_POST['loanReason'] ?? '');
        $amountCanPay = floatval($_POST['amountCanPay'] ?? 0);
        $paymentDate = trim($_POST['paymentDate'] ?? '');
        $parentName = trim($_POST['parentName'] ?? '');
        $relationship = intval($_POST['relationship'] ?? 0);
        $familyMemberId = intval($_POST['familyMemberId'] ?? 0);
        $parentContact = trim($_POST['parentContact'] ?? '');
        $documentType = intval($_POST['documentType'] ?? 0);
        $studentContactNumber = trim($_POST['contactNumber'] ?? '');
        $fbAccount = trim((string) ($_POST['fbAccount'] ?? ''));
        $applicationPeriodName = '';
        $relationshipName = '';
        $studentInfo = [];
        $guardianIdRelativePath = null;
        $guardianIdOriginalName = null;
        
        // If reapplication, verify loan belongs to student and is returned
        if ($isReapplication) {
            $checkLoanStmt = $pdo->prepare("SELECT loan_id, loan_status_id FROM tbl_csdl_loans 
                                            WHERE loan_id = ? AND loan_student_id = ?");
            $checkLoanStmt->execute([$reapplyLoanId, $studentId]);
            $existingLoan = $checkLoanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$existingLoan) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Access denied']);
                return;
            }
            
            if ($existingLoan['loan_status_id'] != 6) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Only returned loans can be reapplied']);
                return;
            }
        }

        // Validate required fields
        if ($dataConsent !== 'agree') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'You must agree to the data privacy consent']);
            return;
        }

        if ($fbAccount === '' || strlen($fbAccount) > 255 || preg_match('/[\x00-\x1F\x7F]/', $fbAccount)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Enter a Facebook name or profile link of up to 255 characters.']);
            return;
        }

        if (!$declaration) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'You must agree to the declaration']);
            return;
        }

        if ($applicationPeriod <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Application period is required']);
            return;
        }

        if (!$isReapplication) {
            $cancellationCountStmt = $pdo->prepare("
                SELECT COUNT(*)
                FROM tbl_csdl_loans
                WHERE loan_student_id = ?
                  AND loan_app_period_id = ?
                  AND loan_status_id = 9
            ");
            $cancellationCountStmt->execute([$studentId, $applicationPeriod]);
            $cancellationCount = (int) $cancellationCountStmt->fetchColumn();
            if ($cancellationCount >= 2) {
                http_response_code(400);
                echo json_encode([
                    'success' => false,
                    'message' => 'You have reached the limit of two cancelled applications for this period. Please contact CSDL for assistance.'
                ]);
                return;
            }

            // One active or completed application is allowed per student per
            // application period. A returned or cancelled application may be
            // resubmitted or replaced with a new application for the same period.
            $periodLoanStmt = $pdo->prepare("
                SELECT l.loan_application_no, ls.loan_status_name
                FROM tbl_csdl_loans l
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                WHERE l.loan_student_id = ?
                  AND l.loan_app_period_id = ?
                  AND l.loan_status_id NOT IN (6, 9)
                ORDER BY l.loan_id DESC
                LIMIT 1
            ");
            $periodLoanStmt->execute([$studentId, $applicationPeriod]);
            $periodLoan = $periodLoanStmt->fetch(PDO::FETCH_ASSOC);

            if ($periodLoan) {
                http_response_code(400);
                $status = trim((string) ($periodLoan['loan_status_name'] ?? ''));
                echo json_encode([
                    'success' => false,
                    'message' => 'You already submitted loan application ' . ($periodLoan['loan_application_no'] ?? '')
                        . ' for this period' . ($status !== '' ? ' (' . $status . ')' : '')
                        . '. Only one loan application is allowed per period.'
                ]);
                return;
            }
        }

        if (empty($loanReason) || strlen($loanReason) < 10) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Loan reason must be at least 10 characters']);
            return;
        }
        
        if (strlen($loanReason) > 500) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Loan reason must not exceed 500 characters']);
            return;
        }

        $minimumAmountStmt = $pdo->prepare("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'minimum_amount_can_pay' LIMIT 1");
        $minimumAmountStmt->execute();
        $minimumAmountCanPay = (float) ($minimumAmountStmt->fetchColumn() ?: 1);
        if ($minimumAmountCanPay <= 0) {
            $minimumAmountCanPay = 1;
        }

        if ($amountCanPay < $minimumAmountCanPay) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Amount can pay must be at least ₱' . number_format($minimumAmountCanPay, 2)]);
            return;
        }

        if (empty($paymentDate)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Payment date is required']);
            return;
        }

        // Allow the student to choose any intended payment date from today
        // through 30 calendar days after the application date.
        $today = new DateTimeImmutable('today');
        $paymentDeadline = $today->modify('+30 days');

        $paymentDateObj = DateTimeImmutable::createFromFormat('!Y-m-d', $paymentDate);
        if (!$paymentDateObj || $paymentDateObj->format('Y-m-d') !== $paymentDate) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Enter a valid payment date']);
            return;
        }

        if ($paymentDateObj < $today) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Payment date cannot be in the past']);
            return;
        }

        if ($paymentDateObj > $paymentDeadline) {
            http_response_code(400);
            echo json_encode([
                'success' => false,
                'message' => 'Payment date must be within 30 days, on or before ' . $paymentDeadline->format('F j, Y')
            ]);
            return;
        }

        $dueDate = $paymentDeadline->format('Y-m-d');

        $familyMemberStmt = $pdo->prepare('SELECT guardian_id, guardian_name, guardian_contact, guardian_relationship_id FROM tbl_csdl_guardians WHERE guardian_id = ? AND guardian_student_id = ? AND guardian_relationship_id = ? AND guardian_relationship_id IN (1, 2, 3) AND guardian_status = 1 LIMIT 1');
        $familyMemberStmt->execute([$familyMemberId, $studentId, $relationship]);
        $familyMember = $familyMemberStmt->fetch(PDO::FETCH_ASSOC);
        if (!$familyMember) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Select a saved family member. Ask CSDL to update your family details if needed.']);
            return;
        }
        $parentName = trim($familyMember['guardian_name']);

        if (empty($parentName) || strlen($parentName) < 3) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Parent/Guardian name is required and must be at least 3 characters']);
            return;
        }

        if ($relationship <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Relationship is required']);
            return;
        }

        if (!preg_match('/^09[0-9]{9}$/', $parentContact)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Parent/Guardian contact must be an 11-digit mobile number starting with 09']);
            return;
        }

        if ($documentType <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Document type is required']);
            return;
        }

        // Validate student contact number (must be 11 digits starting with 09)
        if (empty($studentContactNumber) || !preg_match('/^09[0-9]{9}$/', $studentContactNumber)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Student contact number must be 11 digits starting with 09']);
            return;
        }

        // Get application period name and validate access (for email summary)
        $appPeriodStmt = $pdo->prepare("
            SELECT ap.app_period_name, ap.app_period_status, spa.access_id
            FROM tbl_csdl_application_periods ap
            LEFT JOIN tbl_csdl_student_period_access spa ON spa.access_period_id = ap.app_period_id AND spa.access_student_id = ?
            WHERE ap.app_period_id = ?
        ");
        $appPeriodStmt->execute([$studentId, $applicationPeriod]);
        $appPeriodRow = $appPeriodStmt->fetch(PDO::FETCH_ASSOC);
        if (!$appPeriodRow) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Application period not found']);
            return;
        }
        
        // Check if student has access (either period is globally active OR student has specific access)
        $hasAccess = ($appPeriodRow['app_period_status'] == 1) || ($appPeriodRow['access_id'] !== null);
        if (!$hasAccess) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'You do not have access to apply for this period']);
            return;
        }
        
        $applicationPeriodName = $appPeriodRow['app_period_name'];

        // Get relationship name (for email summary)
        $relationshipStmt = $pdo->prepare("SELECT relationship_name FROM tbl_csdl_relationships WHERE relationship_id = ?");
        $relationshipStmt->execute([$relationship]);
        $relationshipRow = $relationshipStmt->fetch(PDO::FETCH_ASSOC);
        $relationshipName = $relationshipRow['relationship_name'] ?? 'Guardian';

        // Get student info (for email summary and campus routing)
        $studentInfoStmt = $pdo->prepare("SELECT 
                CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                s.student_first_name,
                s.student_middle_name,
                s.student_last_name,
                s.student_school_id,
                s.student_email,
                s.student_personal_email,
                s.student_contact_number,
                s.student_fb_account,
                s.student_campus_id,
                p.program_name,
                yl.year_level_name,
                c.campus_name,
                c.campus_code,
                sch.scholarship_name
            FROM tbl_csdl_students s
            LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
            LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
            LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
            LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
            WHERE s.student_id = ?");
        $studentInfoStmt->execute([$studentId]);
        $studentInfo = $studentInfoStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        if (guardianIdNameMatchesStudent(
            $parentName,
            (string) ($studentInfo['student_first_name'] ?? ''),
            (string) ($studentInfo['student_middle_name'] ?? ''),
            (string) ($studentInfo['student_last_name'] ?? '')
        )) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'The parent/guardian name cannot be your own student name. Upload an ID belonging to your parent or guardian.']);
            return;
        }

        // Every submission, including a returned loan, must supply a freshly screened ID.
        $hasFileUpload = isset($_FILES['validIdFile']) && $_FILES['validIdFile']['error'] === UPLOAD_ERR_OK;
        $file = null;
        
        if (!$hasFileUpload) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Please upload and scan the guardian ID before submitting, including for a returned application.']);
            return;
        }
        
        if ($hasFileUpload) {
            $file = $_FILES['validIdFile'];
            
            // Get configurable document settings
            $docMaxSizeStmt = $pdo->prepare("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'document_max_size' LIMIT 1");
            $docMaxSizeStmt->execute();
            $docMaxSizeRow = $docMaxSizeStmt->fetch(PDO::FETCH_ASSOC);
            $maxFileSize = $docMaxSizeRow ? intval($docMaxSizeRow['setting_value']) : (5 * 1024 * 1024); // Default 5MB
            
            $allowedTypesStmt = $pdo->prepare("SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = 'allowed_document_types' LIMIT 1");
            $allowedTypesStmt->execute();
            $allowedTypesRow = $allowedTypesStmt->fetch(PDO::FETCH_ASSOC);
            $allowedExtensionsStr = $allowedTypesRow ? $allowedTypesRow['setting_value'] : 'pdf,jpg,jpeg,png,gif';
            $allowedExtensions = array_map('trim', explode(',', strtolower($allowedExtensionsStr)));
            
            // Map extensions to MIME types
            $mimeTypeMap = [
                'pdf' => 'application/pdf',
                'jpg' => 'image/jpeg',
                'jpeg' => 'image/jpeg',
                'png' => 'image/png',
                'gif' => 'image/gif',
                'doc' => 'application/msword',
                'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ];
            
            $allowedMimeTypes = [];
            foreach ($allowedExtensions as $ext) {
                if (isset($mimeTypeMap[$ext])) {
                    $allowedMimeTypes[] = $mimeTypeMap[$ext];
                }
            }
            
            [$uploadValid, $uploadMessage] = UploadSecurity::validateUploadedFile(
                $file,
                $allowedExtensions,
                $allowedMimeTypes,
                $maxFileSize
            );
            if (!$uploadValid) {
                http_response_code(400);
                if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                    $uploadMessage = 'Invalid file type. Allowed types: ' . strtoupper(implode(', ', $allowedExtensions));
                }
                echo json_encode(['success' => false, 'message' => $uploadMessage]);
                return;
            }
        }

        $automatedScreening = guardianIdScreeningReceiptMatches(
            $_SESSION['guardian_id_screening'] ?? null,
            $file['tmp_name'], $studentId, $parentName, $documentType
        );
        $guardianReview = !$automatedScreening && guardianIdReviewReceiptMatches(
            $_SESSION['guardian_id_review'] ?? null,
            $file['tmp_name'], $studentId, $parentName, $documentType
        ) ? $_SESSION['guardian_id_review'] : null;
        if (!$automatedScreening && $guardianReview === null) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'The ID scan expired or the file, guardian name, or document type changed. Please scan it again.']);
            return;
        }

        // Get the latest student balance record for the application.
        $balanceStmt = $pdo->prepare("SELECT balance_id, balance_total_balance, balance_current_balance 
                                      FROM tbl_csdl_balances 
                                      WHERE balance_student_id = ? 
                                      ORDER BY balance_as_of_date DESC, balance_id DESC 
                                      LIMIT 1");
        $balanceStmt->execute([$studentId]);
        $balance = $balanceStmt->fetch(PDO::FETCH_ASSOC);

        if (!$balance) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Please wait for Assessment to set up your balance before applying for a loan.']);
            return;
        }

        $balanceId = (int) $balance['balance_id'];
        $totalBalance = (float) ($balance['balance_total_balance'] ?? 0);
        $currentBalance = (float) ($balance['balance_current_balance'] ?? 0);
        
        // Get student campus info and balance for routing
        $studentCampusId = (int) ($studentInfo['student_campus_id'] ?? 0);
        $studentCampusCode = strtolower(trim($studentInfo['campus_code'] ?? ''));
        $studentCampusName = $studentInfo['campus_name'] ?? 'Unknown Campus';
        
        // Every application starts with CSDL. CSDL may approve applications
        // within its authority or manually endorse those above ₱3,000 to
        // Assessment after reviewing them.
        $remainingBalance = max(0, $totalBalance - $amountCanPay);
        $workflowStepId = 1;
        $approvalRoleId = 100;
        $routingReason = "Routed to CSDL Office for initial review. Remaining balance: ₱" . number_format($remainingBalance, 2) . ".";

        // Start transaction
        $pdo->beginTransaction();

        try {
            $deferredPushes = [];

            // Save a corrected contact only when the loan submission succeeds.
            // The selected guardian is bound to this student and relationship.
            if ($parentContact !== trim((string) ($familyMember['guardian_contact'] ?? ''))) {
                $updateFamilyContactStmt = $pdo->prepare('UPDATE tbl_csdl_guardians SET guardian_contact = ? WHERE guardian_id = ? AND guardian_student_id = ? AND guardian_relationship_id = ? AND guardian_status = 1');
                $updateFamilyContactStmt->execute([$parentContact, $familyMemberId, $studentId, $relationship]);
                if ($updateFamilyContactStmt->rowCount() !== 1) {
                    throw new RuntimeException('Family details changed while submitting. Please reopen the loan form and try again.');
                }
            }

            // Update student contact number if provided
            if (!empty($studentContactNumber)) {
                $updateContactStmt = $pdo->prepare("UPDATE tbl_csdl_students 
                                                    SET student_contact_number = ? 
                                                    WHERE student_id = ?");
                $updateContactStmt->execute([$studentContactNumber, $studentId]);
            }

            // Keep the student's current Facebook contact with the application.
            $updateFbStmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_fb_account = ? WHERE student_id = ?");
            $updateFbStmt->execute([$fbAccount, $studentId]);
            $studentInfo['student_fb_account'] = $fbAccount;
            
            $guardianId = (int)$familyMember['guardian_id'];

            if ($isReapplication) {
                // Update existing loan for reapplication
                $loanId = $reapplyLoanId;
                $applicationDate = date('Y-m-d');
                
                $updateLoanStmt = $pdo->prepare("UPDATE tbl_csdl_loans 
                                                SET loan_guardian_id = ?,
                                                    loan_amount_can_pay = ?,
                                                    loan_reason = ?,
                                                    loan_app_period_id = ?,
                                                    loan_status_id = 1,
                                                    loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 1 END,
                                                    loan_pn_status_id = 1,
                                                    loan_current_step_id = ?,
                                                    loan_application_date = ?,
                                                    loan_promised_payment_date = ?,
                                                    loan_returned_date = NULL,
                                                    loan_due_date = ?,
                                                    loan_updated_by = NULL,
                                                    loan_updated_at = NOW()
                                                WHERE loan_id = ?");
                $updateLoanStmt->execute([
                    $guardianId,
                    $amountCanPay,
                    $loanReason,
                    $applicationPeriod,
                    $workflowStepId,
                    $applicationDate,
                    $paymentDate,
                    $dueDate,
                    $loanId
                ]);
                
                // Handle file upload if provided
                if ($hasFileUpload && $file) {
                    $uploadDir = __DIR__ . '/../../uploads/valid_ids/';
                    if (!is_dir($uploadDir)) {
                        mkdir($uploadDir, 0755, true);
                    }

                    $fileExt = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
                    $fileName = 'valid_id_' . $studentId . '_' . time() . '.' . $fileExt;
                    $filePath = $uploadDir . $fileName;
                    
                    if (!move_uploaded_file($file['tmp_name'], $filePath)) {
                        throw new Exception('Failed to upload file');
                    }

                    $relativePath = 'uploads/valid_ids/' . $fileName;

                    // Update or insert document record
                    $checkDocStmt = $pdo->prepare("SELECT loan_document_id FROM tbl_csdl_loan_documents 
                                                   WHERE loan_document_loan_id = ? AND loan_document_doc_type_id = ?");
                    $checkDocStmt->execute([$loanId, $documentType]);
                    $existingDoc = $checkDocStmt->fetch(PDO::FETCH_ASSOC);
                    
                    if ($existingDoc) {
                        // Update existing document
                        $updateDocStmt = $pdo->prepare("UPDATE tbl_csdl_loan_documents 
                                                        SET loan_document_file_name = ?,
                                                            loan_document_file_path = ?,
                                                            loan_document_uploaded_by = ?
                                                        WHERE loan_document_id = ?");
                        $updateDocStmt->execute([
                            $file['name'],
                            $relativePath,
                            $studentId,
                            $existingDoc['loan_document_id']
                        ]);
                        $guardianDocumentId = (int) $existingDoc['loan_document_id'];
                    } else {
                        // Insert new document
                        $insertDocStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_documents 
                                                       (loan_document_loan_id, loan_document_doc_type_id, loan_document_file_name,
                                                        loan_document_file_path, loan_document_uploaded_by) 
                                                       VALUES (?, ?, ?, ?, ?)");
                        $insertDocStmt->execute([
                            $loanId,
                            $documentType,
                            $file['name'],
                            $relativePath,
                            $studentId
                        ]);
                        $guardianDocumentId = (int) $pdo->lastInsertId();
                    }
                    saveGuardianIdReview($pdo, $loanId, $guardianDocumentId, $guardianReview);

                    // For email attachment
                    $guardianIdRelativePath = $relativePath;
                    $guardianIdOriginalName = $file['name'];
                }
                
                // Insert tracking record for resubmission with routing information
                $trackingStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking 
                                              (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action,
                                               loan_tracking_remarks, loan_tracking_updated_by) 
                                              VALUES (?, ?, 'Application Resubmitted', ?, ?)");
                $trackingStmt->execute([$loanId, $workflowStepId, $routingReason, $studentId]);

                // Update or insert approval record (reset to pending for appropriate officer review)
                // Check for existing approval record matching the unique constraint (loan_id, step_id, role_id)
                $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                    WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?
                                                    LIMIT 1");
                $checkApprovalStmt->execute([$loanId, $workflowStepId, $approvalRoleId]);
                $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
                
                if ($existingApproval) {
                    // Update existing approval record to reset it back to pending
                    $updateApprovalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals 
                                                       SET approval_status_id = 1,
                                                           approval_amount_approved = NULL,
                                                           approval_processed_by = NULL,
                                                           approval_date_processed = NULL,
                                                           approval_channel_used = NULL,
                                                           approval_date_contacted = NULL,
                                                           approval_remarks = NULL,
                                                           approval_approved_email = 0,
                                                           approval_pn_tagging = NULL,
                                                           approval_pn_date_processed = NULL,
                                                           approval_updated_at = NOW()
                                                       WHERE approval_id = ?");
                    $updateApprovalStmt->execute([$existingApproval['approval_id']]);
                } else {
                    // Insert new approval record if none exists for this combination
                    $insertApprovalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals 
                                                        (approval_loan_id, approval_step_id, approval_role_id, approval_status_id) 
                                                        VALUES (?, ?, ?, 1)");
                    $insertApprovalStmt->execute([$loanId, $workflowStepId, $approvalRoleId]);
                }
                
                // Get application number for notification
                $getAppNoStmt = $pdo->prepare("SELECT loan_application_no FROM tbl_csdl_loans WHERE loan_id = ?");
                $getAppNoStmt->execute([$loanId]);
                $loanData = $getAppNoStmt->fetch(PDO::FETCH_ASSOC);
                $applicationNo = $loanData['loan_application_no'] ?? '';
                
                // Create notification for student
                $studentNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                                  (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                                   notification_title, notification_message, notification_sent_at) 
                                                  VALUES (?, ?, ?, ?, ?, NOW())");
                $studentNotifTitle = 'Loan Application Resubmitted';
                $studentNotifMessage = "Your loan application has been resubmitted. Application No: {$applicationNo}. {$routingReason}." . ($guardianReview !== null ? ' Your guardian ID is awaiting CSDL review.' : '') . ' We will notify you about updates.';
                $studentNotifStmt->execute([$studentId, $loanId, $workflowStepId, $studentNotifTitle, $studentNotifMessage]);
                
                // Get notification ID for push notification
                $notificationId = (int) $pdo->lastInsertId();

                $deferredPushes[] = [
                    'userId' => $studentId,
                    'userType' => 'student',
                    'data' => [
                        'id' => $notificationId,
                        'title' => $studentNotifTitle,
                        'message' => $studentNotifMessage,
                        'loanId' => $loanId
                    ]
                ];

                // CSDL and Assessment are shared queues across all campuses.
                $officerEmployeesStmt = in_array($approvalRoleId, [100, 101], true)
                    ? $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1")
                    : $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_campus_id = ? AND employee_status = 1");
                in_array($approvalRoleId, [100, 101], true)
                    ? $officerEmployeesStmt->execute([$approvalRoleId])
                    : $officerEmployeesStmt->execute([$approvalRoleId, $studentCampusId]);
                $officerEmployees = $officerEmployeesStmt->fetchAll(PDO::FETCH_ASSOC);
                
                // Get student name for officer notification
                $studentNameStmt = $pdo->prepare("SELECT CONCAT_WS(' ', student_first_name, student_middle_name, student_last_name) as student_name 
                                                 FROM tbl_csdl_students WHERE student_id = ?");
                $studentNameStmt->execute([$studentId]);
                $studentData = $studentNameStmt->fetch(PDO::FETCH_ASSOC);
                $studentName = $studentData['student_name'] ?? 'Student';
                
                // Get office name for notification
                $officeName = '';
                if ($approvalRoleId == 100) {
                    $officeName = 'CSDL Office';
                } elseif ($approvalRoleId == 99) {
                    $officeName = 'Cashier Office';
                } elseif ($approvalRoleId == 98) {
                    $officeName = 'Branch Admin - ' . $studentCampusName;
                } elseif ($approvalRoleId == 97) {
                    $officeName = 'COO Office';
                }
                
                $officerNotifTitle = 'Loan Application Resubmitted';
                $officerNotifMessage = "A loan application has been resubmitted by {$studentName}. Application No: {$applicationNo}. Amount: ₱" . number_format($amountCanPay, 2) . ". {$routingReason}" . ($guardianReview !== null ? ' Guardian ID requires CSDL review.' : '');
                
                $officerNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                                (notification_employee_id, notification_loan_id, notification_workflow_step_id,
                                                 notification_title, notification_message, notification_sent_at) 
                                                VALUES (?, ?, ?, ?, ?, NOW())");
                
                foreach ($officerEmployees as $officer) {
                    $officerNotifStmt->execute([$officer['employee_id'], $loanId, $workflowStepId, $officerNotifTitle, $officerNotifMessage]);
                    
                    // Get notification ID for push notification
                    $officerNotificationId = (int) $pdo->lastInsertId();

                    $deferredPushes[] = [
                        'userId' => (int) $officer['employee_id'],
                        'userType' => 'employee',
                        'data' => [
                            'id' => $officerNotificationId,
                            'title' => $officerNotifTitle,
                            'message' => $officerNotifMessage,
                            'loanId' => $loanId
                        ]
                    ];
                }
            } else {
                // Generate application number for new application
                $currentYear = date('Y');
                $currentMonth = date('m');
                $currentDay = date('d');
                $applicationDate = date('Y-m-d');
                
                // Get last sequence number for today
                $seqStmt = $pdo->prepare("SELECT loan_application_no 
                                          FROM tbl_csdl_loans 
                                          WHERE loan_application_no LIKE ? 
                                          ORDER BY loan_id DESC 
                                          LIMIT 1");
                $pattern = $currentYear . '-' . $currentMonth . $currentDay . '-%';
                $seqStmt->execute([$pattern]);
                $lastAppNo = $seqStmt->fetch(PDO::FETCH_ASSOC);
                
                $sequence = 1;
                if ($lastAppNo) {
                    $parts = explode('-', $lastAppNo['loan_application_no']);
                    if (count($parts) === 3) {
                        $sequence = intval($parts[2]) + 1;
                    }
                }
                
                $applicationNo = sprintf('%s-%s-%04d', $currentYear, $currentMonth . $currentDay, $sequence);

                // Insert loan application
                // Store the 2-day review deadline. Passing it marks the loan as
                // overdue but never expires or blocks the application.
                $expiryTimestamp = date('Y-m-d H:i:s', strtotime('+2 days'));
                
                $insertLoanStmt = $pdo->prepare("INSERT INTO tbl_csdl_loans 
                                                (loan_application_no, loan_student_id, loan_guardian_id, loan_balance_id,
                                                 loan_amount_can_pay, loan_reason, loan_app_period_id, loan_status_id,
                                                 loan_payment_status_id, loan_pn_status_id,
                                                 loan_current_step_id, loan_application_date, loan_promised_payment_date,
                                                 loan_data_privacy_consent, loan_promissory_agreement, loan_created_by,
                                                 loan_expiry_timestamp, loan_due_date) 
                                                VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, 1, 1, ?, ?, ?)");
                $insertLoanStmt->execute([
                    $applicationNo,
                    $studentId,
                    $guardianId,
                    $balanceId,
                    $amountCanPay,
                    $loanReason,
                    $applicationPeriod,
                    $workflowStepId,
                    $applicationDate,
                    $paymentDate,
                    $studentId,
                    $expiryTimestamp,
                    $dueDate
                ]);
                
                $loanId = (int) $pdo->lastInsertId();

                // Handle file upload
                $uploadDir = __DIR__ . '/../../uploads/valid_ids/';
                if (!is_dir($uploadDir)) {
                    mkdir($uploadDir, 0755, true);
                }

                $fileExt = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
                $fileName = 'valid_id_' . $studentId . '_' . time() . '.' . $fileExt;
                $filePath = $uploadDir . $fileName;
                
                if (!move_uploaded_file($file['tmp_name'], $filePath)) {
                    throw new Exception('Failed to upload file');
                }

                $relativePath = 'uploads/valid_ids/' . $fileName;

                // Insert document record
                $insertDocStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_documents 
                                               (loan_document_loan_id, loan_document_doc_type_id, loan_document_file_name,
                                                loan_document_file_path, loan_document_uploaded_by) 
                                               VALUES (?, ?, ?, ?, ?)");
                $insertDocStmt->execute([
                    $loanId,
                    $documentType,
                    $file['name'],
                    $relativePath,
                    $studentId
                ]);
                saveGuardianIdReview($pdo, $loanId, (int) $pdo->lastInsertId(), $guardianReview);

                // For email attachment
                $guardianIdRelativePath = $relativePath;
                $guardianIdOriginalName = $file['name'];

                // Insert initial tracking record with routing information
                $trackingStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking 
                                              (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action,
                                               loan_tracking_remarks, loan_tracking_updated_by) 
                                              VALUES (?, ?, 'Application Submitted', ?, ?)");
                $trackingStmt->execute([$loanId, $workflowStepId, $routingReason, $studentId]);

                // Insert initial approval record (pending status for appropriate officer review)
                $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals 
                                              (approval_loan_id, approval_step_id, approval_role_id, approval_status_id) 
                                              VALUES (?, ?, ?, 1)");
                $approvalStmt->execute([$loanId, $workflowStepId, $approvalRoleId]);
                
                // Create notification for student
                $studentNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                                  (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                                   notification_title, notification_message, notification_sent_at) 
                                                  VALUES (?, ?, ?, ?, ?, NOW())");
                $studentNotifTitle = 'Loan Application Submitted';
                $studentNotifMessage = "Your loan application has been submitted. Application No: {$applicationNo}. {$routingReason}." . ($guardianReview !== null ? ' Your guardian ID is awaiting CSDL review.' : '') . ' We will notify you about updates.';
                $studentNotifStmt->execute([$studentId, $loanId, $workflowStepId, $studentNotifTitle, $studentNotifMessage]);
                
                // Get notification ID for push notification
                $notificationId = (int) $pdo->lastInsertId();

                $deferredPushes[] = [
                    'userId' => $studentId,
                    'userType' => 'student',
                    'data' => [
                        'id' => $notificationId,
                        'title' => $studentNotifTitle,
                        'message' => $studentNotifMessage,
                        'loanId' => $loanId
                    ]
                ];

                // CSDL and Assessment are shared queues across all campuses.
                $officerEmployeesStmt = in_array($approvalRoleId, [100, 101], true)
                    ? $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1")
                    : $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_campus_id = ? AND employee_status = 1");
                in_array($approvalRoleId, [100, 101], true)
                    ? $officerEmployeesStmt->execute([$approvalRoleId])
                    : $officerEmployeesStmt->execute([$approvalRoleId, $studentCampusId]);
                $officerEmployees = $officerEmployeesStmt->fetchAll(PDO::FETCH_ASSOC);
                
                // Get student name for officer notification
                $studentNameStmt = $pdo->prepare("SELECT CONCAT_WS(' ', student_first_name, student_middle_name, student_last_name) as student_name 
                                                 FROM tbl_csdl_students WHERE student_id = ?");
                $studentNameStmt->execute([$studentId]);
                $studentData = $studentNameStmt->fetch(PDO::FETCH_ASSOC);
                $studentName = $studentData['student_name'] ?? 'Student';
                
                // Get office name for notification
                $officeName = '';
                if ($approvalRoleId == 100) {
                    $officeName = 'CSDL Office';
                } elseif ($approvalRoleId == 99) {
                    $officeName = 'Finance/Assessment Office';
                } elseif ($approvalRoleId == 98) {
                    $officeName = 'Branch Admin - ' . $studentCampusName;
                } elseif ($approvalRoleId == 97) {
                    $officeName = 'COO Office';
                }
                
                $officerNotifTitle = 'New Loan Application Submitted';
                $officerNotifMessage = "A new loan application has been submitted by {$studentName}. Application No: {$applicationNo}. Amount: ₱" . number_format($amountCanPay, 2) . ". {$routingReason}" . ($guardianReview !== null ? ' Guardian ID requires CSDL review.' : '');
                
                $officerNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                                (notification_employee_id, notification_loan_id, notification_workflow_step_id,
                                                 notification_title, notification_message, notification_sent_at) 
                                                VALUES (?, ?, ?, ?, ?, NOW())");
                
                foreach ($officerEmployees as $officer) {
                    $officerNotifStmt->execute([$officer['employee_id'], $loanId, $workflowStepId, $officerNotifTitle, $officerNotifMessage]);
                    
                    // Get notification ID for push notification
                    $officerNotificationId = (int) $pdo->lastInsertId();

                    $deferredPushes[] = [
                        'userId' => (int) $officer['employee_id'],
                        'userType' => 'employee',
                        'data' => [
                            'id' => $officerNotificationId,
                            'title' => $officerNotifTitle,
                            'message' => $officerNotifMessage,
                            'loanId' => $loanId
                        ]
                    ];
                }
            }

            // Commit transaction
            $pdo->commit();
            unset($_SESSION['guardian_id_screening']);
            unset($_SESSION['guardian_id_review']);

            // Get application number for response (for new applications)
            $applicationNo = null;
            if (!$isReapplication) {
                $getAppNoStmt = $pdo->prepare("SELECT loan_application_no FROM tbl_csdl_loans WHERE loan_id = ?");
                $getAppNoStmt->execute([$loanId]);
                $loanData = $getAppNoStmt->fetch(PDO::FETCH_ASSOC);
                $applicationNo = $loanData['loan_application_no'] ?? null;
            } else {
                $getAppNoStmt = $pdo->prepare("SELECT loan_application_no FROM tbl_csdl_loans WHERE loan_id = ?");
                $getAppNoStmt->execute([$loanId]);
                $loanData = $getAppNoStmt->fetch(PDO::FETCH_ASSOC);
                $applicationNo = $loanData['loan_application_no'] ?? null;
            }

            echo json_encode([
                'success' => true,
                'message' => $isReapplication ? 'Loan application resubmitted successfully' : 'Loan application submitted successfully',
                'applicationNo' => $applicationNo,
                'reviewRequired' => $guardianReview !== null,
                'loanId' => $loanId
            ]);

            ignore_user_abort(true);
            flush_loan_submission_response_and_continue();

            require_once __DIR__ . '/../includes/includes-send-push-notification.php';
            foreach ($deferredPushes as $push) {
                sendPushNotification($pdo, $push['userId'], $push['userType'], $push['data']);
            }

            require_once __DIR__ . '/../includes/includes-send-loan-application-email.php';
            $paymentDateFormatted = $paymentDateObj ? $paymentDateObj->format('F j, Y') : $paymentDate;
            $amountDisplay = '₱' . number_format($amountCanPay, 2);
            queueLoanApplicationReceiptEmail($pdo, $studentInfo, [
                'applicationNo' => $applicationNo,
                'studentSchoolId' => $studentInfo['student_school_id'] ?? '-',
                'course' => $studentInfo['program_name'] ?? '-',
                'yearLevel' => $studentInfo['year_level_name'] ?? '-',
                'campus' => $studentInfo['campus_name'] ?? '-',
                'scholarship' => $studentInfo['scholarship_name'] ?? '-',
                'contact' => $studentInfo['student_contact_number'] ?? '',
                'email' => $studentInfo['student_email'] ?? '',
                'fbAccount' => $studentInfo['student_fb_account'] ?? '',
                'applicationPeriod' => $applicationPeriodName,
                'loanReason' => $loanReason,
                'amountCanPay' => $amountDisplay,
                'paymentDate' => $paymentDateFormatted,
                'parentName' => $parentName,
                'parentContact' => $parentContact,
                'relationship' => $relationshipName,
                'guardianIdLabel' => ($guardianIdOriginalName ?: 'Attached'),
                'submittedFiles' => array_filter([
                    $guardianIdOriginalName,
                ]),
                'loan_data_privacy_consent' => 1,
                'loan_promissory_agreement' => 1,
            ], $guardianIdRelativePath, $guardianIdOriginalName);

        } catch (Exception $e) {
            $pdo->rollBack();
            
            // Delete uploaded file if it exists
            if (isset($filePath) && file_exists($filePath)) {
                unlink($filePath);
            }
            
            throw $e;
        }

    } catch (Throwable $e) {
        error_log('Loan application submission error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to submit loan application. Please try again later.']);
    }
}
