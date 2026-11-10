<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-input-validation.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-audit.php';
require_once __DIR__ . '/../includes/includes-student-registration.php';
require_once __DIR__ . '/../includes/includes-modalities.php';
require_once __DIR__ . '/../includes/includes-student-family.php';

RBAC::init($pdo);
$employeeId = (int)($_SESSION['user_id'] ?? 0);

/**
 * @return array{ok:bool,message?:string,email?:?string,personal_email?:?string}
 */
function masterfilesParseStudentEmails(array $post): array {
    $emailLocal = trim($post['email_local'] ?? '');
    $emailLegacy = trim($post['email'] ?? '');
    $personalEmail = trim($post['personal_email'] ?? '');

    $schoolInput = $emailLocal !== '' ? $emailLocal : $emailLegacy;
    $email = null;
    if ($schoolInput !== '') {
        $normalized = InputValidation::normalizeSchoolEmailInput($schoolInput);
        if ($normalized === false) {
            return [
                'ok' => false,
                'message' => 'School email must end with .coc (e.g. romeo.joi.coc or kesa.lumayog.coc) before @phinmaed.com.'
            ];
        }
        $email = $normalized;
    }

    if ($personalEmail !== '') {
        $validPersonal = InputValidation::validateEmail($personalEmail);
        if (!$validPersonal) {
            return ['ok' => false, 'message' => 'Invalid personal email format.'];
        }
        $personalEmail = $validPersonal;
    } else {
        $personalEmail = null;
    }

    if ($email === null && $personalEmail === null) {
        return ['ok' => false, 'message' => 'Enter a PHINMAEd school email and/or a personal email.'];
    }

    return ['ok' => true, 'email' => $email, 'personal_email' => $personalEmail];
}

function masterfilesCleanCsvCell($value): string {
    $value = (string)$value;
    if (strncmp($value, "\xEF\xBB\xBF", 3) === 0) {
        $value = substr($value, 3);
    }
    return trim($value, " \t\n\r\0\x0B\"'");
}

function masterfilesDetectCsvDelimiter(string $filePath): string {
    $sample = @file_get_contents($filePath, false, null, 0, 8192);
    if ($sample === false || $sample === '') {
        return ',';
    }
    if (strncmp($sample, "\xEF\xBB\xBF", 3) === 0) {
        $sample = substr($sample, 3);
    }
    $firstLine = strtok($sample, "\r\n");
    if ($firstLine === false || $firstLine === '') {
        return ',';
    }
    $comma = substr_count($firstLine, ',');
    $semi = substr_count($firstLine, ';');
    $tab = substr_count($firstLine, "\t");
    if ($semi > $comma && $semi >= $tab) {
        return ';';
    }
    if ($tab > $comma && $tab > $semi) {
        return "\t";
    }
    return ',';
}

/**
 * @return array<string, int>
 */
function masterfilesStudentsCsvHeaderMap(array $header): array {
    $normalized = [];
    foreach ($header as $i => $h) {
        $key = strtolower(masterfilesCleanCsvCell($h));
        $key = preg_replace('/[^a-z0-9]+/', ' ', $key);
        $key = trim((string)preg_replace('/\s+/', ' ', (string)$key));
        if ($key !== '') {
            $normalized[$key] = $i;
        }
    }
    $definitions = [
        'school_id' => ['school id', 'student id', 'student number', 'student no', 'id number'],
        'first_name' => ['first name', 'firstname', 'given name'],
        'middle_name' => ['middle name', 'middlename'],
        'last_name' => ['last name', 'lastname', 'surname', 'family name'],
        'program' => ['program', 'program code', 'course'],
        'year_level' => ['year level', 'yearlevel', 'year', 'level'],
        'school_email' => ['school email', 'email', 'phinmaed email', 'phinma email', 'institutional email'],
        'personal_email' => ['personal email', 'alternate email', 'backup email'],
        'campus' => ['campus'],
        'contact_number' => ['contact number', 'contact', 'mobile', 'phone'],
        'date_of_birth' => ['date of birth', 'birthdate', 'dob'],
        'gender' => ['gender'],
        'internal_scholarship' => ['internal scholarship', 'scholarship'],
        'external_scholarships' => ['external scholarships', 'external scholarship'],
        'modality' => ['modality'],
        'student_status' => ['student status', 'status'],
        'facebook_account' => ['facebook account', 'facebook', 'fb account'],
        'father_name' => ['father name'],
        'father_contact' => ['father contact'],
        'mother_name' => ['mother name'],
        'mother_contact' => ['mother contact'],
        'guardian_name' => ['guardian name'],
        'guardian_contact' => ['guardian contact'],
    ];
    $map = [];
    foreach ($definitions as $key => $labels) {
        foreach ($labels as $label) {
            if (isset($normalized[$label])) {
                $map[$key] = $normalized[$label];
                break;
            }
        }
    }
    return $map;
}

function masterfilesParseImportedFamily(array $row): ?array {
    $members = [];
    foreach (['father' => 1, 'mother' => 2, 'guardian' => 3] as $key => $relationshipId) {
        $name = trim(preg_replace('/\s+/u', ' ', (string)($row[$key . '_name'] ?? '')) ?? '');
        $contact = masterfilesOptionalImportMobile($row[$key . '_contact'] ?? '');
        if ($name === '' || $contact === '') continue;
        // CSV family names need not share the student's name or follow the
        // stricter two-word format used by the registration form.
        if (mb_strlen($name) > 200 || preg_match('/\p{L}/u', $name) !== 1) continue;
        $normalizedContact = InputValidation::parsePhilippineMobile($contact);
        if ($normalizedContact === false || !preg_match('/^09\d{9}$/', $normalizedContact)) continue;
        $members[] = [
            'id' => 0,
            'relationship_id' => $relationshipId,
            'name' => $name,
            'contact' => $normalizedContact,
        ];
    }
    return $members ?: null;
}

function masterfilesOptionalImportEmail($raw): string {
    $value = trim((string)$raw);
    return preg_match('/^[-–—]+$/u', $value) || strcasecmp($value, 'n/a') === 0 ? '' : $value;
}

function masterfilesOptionalImportMobile($raw): string {
    $value = trim((string)$raw);
    if (preg_match('/^[-–—]+$/u', $value) || strcasecmp($value, 'n/a') === 0) return '';
    // Spreadsheets sometimes export a whole phone number as a decimal ending in .0.
    if (preg_match('/^(\+?(?:9\d{9}|09\d{9}|639\d{9}))\.0+$/', $value, $parts)) return $parts[1];
    return $value;
}

function masterfilesSyncImportedFamily(PDO $pdo, int $studentId, array $members): void {
    $existing = studentFamilyFetch($pdo, $studentId);
    $byRelationship = [];
    foreach ($existing as $member) {
        $relationshipId = (int)$member['relationship_id'];
        if (!isset($byRelationship[$relationshipId])) $byRelationship[$relationshipId] = $member;
    }
    foreach ($members as $member) {
        $relationshipId = (int)$member['relationship_id'];
        if (isset($byRelationship[$relationshipId])) {
            $member['id'] = (int)$byRelationship[$relationshipId]['id'];
        }
        $byRelationship[$relationshipId] = $member;
    }
    studentFamilySync($pdo, $studentId, array_values($byRelationship));
}

/** @return int[] */
function masterfilesParseExternalScholarshipIds($value): array {
    if (is_string($value)) {
        $decoded = json_decode($value, true);
        $value = is_array($decoded) ? $decoded : preg_split('/[;,|]+/', $value);
    }
    if (!is_array($value)) return [];
    $ids = array_values(array_unique(array_filter(array_map('intval', $value), static fn($id) => $id > 0)));
    return $ids;
}

function masterfilesValidateInternalScholarship(PDO $pdo, int $scholarshipId): bool {
    if ($scholarshipId <= 0) return true;
    $stmt = $pdo->prepare("SELECT 1 FROM tbl_csdl_scholarships WHERE scholarship_id = ? AND scholarship_type = 'Internal' AND scholarship_status = 1");
    $stmt->execute([$scholarshipId]);
    return (bool)$stmt->fetchColumn();
}

/** @param int[] $scholarshipIds */
function masterfilesSyncExternalScholarships(PDO $pdo, int $studentId, array $scholarshipIds): void {
    $pdo->prepare('DELETE FROM tbl_csdl_student_scholarships WHERE student_id = ?')->execute([$studentId]);
    if ($scholarshipIds === []) return;

    $validStmt = $pdo->prepare("SELECT scholarship_id FROM tbl_csdl_scholarships WHERE scholarship_id = ? AND scholarship_type = 'External' AND scholarship_status = 1");
    $insertStmt = $pdo->prepare('INSERT IGNORE INTO tbl_csdl_student_scholarships (student_id, scholarship_id) VALUES (?, ?)');
    foreach ($scholarshipIds as $scholarshipId) {
        $validStmt->execute([$scholarshipId]);
        if ($validStmt->fetchColumn()) {
            $insertStmt->execute([$studentId, $scholarshipId]);
        }
    }
}

$action = $_GET['action'] ?? $_POST['action'] ?? null;

// Read JSON input for POST requests if $_POST is empty
$input = json_decode(file_get_contents('php://input'), true);
if (empty($_POST) && $input !== null) {
    $_POST = $input;
}

// Re-check action after merging input
if (!isset($action) || empty($action)) {
    $action = $_POST['action'] ?? 'list';
}

if ($action === 'reset_password' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['success' => false, 'message' => 'Use POST to reset a password.']);
    exit;
}

// Enforce CSRF for any state-changing action
$csrfProtectedActions = ['reset_password', 'create', 'update', 'toggle', 'delete', 'bulk_delete', 'import', 'save_period_access', 'approve_registration', 'reject_registration'];
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && in_array($action, $csrfProtectedActions, true)) {
    CSRFProtection::validateRequest();
}

try {
    $hasPersonalEmailColumn = false;
    try {
        $colStmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_personal_email'");
        $hasPersonalEmailColumn = (bool)$colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $hasPersonalEmailColumn = false;
    }
    $personalEmailSelect = $hasPersonalEmailColumn
        ? 's.student_personal_email AS personal_email,'
        : 'NULL AS personal_email,';

    $hasRegistrationStatusColumn = studentRegistrationColumnAvailable($pdo);
    $registrationSelect = $hasRegistrationStatusColumn
        ? 's.student_registration_status AS registration_status,'
        : "'approved' AS registration_status,";

    switch ($action) {
        case 'counts':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $countWhere = $hasRegistrationStatusColumn
                ? " WHERE s.student_registration_status IN ('approved', 'pending_finance')"
                : '';
            $countStmt = $pdo->query(
                "SELECT
                    COUNT(*) AS total_students,
                    SUM(CASE WHEN COALESCE(s.student_is_active, 0) = 1 THEN 1 ELSE 0 END) AS active_students,
                    SUM(CASE WHEN LOWER(COALESCE(ss.student_status_name, '')) = 'new' THEN 1 ELSE 0 END) AS new_students,
                    SUM(CASE WHEN LOWER(COALESCE(ss.student_status_name, '')) = 'continuing' THEN 1 ELSE 0 END) AS continuing_students
                 FROM tbl_csdl_students s
                 LEFT JOIN tbl_csdl_student_statuses ss ON ss.student_status_id = s.student_status_id
                 {$countWhere}"
            );
            $studentCounts = $countStmt->fetch(PDO::FETCH_ASSOC) ?: [];
            $totalStudents = (int)($studentCounts['total_students'] ?? 0);
            $activeStudents = (int)($studentCounts['active_students'] ?? 0);
            $pendingRegistrations = $hasRegistrationStatusColumn
                ? (int) $pdo->query("SELECT COUNT(*) FROM tbl_csdl_students WHERE student_registration_status = 'pending'")->fetchColumn()
                : 0;
            echo json_encode([
                'success' => true,
                'totalStudents' => $totalStudents,
                'activeStudents' => $activeStudents,
                'inactiveStudents' => max(0, $totalStudents - $activeStudents),
                'newStudents' => (int)($studentCounts['new_students'] ?? 0),
                'continuingStudents' => (int)($studentCounts['continuing_students'] ?? 0),
                'pendingRegistrations' => $pendingRegistrations,
            ]);
            break;

        case 'list':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $isPaginated = ($_GET['paginated'] ?? '') === '1';
            $page = max(1, (int)($_GET['page'] ?? 1));
            $perPage = min(100, max(10, (int)($_GET['per_page'] ?? 10)));
            $conditions = [];
            $params = [];

            if ($hasRegistrationStatusColumn) {
                $conditions[] = "s.student_registration_status IN ('approved', 'pending_finance')";
            }

            $programId = (int)($_GET['program_id'] ?? 0);
            if ($programId > 0) {
                $conditions[] = 's.student_program_id = ?';
                $params[] = $programId;
            }

            $yearLevelId = (int)($_GET['year_level_id'] ?? 0);
            if ($yearLevelId > 0) {
                $conditions[] = 's.student_year_level_id = ?';
                $params[] = $yearLevelId;
            }

            $statusId = (int)($_GET['status_id'] ?? 0);
            if ($statusId > 0) {
                $conditions[] = 's.student_status_id = ?';
                $params[] = $statusId;
            }

            $modality = strtolower(trim((string)($_GET['modality'] ?? '')));
            if ($modality !== '') {
                $conditions[] = 'm.modality_code = ?';
                $params[] = $modality;
            }

            $search = trim((string)($_GET['search'] ?? ''));
            if ($search !== '') {
                $search = mb_substr($search, 0, 100);
                $like = '%' . $search . '%';
                $conditions[] = "(
                    s.student_school_id LIKE ? OR
                    CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) LIKE ? OR
                    s.student_email LIKE ? OR
                    " . ($hasPersonalEmailColumn ? 's.student_personal_email LIKE ? OR' : '') . "
                    p.program_name LIKE ? OR
                    yl.year_level_name LIKE ? OR
                    c.campus_name LIKE ? OR
                    sch.scholarship_code LIKE ? OR
                    ext.external_scholarship_codes LIKE ?
                )";
                $searchFields = $hasPersonalEmailColumn ? 9 : 8;
                for ($i = 0; $i < $searchFields; $i++) {
                    $params[] = $like;
                }
            }

            $listWhere = $conditions ? ' WHERE ' . implode(' AND ', $conditions) : '';
            $joins = "
                 LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                 LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id
                 LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                 LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                 LEFT JOIN (
                    SELECT ss.student_id,
                           GROUP_CONCAT(es.scholarship_id ORDER BY es.scholarship_name SEPARATOR ',') AS external_scholarship_ids,
                           GROUP_CONCAT(es.scholarship_name ORDER BY es.scholarship_name SEPARATOR '; ') AS external_scholarship_names,
                           GROUP_CONCAT(es.scholarship_code ORDER BY es.scholarship_code SEPARATOR '; ') AS external_scholarship_codes
                    FROM tbl_csdl_student_scholarships ss
                    JOIN tbl_csdl_scholarships es ON es.scholarship_id = ss.scholarship_id AND es.scholarship_type = 'External'
                    GROUP BY ss.student_id
                 ) ext ON ext.student_id = s.student_id
                 LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                 LEFT JOIN tbl_csdl_modalities m ON m.modality_id = s.student_modality_id
                 LEFT JOIN tbl_csdl_student_statuses ss ON ss.student_status_id = s.student_status_id";

            $filteredTotal = 0;
            $limitSql = '';
            if ($isPaginated) {
                $totalStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_students s {$joins} {$listWhere}");
                $totalStmt->execute($params);
                $filteredTotal = (int)$totalStmt->fetchColumn();
                $totalPages = max(1, (int)ceil($filteredTotal / $perPage));
                $page = min($page, $totalPages);
                $offset = ($page - 1) * $perPage;
                $limitSql = " LIMIT {$perPage} OFFSET {$offset}";
            }

            $stmt = $pdo->prepare(
                "SELECT 
                    s.student_id AS id,
                    s.student_school_id AS school_id,
                    s.student_first_name AS first_name,
                    s.student_middle_name AS middle_name,
                    s.student_last_name AS last_name,
                    s.student_date_of_birth AS date_of_birth,
                    s.student_gender AS gender,
                    s.student_contact_number AS contact_number,
                    s.student_email AS email,
                    {$personalEmailSelect}
                    {$registrationSelect}
                    s.student_program_id AS program_id,
                    s.student_year_level_id AS year_level_id,
                    s.student_scholarship_id AS scholarship_id,
                    s.student_scholarship_id AS internal_scholarship_id,
                    COALESCE(ext.external_scholarship_ids, '') AS external_scholarship_ids,
                    s.student_campus_id AS campus_id,
                    s.student_is_active AS is_active,
                    s.student_status_id AS status_id,
                    m.modality_code AS modality,
                    m.modality_name AS modality_name,
                    s.student_fb_account AS fb_account,
                    s.student_created_at AS created_at,
                    p.program_code AS program_code,
                    p.program_name AS program_name,
                    d.department_name AS department_name,
                    yl.year_level_code AS year_level_code,
                    yl.year_level_name AS year_level_name,
                    sch.scholarship_name AS scholarship_name,
                    sch.scholarship_name AS internal_scholarship_name,
                    sch.scholarship_code AS internal_scholarship_code,
                    COALESCE(ext.external_scholarship_names, '') AS external_scholarship_names,
                    COALESCE(ext.external_scholarship_codes, '') AS external_scholarship_codes,
                    c.campus_name AS campus_name,
                    ss.student_status_name AS status_name
                 FROM tbl_csdl_students s
                 {$joins}
                 {$listWhere}
                 ORDER BY s.student_last_name ASC, s.student_first_name ASC, s.student_id ASC
                 {$limitSql}"
            );
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            studentFamilyAttach($pdo, $rows);

            $response = [
                'success' => true,
                'rows' => $rows
            ];
            if ($isPaginated) {
                $response['pagination'] = [
                    'page' => $page,
                    'perPage' => $perPage,
                    'total' => $filteredTotal,
                    'totalPages' => max(1, (int)ceil($filteredTotal / $perPage)),
                ];
            }
            echo json_encode($response);
            break;

        case 'create':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.create', 'You do not have permission to create students');
            try {
                $familyDetails = studentFamilyParse($_POST['family_details'] ?? []);
            } catch (InvalidArgumentException $e) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => $e->getMessage()]);
                break;
            }
            $schoolId = trim($_POST['school_id'] ?? '');
            $firstName = trim($_POST['first_name'] ?? '');
            $middleName = trim($_POST['middle_name'] ?? '');
            $lastName = trim($_POST['last_name'] ?? '');
            $dateOfBirth = $_POST['date_of_birth'] ?? null;
            $gender = $_POST['gender'] ?? 'Male';
            $contactNumber = trim($_POST['contact_number'] ?? '');
            $programId = intval($_POST['program_id'] ?? 0);
            $yearLevelId = intval($_POST['year_level_id'] ?? 0);
            $scholarshipId = intval($_POST['internal_scholarship_id'] ?? $_POST['scholarship_id'] ?? 0);
            $externalScholarshipIds = masterfilesParseExternalScholarshipIds($_POST['external_scholarship_ids'] ?? []);
            $campusId = intval($_POST['campus_id'] ?? 0);
            $modality = $_POST['modality'] ?? 'flex';
            $modalityId = modalityIdForCode($pdo, (string)$modality);
            if ($modalityId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select an active modality.']);
                exit;
            }
            $fbAccount = trim($_POST['fb_account'] ?? '');
            $statusId = intval($_POST['status_id'] ?? 1);

            if ($schoolId === '' || $firstName === '' || $lastName === '' || $programId <= 0 || $yearLevelId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School ID, First Name, Last Name, Program, and Year Level are required.']);
                exit;
            }

            if (!masterfilesValidateInternalScholarship($pdo, $scholarshipId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select a valid internal scholarship.']);
                exit;
            }

            if (!InputValidation::validateSchoolId($schoolId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid school ID format.']);
                exit;
            }

            $checkStmt = $pdo->prepare('SELECT student_id FROM tbl_csdl_students WHERE student_school_id = ? LIMIT 1');
            $checkStmt->execute([$schoolId]);
            if ($checkStmt->fetch()) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School ID already exists.']);
                exit;
            }

            $parsedEmails = masterfilesParseStudentEmails($_POST);
            if (!$parsedEmails['ok']) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => $parsedEmails['message']]);
                exit;
            }
            $email = $parsedEmails['email'];
            $personalEmail = $parsedEmails['personal_email'];

            if (!empty($email)) {
                $dupEmail = $pdo->prepare('SELECT student_id FROM tbl_csdl_students WHERE LOWER(student_email) = LOWER(?) LIMIT 1');
                $dupEmail->execute([$email]);
                if ($dupEmail->fetch()) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'School email is already registered to another student.']);
                    exit;
                }
            }

            $parsedContact = InputValidation::parsePhilippineMobile($contactNumber);
            if ($contactNumber !== '' && $parsedContact === false) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid contact number. Use 9XXXXXXXXX, 09XXXXXXXXX, or 639XXXXXXXXX.']);
                exit;
            }
            $contactNumber = $parsedContact;

            if ($dateOfBirth !== null && $dateOfBirth !== '') {
                $parsedDob = InputValidation::parseFlexibleDate($dateOfBirth);
                if ($parsedDob === false) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid date of birth. Use YYYY-MM-DD or a normal date (Excel formats are accepted).']);
                    exit;
                }
                $dateOfBirth = $parsedDob;
            } else {
                $dateOfBirth = null;
            }

            $passwordHash = password_hash($schoolId, PASSWORD_DEFAULT);

            $columns = [
                'student_school_id', 'student_first_name', 'student_middle_name', 'student_last_name',
                'student_date_of_birth', 'student_gender', 'student_contact_number', 'student_email',
            ];
            $values = [
                $schoolId, $firstName, $middleName ?: null, $lastName,
                $dateOfBirth, $gender, $contactNumber, $email,
            ];
            if ($hasPersonalEmailColumn) {
                $columns[] = 'student_personal_email';
                $values[] = $personalEmail;
            }
            array_push(
                $columns,
                'student_password_hash', 'student_program_id', 'student_year_level_id',
                'student_scholarship_id', 'student_campus_id', 'student_modality_id',
                'student_fb_account', 'student_is_active'
            );
            array_push(
                $values,
                $passwordHash, $programId, $yearLevelId,
                $scholarshipId ?: null, $campusId ?: null, $modalityId,
                $fbAccount ?: null, 1
            );
            if ($hasRegistrationStatusColumn) {
                $columns[] = 'student_registration_status';
                $values[] = 'pending_finance';
            }
            $columns[] = 'student_status_id';
            $values[] = $statusId;

            $placeholders = implode(', ', array_fill(0, count($columns), '?'));
            $pdo->beginTransaction();
            $stmt = $pdo->prepare(
                'INSERT INTO tbl_csdl_students (' . implode(', ', $columns) . ') VALUES (' . $placeholders . ')'
            );
            $stmt->execute($values);
            $studentId = (int)$pdo->lastInsertId();
            masterfilesSyncExternalScholarships($pdo, $studentId, $externalScholarshipIds);
            if (array_key_exists('family_details', $_POST)) {
                studentFamilySync($pdo, $studentId, $familyDetails);
            }
            $pdo->commit();

            // Manual creation intentionally does not send an email to the student.
            // Assessment still receives the normal in-app pending-balance notification.
            if ($hasRegistrationStatusColumn) {
                try {
                    $studentRow = studentRegistrationFetchById($pdo, $studentId);
                    if ($studentRow) {
                        studentRegistrationNotifyFinanceEmployees($pdo, $studentRow);
                    }
                } catch (Throwable $e) {
                    error_log('Manual student pending-balance notification error: ' . $e->getMessage());
                }
            }

            echo json_encode([
                'success' => true,
                'message' => $hasRegistrationStatusColumn
                    ? 'Student added successfully and is awaiting balance setup.'
                    : 'Student added successfully.',
                'student_id' => $studentId,
            ]);
            break;

        case 'list_pending':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            if (!$hasRegistrationStatusColumn) {
                echo json_encode(['success' => true, 'rows' => [], 'pendingRegistrations' => 0]);
                break;
            }
            $stmt = $pdo->query(
                "SELECT 
                    s.student_id AS id,
                    s.student_school_id AS school_id,
                    s.student_first_name AS first_name,
                    s.student_middle_name AS middle_name,
                    s.student_last_name AS last_name,
                    s.student_date_of_birth AS date_of_birth,
                    s.student_gender AS gender,
                    s.student_contact_number AS contact_number,
                    s.student_email AS email,
                    {$personalEmailSelect}
                    s.student_program_id AS program_id,
                    s.student_year_level_id AS year_level_id,
                    s.student_scholarship_id AS scholarship_id,
                    s.student_scholarship_id AS internal_scholarship_id,
                    COALESCE(ext.external_scholarship_ids, '') AS external_scholarship_ids,
                    s.student_campus_id AS campus_id,
                    m.modality_code AS modality,
                    m.modality_name AS modality_name,
                    s.student_fb_account AS fb_account,
                    s.student_created_at AS created_at,
                    s.student_is_suspicious AS is_suspicious,
                    s.student_suspicious_reason AS suspicious_reason,
                    s.student_suspicious_details AS suspicious_details,
                    p.program_name AS program_name,
                    yl.year_level_name AS year_level_name,
                    sch.scholarship_name AS scholarship_name,
                    sch.scholarship_name AS internal_scholarship_name,
                    COALESCE(ext.external_scholarship_names, '') AS external_scholarship_names,
                    c.campus_name AS campus_name
                 FROM tbl_csdl_students s
                 LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                 LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                 LEFT JOIN tbl_csdl_modalities m ON m.modality_id = s.student_modality_id
                 LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                 LEFT JOIN (
                    SELECT ss.student_id,
                           GROUP_CONCAT(es.scholarship_id ORDER BY es.scholarship_name SEPARATOR ',') AS external_scholarship_ids,
                           GROUP_CONCAT(es.scholarship_name ORDER BY es.scholarship_name SEPARATOR '; ') AS external_scholarship_names
                    FROM tbl_csdl_student_scholarships ss
                    JOIN tbl_csdl_scholarships es ON es.scholarship_id = ss.scholarship_id AND es.scholarship_type = 'External'
                    GROUP BY ss.student_id
                 ) ext ON ext.student_id = s.student_id
                 LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                 WHERE s.student_registration_status = 'pending'
                 ORDER BY s.student_is_suspicious DESC, s.student_created_at ASC, s.student_last_name ASC"
            );
            $pendingRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            studentFamilyAttach($pdo, $pendingRows);
            
            // Parse JSON suspicious_details for each row
            foreach ($pendingRows as &$row) {
                if (!empty($row['suspicious_details'])) {
                    $row['suspicious_details'] = json_decode($row['suspicious_details'], true);
                } else {
                    $row['suspicious_details'] = null;
                }
            }
            
            echo json_encode([
                'success' => true,
                'rows' => $pendingRows,
                'pendingRegistrations' => count($pendingRows),
            ]);
            break;

        case 'approve_registration':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.edit', 'You do not have permission to approve registrations');
            if (!$hasRegistrationStatusColumn) {
                http_response_code(503);
                echo json_encode(['success' => false, 'message' => 'Registration approval is not available.']);
                exit;
            }
            $id = (int) ($_POST['student_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student ID is required.']);
                exit;
            }
            $pendingStmt = $pdo->prepare("SELECT student_id FROM tbl_csdl_students WHERE student_id = ? AND student_registration_status = 'pending' LIMIT 1");
            $pendingStmt->execute([$id]);
            if (!$pendingStmt->fetch()) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Pending registration not found.']);
                exit;
            }
            // CSDL approval grants account access; Assessment still needs to set up the balance.
            $approveStmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_registration_status = 'pending_finance', student_is_active = 1 WHERE student_id = ? AND student_registration_status = 'pending'");
            $approveStmt->execute([$id]);
            if ($approveStmt->rowCount() === 0) {
                http_response_code(409);
                echo json_encode(['success' => false, 'message' => 'This registration has already been reviewed.']);
                exit;
            }

            $studentRow = studentRegistrationFetchById($pdo, $id);
            $emailResult = ['ok' => false, 'sent_to' => [], 'failed' => [], 'message' => ''];
            if ($studentRow) {
                try {
                    $emailResult = studentRegistrationSendPendingFinanceEmail($pdo, $studentRow);
                    studentRegistrationNotifyFinanceEmployees($pdo, $studentRow);
                } catch (Throwable $e) {
                    error_log('Registration finance routing error: ' . $e->getMessage());
                    $emailResult = [
                        'ok' => false,
                        'sent_to' => [],
                        'failed' => [],
                        'message' => 'Student may now sign in, but must wait for Assessment balance setup before applying for a loan. Student notification could not be sent.',
                    ];
                }
            }

            echo json_encode([
                'success' => true,
                'message' => $emailResult['message'] ?: 'Student may now sign in. Loan applications remain unavailable until Assessment sets up the balance.',
                'email_sent' => $emailResult['ok'],
                'email_sent_to' => $emailResult['sent_to'],
                'email_failed' => $emailResult['failed'],
            ]);
            break;

        case 'reject_registration':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.edit', 'You do not have permission to reject registrations');
            if (!$hasRegistrationStatusColumn) {
                http_response_code(503);
                echo json_encode(['success' => false, 'message' => 'Registration rejection is not available.']);
                exit;
            }
            $id = (int) ($_POST['student_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student ID is required.']);
                exit;
            }
            $studentRow = studentRegistrationFetchById($pdo, $id);
            $rejectStmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_registration_status = 'rejected', student_is_active = 0 WHERE student_id = ? AND student_registration_status = 'pending'");
            $rejectStmt->execute([$id]);
            if ($rejectStmt->rowCount() === 0) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Pending registration not found.']);
                exit;
            }
            try {
                AuditLogger::log($pdo, 'REJECT_REGISTRATION', 'CSDL rejected a pending registration.', $id, $employeeId);
            } catch (Throwable $e) {
                error_log('Registration rejection audit error: ' . $e->getMessage());
            }
            $emailResult = ['ok' => false, 'sent_to' => [], 'failed' => [], 'message' => ''];
            if ($studentRow) {
                try {
                    $emailResult = studentRegistrationSendRejectedEmail($pdo, $studentRow);
                } catch (Throwable $e) {
                    error_log('Registration rejection email queue error: ' . $e->getMessage());
                }
            }
            echo json_encode([
                'success' => true,
                'message' => $emailResult['ok']
                    ? 'Registration rejected. The student notification was queued.'
                    : 'Registration rejected. The student notification could not be queued.',
                'email_sent' => $emailResult['ok'],
                'email_sent_to' => $emailResult['sent_to'],
                'email_failed' => $emailResult['failed'],
            ]);
            break;

        case 'update':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.edit', 'You do not have permission to edit students');
            try {
                $familyDetails = studentFamilyParse($_POST['family_details'] ?? []);
            } catch (InvalidArgumentException $e) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => $e->getMessage()]);
                break;
            }
            $id = intval($_POST['student_id'] ?? 0);
            $schoolId = trim($_POST['school_id'] ?? '');
            $firstName = trim($_POST['first_name'] ?? '');
            $middleName = trim($_POST['middle_name'] ?? '');
            $lastName = trim($_POST['last_name'] ?? '');
            $dateOfBirth = $_POST['date_of_birth'] ?? null;
            $gender = $_POST['gender'] ?? 'Male';
            $contactNumber = trim($_POST['contact_number'] ?? '');
            $programId = intval($_POST['program_id'] ?? 0);
            $yearLevelId = intval($_POST['year_level_id'] ?? 0);
            $scholarshipId = intval($_POST['internal_scholarship_id'] ?? $_POST['scholarship_id'] ?? 0);
            $externalScholarshipIds = masterfilesParseExternalScholarshipIds($_POST['external_scholarship_ids'] ?? []);
            $campusId = intval($_POST['campus_id'] ?? 0);
            $modality = $_POST['modality'] ?? 'flex';
            $modalityId = modalityIdForCode($pdo, (string)$modality);
            if ($modalityId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select an active modality.']);
                exit;
            }
            $fbAccount = trim($_POST['fb_account'] ?? '');
            $statusId = intval($_POST['status_id'] ?? 1);

            if ($id <= 0 || empty($schoolId) || empty($firstName) || empty($lastName) || $programId <= 0 || $yearLevelId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student ID, School ID, First Name, Last Name, Program, and Year Level are required.']);
                exit;
            }

            if (!masterfilesValidateInternalScholarship($pdo, $scholarshipId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select a valid internal scholarship.']);
                exit;
            }

            if (!InputValidation::validateSchoolId($schoolId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid school ID format.']);
                exit;
            }

            // Check if school_id already exists for another student
            $checkStmt = $pdo->prepare("SELECT student_id FROM tbl_csdl_students WHERE student_school_id = ? AND student_id != ? LIMIT 1");
            $checkStmt->execute([$schoolId, $id]);
            if ($checkStmt->fetch()) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'School ID already exists.']);
                exit;
            }

            $parsedEmails = masterfilesParseStudentEmails($_POST);
            if (!$parsedEmails['ok']) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => $parsedEmails['message']]);
                exit;
            }
            $email = $parsedEmails['email'];
            $personalEmail = $parsedEmails['personal_email'];

            if (!empty($email)) {
                $dupEmail = $pdo->prepare("SELECT student_id FROM tbl_csdl_students WHERE LOWER(student_email) = LOWER(?) AND student_id != ? LIMIT 1");
                $dupEmail->execute([$email, $id]);
                if ($dupEmail->fetch()) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'School email is already registered to another student.']);
                    exit;
                }
            }

            $parsedContact = InputValidation::parsePhilippineMobile($contactNumber);
            if ($contactNumber !== '' && $parsedContact === false) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid contact number. Use 9XXXXXXXXX, 09XXXXXXXXX, or 639XXXXXXXXX.']);
                exit;
            }
            $contactNumber = $parsedContact;

            if ($dateOfBirth !== null && $dateOfBirth !== '') {
                $parsedDob = InputValidation::parseFlexibleDate($dateOfBirth);
                if ($parsedDob === false) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid date of birth. Use YYYY-MM-DD or a normal date (Excel formats are accepted).']);
                    exit;
                }
                $dateOfBirth = $parsedDob;
            } else {
                $dateOfBirth = null;
            }

            $pdo->beginTransaction();
            if ($hasPersonalEmailColumn) {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_school_id = ?, student_first_name = ?, student_middle_name = ?, student_last_name = ?, student_date_of_birth = ?, student_gender = ?, student_contact_number = ?, student_email = ?, student_personal_email = ?, student_program_id = ?, student_year_level_id = ?, student_scholarship_id = ?, student_campus_id = ?, student_modality_id = ?, student_fb_account = ?, student_status_id = ? WHERE student_id = ?");
                $stmt->execute([$schoolId, $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender, $contactNumber, $email, $personalEmail, $programId, $yearLevelId, $scholarshipId ?: null, $campusId ?: null, $modalityId, $fbAccount ?: null, $statusId, $id]);
            } else {
                $stmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_school_id = ?, student_first_name = ?, student_middle_name = ?, student_last_name = ?, student_date_of_birth = ?, student_gender = ?, student_contact_number = ?, student_email = ?, student_program_id = ?, student_year_level_id = ?, student_scholarship_id = ?, student_campus_id = ?, student_modality_id = ?, student_fb_account = ?, student_status_id = ? WHERE student_id = ?");
                $stmt->execute([$schoolId, $firstName, $middleName ?: null, $lastName, $dateOfBirth ?: null, $gender, $contactNumber ?: null, $email, $programId, $yearLevelId, $scholarshipId ?: null, $campusId ?: null, $modalityId, $fbAccount ?: null, $statusId, $id]);
            }
            masterfilesSyncExternalScholarships($pdo, $id, $externalScholarshipIds);
            if (array_key_exists('family_details', $_POST)) {
                studentFamilySync($pdo, $id, $familyDetails);
            }
            $pdo->commit();
            
            echo json_encode(['success' => true, 'message' => 'Student updated successfully.']);
            break;

        case 'reset_password':
            if (($_SESSION['user_type'] ?? '') !== 'employee' || $employeeId <= 0) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Employee authentication is required.']);
                break;
            }
            RBAC::requirePermission($employeeId, 'csdl.masterfiles.students.edit', 'You do not have permission to reset student passwords');
            $id = filter_var($_POST['student_id'] ?? null, FILTER_VALIDATE_INT);
            if (!$id || $id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'A valid student ID is required.']);
                break;
            }

            $pdo->beginTransaction();
            $accountStmt = $pdo->prepare("SELECT student_school_id FROM tbl_csdl_students WHERE student_id = ? FOR UPDATE");
            $accountStmt->execute([$id]);
            $schoolId = $accountStmt->fetchColumn();
            if ($schoolId === false || trim((string)$schoolId) === '') {
                $pdo->rollBack();
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'The student account could not be found.']);
                break;
            }
            // The existing policy requires a school-ID password to be changed at sign-in.
            $newHash = password_hash((string)$schoolId, PASSWORD_DEFAULT);
            $update = $pdo->prepare("UPDATE tbl_csdl_students SET student_password_hash = ?, student_password_changed_at = NOW(), student_updated_at = NOW() WHERE student_id = ?");
            $update->execute([$newHash, $id]);
            $revoke = $pdo->prepare("DELETE FROM tbl_csdl_active_sessions WHERE active_session_user_type = ? AND active_session_user_id = ?");
            $revoke->execute(['student', $id]);
            $clearOtp = $pdo->prepare("DELETE FROM tbl_csdl_password_resets WHERE pr_student_id = ?");
            $clearOtp->execute([$id]);
            $unlock = $pdo->prepare("UPDATE tbl_csdl_account_security SET security_failed_login_attempts = 0, security_account_locked_until = NULL WHERE security_student_id = ?");
            $unlock->execute([$id]);
            $clearAttempts = $pdo->prepare("DELETE FROM tbl_csdl_rate_limits WHERE rate_limit_student_id = ? AND rate_limit_action = 'login_failed'");
            $clearAttempts->execute([$id]);
            AuditLogger::log($pdo, 'RESET_PASSWORD', json_encode([
                'target_user_type' => 'student', 'target_user_id' => $id,
                'reset_to_default' => true,
            ]), $id, $employeeId);
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Password reset to the school ID. The account must change its password at the next sign-in.']);
            break;

        case 'toggle':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.edit', 'You do not have permission to edit students');
            $id = intval($_POST['student_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid student ID.']);
                exit;
            }

            $stmt = $pdo->prepare("UPDATE tbl_csdl_students SET student_is_active = CASE WHEN COALESCE(student_is_active, 1) = 1 THEN 0 ELSE 1 END WHERE student_id = ?");
            $stmt->execute([$id]);
            echo json_encode(['success' => true, 'message' => 'Student status updated successfully.']);
            break;

        case 'delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.delete', 'You do not have permission to delete students');
            $id = intval($_POST['student_id'] ?? 0);
            if ($id <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student ID is required.']);
                exit;
            }

            $pdo->beginTransaction();
            $existsStmt = $pdo->prepare('SELECT 1 FROM tbl_csdl_students WHERE student_id = ? FOR UPDATE');
            $existsStmt->execute([$id]);
            if (!$existsStmt->fetchColumn()) {
                $pdo->rollBack();
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Student record was not found.']);
                break;
            }
            $loanCountStmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans WHERE loan_student_id = ?');
            $loanCountStmt->execute([$id]);
            if ((int)$loanCountStmt->fetchColumn() > 0) {
                $pdo->rollBack();
                http_response_code(409);
                echo json_encode(['success' => false, 'message' => 'This student has loan applications and cannot be deleted. Deactivate the account to keep its loan history.']);
                break;
            }
            $stmt = $pdo->prepare("DELETE FROM tbl_csdl_students WHERE student_id = ?");
            try {
                $stmt->execute([$id]);
            } catch (PDOException $deleteError) {
                $pdo->rollBack();
                if ($deleteError->getCode() !== '23000') throw $deleteError;
                http_response_code(409);
                echo json_encode(['success' => false, 'message' => 'This student is linked to another record and cannot be deleted.']);
                break;
            }
            if ($stmt->rowCount() !== 1) {
                $pdo->rollBack();
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Student record was not found.']);
                break;
            }
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Student deleted successfully.']);
            break;

        case 'bulk_delete':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.delete', 'You do not have permission to delete students');

            $rawIds = $_POST['student_ids'] ?? [];
            if (!is_array($rawIds)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student IDs must be provided as a list.']);
                exit;
            }

            $ids = array_values(array_unique(array_filter(
                array_map('intval', $rawIds),
                static fn(int $id): bool => $id > 0
            )));
            if (count($ids) === 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select at least one student to delete.']);
                exit;
            }
            if (count($ids) > 100) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'You can delete up to 100 students at a time.']);
                exit;
            }

            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $pdo->beginTransaction();
            $studentStmt = $pdo->prepare(
                "SELECT student_id, student_school_id, student_first_name, student_last_name
                 FROM tbl_csdl_students
                 WHERE student_id IN ({$placeholders}) FOR UPDATE"
            );
            $studentStmt->execute($ids);
            $studentRows = $studentStmt->fetchAll(PDO::FETCH_ASSOC);
            $studentsById = [];
            foreach ($studentRows as $studentRow) {
                $studentsById[(int)$studentRow['student_id']] = $studentRow;
            }
            $loanCountStmt = $pdo->prepare("SELECT loan_student_id, COUNT(*) AS loan_count FROM tbl_csdl_loans WHERE loan_student_id IN ({$placeholders}) GROUP BY loan_student_id");
            $loanCountStmt->execute($ids);
            $loanCounts = [];
            foreach ($loanCountStmt->fetchAll(PDO::FETCH_ASSOC) as $loanRow) {
                $loanCounts[(int)$loanRow['loan_student_id']] = (int)$loanRow['loan_count'];
            }

            $deleteStmt = $pdo->prepare("DELETE FROM tbl_csdl_students WHERE student_id = ?");
            $deletedIds = [];
            $failed = [];

            try {
                foreach ($ids as $id) {
                    $student = $studentsById[$id] ?? null;
                    if ($student === null) {
                        $failed[] = [
                            'student_id' => $id,
                            'school_id' => '',
                            'name' => '',
                            'reason' => 'Student record was not found.'
                        ];
                        continue;
                    }
                    if (($loanCounts[$id] ?? 0) > 0) {
                        $failed[] = [
                            'student_id' => $id,
                            'school_id' => $student['student_school_id'] ?? '',
                            'name' => trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? '')),
                            'reason' => 'Student has loan applications. Deactivate the account to keep its loan history.'
                        ];
                        continue;
                    }

                    try {
                        $deleteStmt->execute([$id]);
                        if ($deleteStmt->rowCount() === 1) {
                            $deletedIds[] = $id;
                        } else {
                            $failed[] = [
                                'student_id' => $id,
                                'school_id' => $student['student_school_id'] ?? '',
                                'name' => trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? '')),
                                'reason' => 'Student record was not found.'
                            ];
                        }
                    } catch (PDOException $deleteError) {
                        $failed[] = [
                            'student_id' => $id,
                            'school_id' => $student['student_school_id'] ?? '',
                            'name' => trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? '')),
                            'reason' => 'This student is linked to another record and could not be deleted.'
                        ];
                    }
                }
                $pdo->commit();
            } catch (Throwable $bulkDeleteError) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $bulkDeleteError;
            }

            $deletedCount = count($deletedIds);
            $failedCount = count($failed);
            echo json_encode([
                'success' => $deletedCount > 0,
                'message' => $deletedCount > 0
                    ? "{$deletedCount} student" . ($deletedCount === 1 ? '' : 's') . ' deleted successfully.'
                    : 'No students were deleted.',
                'deleted_count' => $deletedCount,
                'deleted_ids' => $deletedIds,
                'failed_count' => $failedCount,
                'failed' => $failed
            ]);
            break;

        case 'get_programs':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $stmt = $pdo->query("SELECT program_id, program_code, program_name FROM tbl_csdl_programs WHERE program_status = 1 ORDER BY program_name ASC");
            $programs = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'programs' => $programs]);
            break;

        case 'get_year_levels':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $stmt = $pdo->query("SELECT year_level_id, year_level_code, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_code ASC");
            $yearLevels = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'year_levels' => $yearLevels]);
            break;

        case 'get_scholarships':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $stmt = $pdo->query("SELECT scholarship_id, scholarship_name, scholarship_code, scholarship_type FROM tbl_csdl_scholarships WHERE scholarship_status = 1 ORDER BY scholarship_type, scholarship_name ASC");
            $scholarships = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'scholarships' => $scholarships]);
            break;

        case 'get_campuses':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $stmt = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses ORDER BY campus_name ASC");
            $campuses = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'campuses' => $campuses]);
            break;

        case 'get_student_statuses':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view students');
            $stmt = $pdo->query("SELECT student_status_id, student_status_name FROM tbl_csdl_student_statuses ORDER BY student_status_id ASC");
            $statuses = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'statuses' => $statuses]);
            break;

        case 'get_modalities':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view modalities');
            $modalities = $pdo->query('SELECT modality_code, modality_name FROM tbl_csdl_modalities WHERE modality_status = 1 ORDER BY modality_id')->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'modalities' => $modalities]);
            break;

        case 'get_period_access':
            RBAC::requireMasterfileRead($employeeId, 'students', 'You do not have permission to view period access');
            $studentId = intval($_GET['student_id'] ?? 0);
            if ($studentId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student ID is required.']);
                exit;
            }
            
            // Get all periods
            $periodsStmt = $pdo->query("SELECT app_period_id, app_period_name, app_period_status FROM tbl_csdl_application_periods ORDER BY app_period_id ASC");
            $periods = $periodsStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Get student's granted access
            $accessStmt = $pdo->prepare("SELECT access_period_id AS period_id, access_notes FROM tbl_csdl_student_period_access WHERE access_student_id = ?");
            $accessStmt->execute([$studentId]);
            $studentAccess = $accessStmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'periods' => $periods,
                'studentAccess' => $studentAccess
            ]);
            break;

        case 'save_period_access':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.edit', 'You do not have permission to update period access');
            error_log("Save Period Access - POST data: " . json_encode($_POST));
            
            $studentId = intval($_POST['student_id'] ?? 0);
            $periodIds = $_POST['period_ids'] ?? [];
            $notes = trim($_POST['notes'] ?? '');
            $employeeId = intval($_SESSION['user_id'] ?? 0);
            
            error_log("Save Period Access - Parsed: studentId=$studentId, employeeId=$employeeId, periodIds=" . json_encode($periodIds));
            
            if ($studentId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Student ID is required.']);
                exit;
            }
            
            if ($employeeId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Employee session not found.']);
                exit;
            }
            
            if (!is_array($periodIds)) {
                $periodIds = [];
            }
            
            $pdo->beginTransaction();
            
            try {
                // Delete all existing access for this student
                $deleteStmt = $pdo->prepare("DELETE FROM tbl_csdl_student_period_access WHERE access_student_id = ?");
                $deleteStmt->execute([$studentId]);
                error_log("Deleted existing access for student $studentId");
                
                // Insert new access grants
                if (!empty($periodIds)) {
                    $insertStmt = $pdo->prepare("INSERT INTO tbl_csdl_student_period_access (access_student_id, access_period_id, access_granted_by, access_notes) VALUES (?, ?, ?, ?)");
                    foreach ($periodIds as $periodId) {
                        $periodId = intval($periodId);
                        if ($periodId > 0) {
                            $insertStmt->execute([$studentId, $periodId, $employeeId, $notes]);
                            error_log("Inserted access: student=$studentId, period=$periodId, employee=$employeeId");
                        }
                    }
                }
                
                $pdo->commit();
                error_log("Period access saved successfully for student $studentId");
                echo json_encode(['success' => true, 'message' => 'Period access updated successfully.']);
            } catch (Exception $e) {
                $pdo->rollBack();
                error_log("Period access save failed: " . $e->getMessage());
                throw $e;
            }
            break;

        case 'import':
            RBAC::requireMasterfilesGranularOrManage($employeeId, 'csdl.masterfiles.students.create', 'You do not have permission to import students');
            // Bulk imports only create or update student records. They do not
            // enqueue email notifications for imported students.
            if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_FILES['file'])) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'File upload required.']);
                exit;
            }

            $file = $_FILES['file'];
            $fileExt = strtolower(pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
            $allowedTypes = [
                'text/csv',
                'text/plain',
                'application/csv',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/octet-stream',
            ];
            $allowedExtensions = ['csv', 'xls', 'xlsx'];

            [$uploadValid, $uploadMessage] = UploadSecurity::validateUploadedFile(
                $file,
                $allowedExtensions,
                $allowedTypes,
                250 * 1024 * 1024
            );
            if (!$uploadValid) {
                http_response_code(400);
                if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                    $uploadMessage = 'Invalid file type. Only CSV and Excel files are allowed.';
                }
                echo json_encode(['success' => false, 'message' => $uploadMessage]);
                exit;
            }

            $rows = null;
            $errors = [];
            $addImportError = static function (string $message) use (&$errors): void {
                if (count($errors) < 100) {
                    $errors[] = $message;
                }
            };

            try {
                if ($fileExt === 'csv') {
                    $delimiter = masterfilesDetectCsvDelimiter($file['tmp_name']);
                    $handle = fopen($file['tmp_name'], 'r');
                    if ($handle === false) {
                        throw new Exception('Failed to open CSV file.');
                    }
                    $header = fgetcsv($handle, 0, $delimiter);
                    if ($header === false || (count($header) === 1 && trim((string)$header[0]) === '')) {
                        fclose($handle);
                        throw new Exception('Invalid CSV file format.');
                    }
                    $header = array_map('masterfilesCleanCsvCell', $header);
                    $headerMap = masterfilesStudentsCsvHeaderMap($header);
                    $requiredKeys = ['school_id', 'first_name', 'last_name', 'program', 'year_level'];
                    $missingRequired = array_filter($requiredKeys, static fn($k) => !isset($headerMap[$k]));
                    if (!empty($missingRequired)) {
                        fclose($handle);
                        $found = implode(', ', array_keys($headerMap));
                        http_response_code(400);
                        echo json_encode([
                            'success' => false,
                            'message' => 'Invalid CSV header. Required: School ID, First Name, Last Name, Program, Year Level. '
                                . 'Download the latest template. Columns found: ' . ($found ?: '(none — check delimiter or re-save as CSV UTF-8)')
                        ]);
                        exit;
                    }
                    // Stream rows from disk instead of holding the entire CSV in PHP memory.
                    // This keeps large imports within the configured memory limit.
                    $rows = (static function () use ($handle, $delimiter, $header, $headerMap): Generator {
                        $rowIndex = 0;
                        try {
                            while (($data = fgetcsv($handle, 0, $delimiter)) !== false) {
                                if (count($data) < count($header)) {
                                    $data = array_pad($data, count($header), '');
                                }
                                $row = [];
                                foreach ($headerMap as $key => $idx) {
                                    $row[$key] = masterfilesCleanCsvCell($data[$idx] ?? '');
                                }
                                if (!empty($row['school_id']) || !empty($row['first_name']) || !empty($row['last_name'])) {
                                    yield $rowIndex => $row;
                                    $rowIndex++;
                                }
                            }
                        } finally {
                            fclose($handle);
                        }
                    })();
                } else {
                    http_response_code(400);
                    echo json_encode([
                        'success' => false,
                        'message' => 'Excel import is not supported yet. Please save your file as CSV (.csv) and upload again.'
                    ]);
                    exit;
                }

                // Validate and import rows
                $imported = 0;
                $created = 0;
                $updated = 0;
                $skipped = 0;
                $ignoredContactNumbers = 0;
                $ignoredScholarships = 0;
                $scholarshipWarnings = [];
                $programMap = [];
                $yearLevelMap = [];
                $internalScholarshipMap = [];
                $externalScholarshipMap = [];
                $campusMap = [];
                $statusMap = [];
                $modalityMap = [];
                foreach ($pdo->query('SELECT modality_id, modality_code, modality_name FROM tbl_csdl_modalities WHERE modality_status = 1') as $availableModality) {
                    $modalityMap[strtolower((string)$availableModality['modality_code'])] = (int)$availableModality['modality_id'];
                    $modalityMap[strtolower((string)$availableModality['modality_name'])] = (int)$availableModality['modality_id'];
                }

                // Get program mapping
                $programStmt = $pdo->query("SELECT program_id, program_name, program_code FROM tbl_csdl_programs WHERE program_status = 1");
                $programs = $programStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($programs as $prog) {
                    $programMap[strtolower(trim($prog['program_name']))] = $prog['program_id'];
                    $programMap[strtolower(trim($prog['program_code']))] = $prog['program_id'];
                }

                // Get year level mapping
                $yearLevelStmt = $pdo->query("SELECT year_level_id, year_level_name, year_level_code FROM tbl_csdl_year_levels");
                $yearLevels = $yearLevelStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($yearLevels as $yl) {
                    $yearLevelMap[strtolower(trim($yl['year_level_name']))] = $yl['year_level_id'];
                    $yearLevelMap[strtolower(trim($yl['year_level_code']))] = $yl['year_level_id'];
                }

                // Get scholarship mapping
                $scholarshipStmt = $pdo->query("SELECT scholarship_id, scholarship_name, scholarship_code, scholarship_type FROM tbl_csdl_scholarships WHERE scholarship_status = 1");
                $scholarships = $scholarshipStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($scholarships as $sch) {
                    $map =& $internalScholarshipMap;
                    if (strcasecmp((string)$sch['scholarship_type'], 'External') === 0) {
                        $map =& $externalScholarshipMap;
                    }
                    $map[strtolower(trim($sch['scholarship_name']))] = (int)$sch['scholarship_id'];
                    $map[strtolower(trim($sch['scholarship_code']))] = (int)$sch['scholarship_id'];
                    unset($map);
                }

                // Get campus mapping
                $campusStmt = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses");
                $campuses = $campusStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($campuses as $campus) {
                    $campusMap[strtolower(trim($campus['campus_name']))] = $campus['campus_id'];
                }

                // Get student status mapping
                $statusStmt = $pdo->query("SELECT student_status_id, student_status_name FROM tbl_csdl_student_statuses");
                $statuses = $statusStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($statuses as $status) {
                    $statusMap[strtolower(trim($status['student_status_name']))] = $status['student_status_id'];
                }

                // Load existing students once. Performing this lookup for every CSV row
                // makes large institutional imports spend most of their time on queries.
                $balanceStudentIds = [];
                $balanceIdStmt = $pdo->query('SELECT DISTINCT balance_student_id FROM tbl_csdl_balances');
                while (($balanceStudentId = $balanceIdStmt->fetchColumn()) !== false) {
                    $balanceStudentIds[(int)$balanceStudentId] = true;
                }
                $existingStudents = [];
                $existingStudentsStmt = $pdo->query('SELECT student_id, student_school_id, student_scholarship_id FROM tbl_csdl_students');
                while ($existingStudentRow = $existingStudentsStmt->fetch(PDO::FETCH_ASSOC)) {
                    $existingStudentId = (int)$existingStudentRow['student_id'];
                    $existingSchoolId = trim((string)$existingStudentRow['student_school_id']);
                    if ($existingSchoolId === '') continue;
                    $existingStudents[$existingSchoolId] = [
                        'student_id' => $existingStudentId,
                        'has_balance' => isset($balanceStudentIds[$existingStudentId]) ? 1 : 0,
                        'internal_scholarship_id' => $existingStudentRow['student_scholarship_id'],
                    ];
                }
                unset($balanceStudentIds);

                if ($hasPersonalEmailColumn) {
                    $updateImportedStudentStmt = $pdo->prepare(
                        "UPDATE tbl_csdl_students SET
                            student_first_name = ?, student_middle_name = ?, student_last_name = ?,
                            student_date_of_birth = ?, student_gender = ?, student_contact_number = COALESCE(?, student_contact_number),
                            student_email = COALESCE(?, student_email), student_personal_email = COALESCE(?, student_personal_email), student_program_id = ?,
                            student_year_level_id = ?, student_scholarship_id = ?, student_campus_id = ?,
                            student_modality_id = ?, student_fb_account = ?, student_is_active = 1,
                            student_registration_status = ?, student_status_id = ?
                         WHERE student_id = ?"
                    );
                    $insertImportedStudentStmt = $pdo->prepare(
                        "INSERT INTO tbl_csdl_students
                            (student_school_id, student_first_name, student_middle_name, student_last_name,
                             student_date_of_birth, student_gender, student_contact_number, student_email,
                             student_personal_email, student_password_hash, student_program_id,
                             student_year_level_id, student_scholarship_id, student_campus_id,
                             student_modality_id, student_fb_account, student_is_active,
                             student_registration_status, student_status_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending_finance', ?)"
                    );
                } else {
                    $updateImportedStudentStmt = $pdo->prepare(
                        "UPDATE tbl_csdl_students SET
                            student_first_name = ?, student_middle_name = ?, student_last_name = ?,
                            student_date_of_birth = ?, student_gender = ?, student_contact_number = COALESCE(?, student_contact_number),
                            student_email = COALESCE(?, student_email), student_program_id = ?, student_year_level_id = ?,
                            student_scholarship_id = ?, student_campus_id = ?, student_modality_id = ?,
                            student_fb_account = ?, student_is_active = 1,
                            student_registration_status = ?, student_status_id = ?
                         WHERE student_id = ?"
                    );
                    $insertImportedStudentStmt = $pdo->prepare(
                        "INSERT INTO tbl_csdl_students
                            (student_school_id, student_first_name, student_middle_name, student_last_name,
                             student_date_of_birth, student_gender, student_contact_number, student_email,
                             student_password_hash, student_program_id, student_year_level_id,
                             student_scholarship_id, student_campus_id, student_modality_id,
                             student_fb_account, student_is_active, student_registration_status,
                             student_status_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending_finance', ?)"
                    );
                }

                $pdo->beginTransaction();

                foreach ($rows as $idx => $row) {
                    $schoolId = trim($row['school_id'] ?? '');
                    $firstName = trim($row['first_name'] ?? '');
                    $lastName = trim($row['last_name'] ?? '');
                    $middleName = trim($row['middle_name'] ?? '');
                    $program = trim($row['program'] ?? '');
                    $yearLevel = trim($row['year_level'] ?? '');
                    $schoolEmailRaw = masterfilesOptionalImportEmail($row['school_email'] ?? $row['email'] ?? '');
                    $personalEmail = masterfilesOptionalImportEmail($row['personal_email'] ?? '');
                    $campus = trim($row['campus'] ?? '');
                    $contactNumber = masterfilesOptionalImportMobile($row['contact_number'] ?? '');
                    $dateOfBirth = !empty($row['date_of_birth']) ? trim($row['date_of_birth']) : null;
                    $gender = !empty($row['gender']) ? trim($row['gender']) : 'Male';
                    $internalScholarship = trim($row['internal_scholarship'] ?? '');
                    $externalScholarships = trim($row['external_scholarships'] ?? '');
                    $modality = !empty($row['modality']) ? strtolower(trim($row['modality'])) : 'flex';
                    $studentStatus = trim($row['student_status'] ?? '');
                    $fbAccount = trim($row['facebook_account'] ?? '');

                    if (empty($schoolId) || empty($firstName) || empty($lastName) || empty($program) || empty($yearLevel)) {
                        $addImportError("Row " . ($idx + 2) . ": Missing required fields (School ID, First Name, Last Name, Program, or Year Level)");
                        $skipped++;
                        continue;
                    }

                    if (!InputValidation::validateSchoolId($schoolId)) {
                        $addImportError("Row " . ($idx + 2) . ": Invalid School ID format: " . $schoolId);
                        $skipped++;
                        continue;
                    }

                    try {
                        $familyMembers = masterfilesParseImportedFamily($row);
                    } catch (InvalidArgumentException $e) {
                        $addImportError('Row ' . ($idx + 2) . ': ' . $e->getMessage());
                        $skipped++;
                        continue;
                    }

                    $existingStudent = $existingStudents[$schoolId] ?? null;
                    $unmatchedScholarships = [];

                    $programId = $programMap[strtolower($program)] ?? null;
                    if (!$programId) {
                        $addImportError("Row " . ($idx + 2) . ": Invalid Program: " . $program);
                        $skipped++;
                        continue;
                    }

                    $yearLevelId = $yearLevelMap[strtolower($yearLevel)] ?? null;
                    if (!$yearLevelId) {
                        $addImportError("Row " . ($idx + 2) . ": Invalid Year Level: " . $yearLevel);
                        $skipped++;
                        continue;
                    }

                    $scholarshipId = $internalScholarship !== '' ? ($internalScholarshipMap[strtolower($internalScholarship)] ?? null) : null;
                    if ($internalScholarship !== '' && !$scholarshipId) {
                        $unmatchedScholarships[] = 'Internal: ' . $internalScholarship;
                        // An unknown optional value must not clear an existing award.
                        $scholarshipId = $existingStudent['internal_scholarship_id'] ?? null;
                    }
                    $externalScholarshipIds = [];
                    $unknownExternalScholarship = false;
                    if ($externalScholarships !== '') {
                        foreach (preg_split('/[;|]+/', $externalScholarships) as $externalName) {
                            $externalName = strtolower(trim($externalName));
                            if ($externalName === '') continue;
                            $externalId = $externalScholarshipMap[$externalName] ?? null;
                            if (!$externalId) {
                                $unmatchedScholarships[] = 'External: ' . trim($externalName);
                                $unknownExternalScholarship = true;
                                continue;
                            }
                            $externalScholarshipIds[] = (int)$externalId;
                        }
                    }
                    $campusId = !empty($campus) ? ($campusMap[strtolower($campus)] ?? null) : null;
                    $statusId = !empty($studentStatus) ? ($statusMap[strtolower($studentStatus)] ?? 1) : 1;

                    $modalityId = $modalityMap[$modality] ?? 0;
                    if ($modalityId <= 0) {
                        $addImportError('Row ' . ($idx + 2) . ': Invalid or inactive modality: ' . $modality);
                        $skipped++;
                        continue;
                    }

                    $email = null;
                    if ($schoolEmailRaw !== '') {
                        $normalizedSchool = InputValidation::normalizeSchoolEmailInput($schoolEmailRaw);
                        if ($normalizedSchool === false) {
                            $addImportError("Row " . ($idx + 2) . ": Invalid school email (must end with .coc, e.g. romeo.joi.coc): " . $schoolEmailRaw);
                            $skipped++;
                            continue;
                        }
                        $email = $normalizedSchool;
                    }

                    if ($personalEmail !== '') {
                        $validPersonal = InputValidation::validateEmail($personalEmail);
                        if (!$validPersonal) {
                            $addImportError("Row " . ($idx + 2) . ": Invalid personal email: " . $personalEmail);
                            $skipped++;
                            continue;
                        }
                        $personalEmail = $validPersonal;
                    } else {
                        $personalEmail = null;
                    }

                    $parsedContact = InputValidation::parsePhilippineMobile($contactNumber);
                    // Contact is optional in CSV imports. An unusable value must
                    // not discard the student or overwrite a saved contact.
                    $ignoredContactNumber = $parsedContact === false;
                    $contactNumber = $parsedContact === false ? null : $parsedContact;

                    if ($dateOfBirth !== null && $dateOfBirth !== '') {
                        $parsedDob = InputValidation::parseFlexibleDate($dateOfBirth);
                        if ($parsedDob === false) {
                            $addImportError("Row " . ($idx + 2) . ": Invalid date of birth (use YYYY-MM-DD or a normal date; Excel serial dates are accepted): " . $dateOfBirth);
                            $skipped++;
                            continue;
                        }
                        $dateOfBirth = $parsedDob;
                    } else {
                        $dateOfBirth = null;
                    }

                    if ($existingStudent) {
                        $registrationStatus = (int) ($existingStudent['has_balance'] ?? 0) === 1
                            ? 'approved'
                            : 'pending_finance';

                        $updateValues = [
                            $firstName,
                            $middleName ?: null,
                            $lastName,
                            $dateOfBirth ?: null,
                            $gender,
                            $contactNumber ?: null,
                            $email,
                        ];
                        if ($hasPersonalEmailColumn) {
                            $updateValues[] = $personalEmail;
                        }
                        array_push(
                            $updateValues,
                            $programId,
                            $yearLevelId,
                            $scholarshipId ?: null,
                            $campusId ?: null,
                            $modalityId,
                            $fbAccount ?: null,
                            $registrationStatus,
                            $statusId,
                            (int) $existingStudent['student_id']
                        );
                        $updateImportedStudentStmt->execute($updateValues);
                        $existingStudents[$schoolId]['internal_scholarship_id'] = $scholarshipId;
                        if (array_key_exists('external_scholarships', $row)
                            && ($externalScholarshipIds !== [] || !$unknownExternalScholarship)) {
                            masterfilesSyncExternalScholarships($pdo, (int)$existingStudent['student_id'], $externalScholarshipIds);
                        }
                        if ($familyMembers !== null) {
                            masterfilesSyncImportedFamily($pdo, (int)$existingStudent['student_id'], $familyMembers);
                        }
                        $updated++;
                    } else {
                        // New imported students can sign in, but must wait for Assessment
                        // to create their balance before registration is complete.
                        // Imported accounts start with their School ID and must change it
                        // after login. Cost 5 keeps bulk creation practical; auth-login.php
                        // upgrades the hash to the current default cost on first login.
                        $passwordHash = password_hash($schoolId, PASSWORD_BCRYPT, ['cost' => 5]);
                        if ($hasPersonalEmailColumn) {
                            $insertImportedStudentStmt->execute([
                                $schoolId, $firstName, $middleName ?: null, $lastName,
                                $dateOfBirth ?: null, $gender, $contactNumber ?: null, $email,
                                $personalEmail, $passwordHash, $programId, $yearLevelId,
                                $scholarshipId ?: null, $campusId ?: null, $modalityId,
                                $fbAccount ?: null, $statusId
                            ]);
                        } else {
                            $insertImportedStudentStmt->execute([
                                $schoolId, $firstName, $middleName ?: null, $lastName,
                                $dateOfBirth ?: null, $gender, $contactNumber ?: null, $email,
                                $passwordHash, $programId, $yearLevelId, $scholarshipId ?: null,
                                $campusId ?: null, $modalityId, $fbAccount ?: null, $statusId
                            ]);
                        }
                        $newStudentId = (int)$pdo->lastInsertId();
                        $existingStudents[$schoolId] = [
                            'student_id' => $newStudentId,
                            'has_balance' => 0,
                            'internal_scholarship_id' => $scholarshipId,
                        ];
                        masterfilesSyncExternalScholarships($pdo, $newStudentId, $externalScholarshipIds);
                        if ($familyMembers !== null) {
                            studentFamilySync($pdo, $newStudentId, $familyMembers);
                        }
                        $created++;
                    }
                    if ($ignoredContactNumber) $ignoredContactNumbers++;
                    $ignoredScholarships += count($unmatchedScholarships);
                    foreach ($unmatchedScholarships as $unmatchedScholarship) {
                        if (count($scholarshipWarnings) < 10) {
                            $scholarshipWarnings[] = 'Row ' . ($idx + 2) . ': ' . $unmatchedScholarship;
                        }
                    }
                    $imported++;
                }

                $pdo->commit();

                echo json_encode([
                    'success' => true,
                    'message' => "Import completed. {$created} students added, {$updated} updated, {$skipped} skipped. {$ignoredContactNumbers} unusable optional contact numbers and {$ignoredScholarships} unmatched optional scholarships ignored. No email notifications were sent.",
                    'imported' => $imported,
                    'created' => $created,
                    'updated' => $updated,
                    'skipped' => $skipped,
                    'ignored_contacts' => $ignoredContactNumbers,
                    'ignored_scholarships' => $ignoredScholarships,
                    'scholarship_warnings' => $scholarshipWarnings,
                    'errors' => $errors
                ]);

            } catch (Exception $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Import failed: ' . $e->getMessage()]);
            }
            break;

        default:
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Unsupported action']);
            break;
    }
} catch (PDOException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("API Error in masterfiles-students.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Database error occurred.']);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("API Error in masterfiles-students.php: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'An unexpected error occurred.']);
}
?>
