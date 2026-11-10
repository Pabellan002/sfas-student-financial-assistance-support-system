<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

$schoolId = trim($_GET['school_id'] ?? '');
if ($schoolId === '' || !InputValidation::validateSchoolId($schoolId)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid School ID']);
    exit;
}

function registrationStatusMeta(string $status): array
{
    switch ($status) {
        case 'pending':
            return [
                'label' => 'Pending CSDL Review',
                'message' => 'Your registration is being reviewed by CSDL. You will receive an email when it moves to the next step.',
            ];
        case 'pending_finance':
            return [
                'label' => 'CSDL Approved - Awaiting Balance',
                'message' => 'CSDL approved your registration. You may now sign in. You must wait for Assessment to set up your balance before applying for a loan.',
            ];
        case 'approved':
            return [
                'label' => 'Approved',
                'message' => 'Your registration is complete. You may sign in using your School ID and password.',
            ];
        case 'rejected':
            return [
                'label' => 'Not Approved',
                'message' => 'Your registration was not approved. You may submit a new registration with the same School ID. Contact the CSDL office if you need help.',
            ];
        default:
            return [
                'label' => 'Approved',
                'message' => 'Your registration is complete. You may sign in using your School ID and password.',
            ];
    }
}

function registrationStatusMaskedName(?string $firstName, ?string $lastName): string
{
    $first = preg_split('/\s+/u', trim((string) $firstName))[0] ?? '';
    $last = trim((string) $lastName);
    if ($first === '') return 'N/A';

    $first = mb_convert_case($first, MB_CASE_TITLE, 'UTF-8');
    $length = mb_strlen($first, 'UTF-8');
    $maskedFirst = $length > 4
        ? mb_substr($first, 0, 2, 'UTF-8') . '***' . mb_substr($first, -1, 1, 'UTF-8')
        : mb_substr($first, 0, 1, 'UTF-8') . '***';
    $lastInitial = $last === '' ? '' : ' ' . mb_strtoupper(mb_substr($last, 0, 1, 'UTF-8'), 'UTF-8') . '.';
    return $maskedFirst . $lastInitial;
}

try {
    $regColumnAvailable = false;
    try {
        $colStmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_registration_status'");
        $regColumnAvailable = (bool) $colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $regColumnAvailable = false;
    }

    $regSelect = $regColumnAvailable
        ? 's.student_registration_status'
        : "'approved' AS student_registration_status";

    $stmt = $pdo->prepare("
        SELECT
            s.student_school_id,
            s.student_first_name,
            s.student_last_name,
            {$regSelect},
            s.student_is_active,
            s.student_created_at,
            s.student_updated_at,
            p.program_name,
            c.campus_name
        FROM tbl_csdl_students s
        LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
        LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
        WHERE s.student_school_id = ?
        LIMIT 1
    ");
    $stmt->execute([$schoolId]);
    $student = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$student) {
        echo json_encode(['success' => false, 'message' => 'No registration found for this School ID.']);
        exit;
    }

    $statusKey = (string) ($student['student_registration_status'] ?? 'approved');
    $meta = registrationStatusMeta($statusKey);
    if (in_array($statusKey, ['approved', 'pending_finance'], true) && (int) ($student['student_is_active'] ?? 0) !== 1) {
        $meta = ['label' => 'Account Inactive', 'message' => 'Your account is inactive. Please contact CSDL for assistance.'];
    }

    echo json_encode([
        'success' => true,
        'status' => $meta['label'],
        'status_key' => $statusKey,
        'message' => $meta['message'],
        'student_name' => registrationStatusMaskedName($student['student_first_name'] ?? null, $student['student_last_name'] ?? null),
        'school_id' => $student['student_school_id'] ?? $schoolId,
        'program' => $student['program_name'] ?? null,
        'campus' => $student['campus_name'] ?? null,
        'submitted_at' => $student['student_created_at'] ?? null,
        'updated_at' => $student['student_updated_at'] ?? null,
        'can_sign_in' => in_array($statusKey, ['approved', 'pending_finance'], true) && (int) ($student['student_is_active'] ?? 0) === 1,
    ]);
} catch (PDOException $e) {
    error_log('Registration status check error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unable to fetch registration status']);
}
