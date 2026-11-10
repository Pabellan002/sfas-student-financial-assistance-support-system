<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../includes/includes-student-registration.php';

header('Content-Type: application/json');

/**
 * Convert dates commonly produced by CSV editors to the database DATE format.
 */
function financeParseImportedDate(string $value): ?string
{
    $value = trim($value);
    if ($value === '') {
        return null;
    }

    // Excel may save a date cell as its numeric serial value in CSV files.
    if (preg_match('/^\d+(?:\.0+)?$/', $value)) {
        $serial = (int) $value;
        if ($serial >= 1 && $serial <= 2958465) {
            return (new DateTimeImmutable('1899-12-30'))
                ->modify('+' . $serial . ' days')
                ->format('Y-m-d');
        }
    }

    foreach (['!Y-m-d', '!Y/m/d', '!m/d/Y', '!n/j/Y', '!m-d-Y', '!n-j-Y'] as $format) {
        $date = DateTimeImmutable::createFromFormat($format, $value);
        $errors = DateTimeImmutable::getLastErrors();
        $isValid = $date !== false
            && ($errors === false || ($errors['warning_count'] === 0 && $errors['error_count'] === 0));
        if ($isValid) {
            return $date->format('Y-m-d');
        }
    }

    return null;
}

/**
 * Complete imported pending registrations in batches and create in-app notices.
 * Bulk balance imports intentionally avoid email fan-out because institutional
 * CSV files can contain tens of thousands of students and exhaust SMTP quotas.
 *
 * @param array<int,array<string,mixed>> $studentsById
 */
function financeCompleteImportedRegistrations(PDO $pdo, array $studentsById): int
{
    if ($studentsById === [] || !studentRegistrationColumnAvailable($pdo)) {
        return 0;
    }

    $studentIds = array_values(array_map('intval', array_keys($studentsById)));
    $activated = 0;
    foreach (array_chunk($studentIds, 500) as $idChunk) {
        $placeholders = implode(',', array_fill(0, count($idChunk), '?'));
        $stmt = $pdo->prepare(
            "UPDATE tbl_csdl_students
             SET student_registration_status = 'approved'
             WHERE student_registration_status = 'pending_finance'
               AND student_id IN ({$placeholders})"
        );
        $stmt->execute($idChunk);
        $activated += $stmt->rowCount();
    }

    if ($activated === 0) {
        return 0;
    }

    $notificationRows = [];
    foreach ($studentsById as $studentId => $student) {
        $studentId = (int) $studentId;
        $studentName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
        $notificationRows[] = [
            $studentId,
            'Balance setup completed',
            "Assessment has set up your balance, {$studentName}. You may now apply for a loan, subject to the normal eligibility requirements.",
        ];
    }

    foreach (array_chunk($notificationRows, 500) as $chunk) {
        $values = implode(',', array_fill(0, count($chunk), '(?, NULL, NULL, ?, ?, NOW())'));
        $params = [];
        foreach ($chunk as $row) {
            array_push($params, ...$row);
        }
        $pdo->prepare(
            "INSERT INTO tbl_csdl_notifications
             (notification_student_id, notification_loan_id, notification_workflow_step_id,
              notification_title, notification_message, notification_sent_at)
             VALUES {$values}"
        )->execute($params);
    }

    return $activated;
}

// Auth check
if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Assessment owns balance management (role_id = 101).
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 101) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Assessment role required.']);
    exit;
}

// Initialize RBAC
RBAC::init($pdo);
$employeeId = (int) ($_SESSION['user_id'] ?? 0);

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    RBAC::requirePermission($employeeId, 'assessment.balances.view', 'You do not have permission to view balances');
    $action = $_GET['action'] ?? '';

    if ($action === 'count') {
        try {
            $total = (int) $pdo->query('SELECT COUNT(*) FROM tbl_csdl_balances')->fetchColumn();
            $pendingBalanceRegistrations = studentRegistrationColumnAvailable($pdo)
                ? (int) $pdo->query("SELECT COUNT(*) FROM tbl_csdl_students WHERE student_registration_status = 'pending_finance'")->fetchColumn()
                : 0;
            echo json_encode([
                'success' => true,
                'total' => $total,
                'pendingBalanceRegistrations' => $pendingBalanceRegistrations,
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching balance count']);
        }
        exit;
    }

    if ($action === 'stats') {
        try {
            $stats = $pdo->query(
                "SELECT COUNT(DISTINCT b.balance_student_id) AS total_students,
                        COUNT(DISTINCT CONCAT_WS('|', COALESCE(b.balance_sy_id, 0), COALESCE(sy.sy_semester_id, 0), COALESCE(b.balance_period_id, 0))) AS periodic_summaries
                 FROM tbl_csdl_balances b
                 LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id"
            )->fetch(PDO::FETCH_ASSOC) ?: [];
            echo json_encode([
                'success' => true,
                'stats' => [
                    'totalStudents' => (int) ($stats['total_students'] ?? 0),
                    'periodicSummaries' => (int) ($stats['periodic_summaries'] ?? 0),
                ],
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching balance statistics']);
        }
        exit;
    }
    
    if ($action === 'filters') {
        try {
            // Get school years
            $syStmt = $pdo->query("SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1 ORDER BY sy_id DESC");
            $schoolYears = $syStmt->fetchAll(PDO::FETCH_ASSOC);
            $semesters = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id")->fetchAll(PDO::FETCH_ASSOC);
            
            $hasRegCol = studentRegistrationColumnAvailable($pdo);
            $pendingFinanceCount = 0;
            $pendingFinanceProgramCount = 0;
            $pendingFinanceYearLevelCount = 0;
            $pendingFinanceProgramSummary = [];
            $pendingFinanceYearLevelSummary = [];
            if ($hasRegCol) {
                $pendingStats = $pdo->query(
                    "SELECT COUNT(*) AS total,
                            COUNT(DISTINCT student_program_id) AS programs,
                            COUNT(DISTINCT student_year_level_id) AS year_levels
                     FROM tbl_csdl_students
                     WHERE student_registration_status = 'pending_finance'"
                )->fetch(PDO::FETCH_ASSOC) ?: [];
                $pendingFinanceCount = (int) ($pendingStats['total'] ?? 0);
                $pendingFinanceProgramCount = (int) ($pendingStats['programs'] ?? 0);
                $pendingFinanceYearLevelCount = (int) ($pendingStats['year_levels'] ?? 0);

                $pendingFinanceProgramSummary = $pdo->query(
                    "SELECT COALESCE(p.program_name, 'Unknown') AS label, COUNT(*) AS total
                     FROM tbl_csdl_students s
                     LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                     WHERE s.student_registration_status = 'pending_finance'
                     GROUP BY s.student_program_id, p.program_name
                     ORDER BY p.program_name"
                )->fetchAll(PDO::FETCH_ASSOC);
                $pendingFinanceYearLevelSummary = $pdo->query(
                    "SELECT COALESCE(yl.year_level_name, 'Unknown') AS label, COUNT(*) AS total
                     FROM tbl_csdl_students s
                     LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                     WHERE s.student_registration_status = 'pending_finance'
                     GROUP BY s.student_year_level_id, yl.year_level_name
                     ORDER BY yl.year_level_code"
                )->fetchAll(PDO::FETCH_ASSOC);
            }

            $programs = $pdo->query(
                "SELECT program_id, program_name FROM tbl_csdl_programs WHERE program_status = 1 ORDER BY program_name"
            )->fetchAll(PDO::FETCH_ASSOC);
            $yearLevels = $pdo->query(
                "SELECT year_level_id, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_code"
            )->fetchAll(PDO::FETCH_ASSOC);
            
            // Get application periods
            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name, app_period_status FROM tbl_csdl_application_periods ORDER BY app_period_id");
            $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC);
            $activePeriods = array_values(array_filter($periods, static function ($period) {
                return (int) $period['app_period_status'] === 1;
            }));
            
            echo json_encode([
                'success' => true,
                'schoolYears' => $schoolYears,
                'semesters' => $semesters,
                'students' => [],
                'periods' => $periods,
                'activePeriods' => $activePeriods,
                'programs' => $programs,
                'yearLevels' => $yearLevels,
                'pendingFinanceRegistrations' => $pendingFinanceCount,
                'pendingFinanceStats' => [
                    'totalStudents' => $pendingFinanceCount,
                    'uniquePrograms' => $pendingFinanceProgramCount,
                    'uniqueYearLevels' => $pendingFinanceYearLevelCount,
                ],
                'pendingFinanceProgramSummary' => $pendingFinanceProgramSummary,
                'pendingFinanceYearLevelSummary' => $pendingFinanceYearLevelSummary,
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching filters']);
        }
        exit;
    }

    if ($action === 'pending') {
        try {
            $hasRegCol = studentRegistrationColumnAvailable($pdo);
            $page = max(1, (int) ($_GET['page'] ?? 1));
            $perPage = min(100, max(10, (int) ($_GET['perPage'] ?? 25)));
            $fetchAll = ($_GET['all'] ?? '') === '1';
            if (!$hasRegCol) {
                echo json_encode([
                    'success' => true,
                    'students' => [],
                    'pagination' => ['page' => 1, 'perPage' => $perPage, 'total' => 0, 'totalPages' => 1],
                ]);
                exit;
            }

            $conditions = ["s.student_registration_status = 'pending_finance'"];
            $params = [];
            $programId = (int) ($_GET['programId'] ?? 0);
            $yearLevelId = (int) ($_GET['yearLevelId'] ?? 0);
            $search = mb_substr(trim((string) ($_GET['search'] ?? '')), 0, 100);
            if ($programId > 0) {
                $conditions[] = 's.student_program_id = ?';
                $params[] = $programId;
            }
            if ($yearLevelId > 0) {
                $conditions[] = 's.student_year_level_id = ?';
                $params[] = $yearLevelId;
            }
            if ($search !== '') {
                $like = '%' . $search . '%';
                $conditions[] = "(s.student_school_id LIKE ? OR CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) LIKE ? OR p.program_name LIKE ?)";
                array_push($params, $like, $like, $like);
            }

            $where = 'WHERE ' . implode(' AND ', $conditions);
            $joins = "LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                      LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id
                      LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                      LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                      LEFT JOIN (
                          SELECT ss.student_id,
                                 GROUP_CONCAT(es.scholarship_name ORDER BY es.scholarship_name SEPARATOR '; ') AS external_scholarship_names,
                                 GROUP_CONCAT(es.scholarship_code ORDER BY es.scholarship_code SEPARATOR '; ') AS external_scholarship_codes
                          FROM tbl_csdl_student_scholarships ss
                          JOIN tbl_csdl_scholarships es ON es.scholarship_id = ss.scholarship_id AND es.scholarship_type = 'External'
                          GROUP BY ss.student_id
                      ) ext ON ext.student_id = s.student_id";
            $countStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_students s {$joins} {$where}");
            $countStmt->execute($params);
            $total = (int) $countStmt->fetchColumn();
            $totalPages = max(1, (int) ceil($total / $perPage));
            $page = min($page, $totalPages);
            $offset = ($page - 1) * $perPage;
            $limit = $fetchAll ? '' : "LIMIT {$perPage} OFFSET {$offset}";

            $stmt = $pdo->prepare(
                "SELECT s.student_id, s.student_school_id,
                        s.student_program_id AS program_id,
                        s.student_year_level_id AS year_level_id,
                        CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                        p.program_name, d.department_name, yl.year_level_name,
                        sch.scholarship_id, sch.scholarship_code, sch.scholarship_name,
                        sch.scholarship_code AS internal_scholarship_code,
                        sch.scholarship_name AS internal_scholarship_name,
                        COALESCE(ext.external_scholarship_names, '') AS external_scholarship_names,
                        COALESCE(ext.external_scholarship_codes, '') AS external_scholarship_codes,
                        s.student_updated_at AS forwarded_at
                 FROM tbl_csdl_students s
                 {$joins}
                 {$where}
                 ORDER BY s.student_updated_at DESC, s.student_id DESC
                 {$limit}"
            );
            $stmt->execute($params);
            echo json_encode([
                'success' => true,
                'students' => $stmt->fetchAll(PDO::FETCH_ASSOC),
                'pagination' => [
                    'page' => $page,
                    'perPage' => $perPage,
                    'total' => $total,
                    'totalPages' => $totalPages,
                ],
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching pending balances']);
        }
        exit;
    }
    
    if ($action === 'details') {
        $balanceId = intval($_GET['balanceId'] ?? 0);
        if ($balanceId <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid balance ID']);
            exit;
        }
        
        try {
            $sql = "SELECT b.*,
                           s.student_id, s.student_school_id,
                           CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
                           sy.sy_id, sy.sy_code,
                           ap.app_period_id, ap.app_period_name,
                           sch.scholarship_id, sch.scholarship_code, sch.scholarship_name,
                           sch.scholarship_name AS internal_scholarship_name,
                           COALESCE(ext.external_scholarship_names, '') AS external_scholarship_names
                    FROM tbl_csdl_balances b
                    JOIN tbl_csdl_students s ON s.student_id = b.balance_student_id
                    LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                    LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = b.balance_period_id
                    LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                    LEFT JOIN (
                        SELECT ss.student_id,
                               GROUP_CONCAT(es.scholarship_name ORDER BY es.scholarship_name SEPARATOR '; ') AS external_scholarship_names
                        FROM tbl_csdl_student_scholarships ss
                        JOIN tbl_csdl_scholarships es ON es.scholarship_id = ss.scholarship_id AND es.scholarship_type = 'External'
                        GROUP BY ss.student_id
                    ) ext ON ext.student_id = s.student_id
                    WHERE b.balance_id = ?";
            
            $stmt = $pdo->prepare($sql);
            $stmt->execute([$balanceId]);
            $balance = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$balance) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Balance not found']);
                exit;
            }
            
            echo json_encode([
                'success' => true,
                'balance' => $balance
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching balance details']);
        }
        exit;
    }
    
    // List balances with pagination and filters
    try {
        $page = max(1, intval($_GET['page'] ?? 1));
        $perPage = min(100, max(10, intval($_GET['perPage'] ?? 25)));
        $schoolYearId = !empty($_GET['schoolYearId']) ? intval($_GET['schoolYearId']) : null;
        $semesterId = !empty($_GET['semesterId']) ? intval($_GET['semesterId']) : null;
        $periodId = !empty($_GET['periodId']) ? intval($_GET['periodId']) : null;
        $search = trim($_GET['search'] ?? '');
        
        // Build WHERE clause
        $whereConditions = [];
        $params = [];
        
        if ($schoolYearId) {
            $whereConditions[] = "b.balance_sy_id = ?";
            $params[] = $schoolYearId;
        }
        if ($semesterId) {
            $whereConditions[] = "sy.sy_semester_id = ?";
            $params[] = $semesterId;
        }
        if ($periodId) {
            $whereConditions[] = "b.balance_period_id = ?";
            $params[] = $periodId;
        }
        
        if ($search) {
            $whereConditions[] = "(s.student_school_id LIKE ? OR CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) LIKE ?)";
            $searchParam = '%' . $search . '%';
            $params[] = $searchParam;
            $params[] = $searchParam;
        }
        
        $whereClause = !empty($whereConditions) ? 'WHERE ' . implode(' AND ', $whereConditions) : '';
        
        // Count total
        $countSql = "SELECT COUNT(*) as total
                     FROM tbl_csdl_balances b
                     JOIN tbl_csdl_students s ON s.student_id = b.balance_student_id
                     LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                     $whereClause";
        $countStmt = $pdo->prepare($countSql);
        $countStmt->execute($params);
        $total = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['total'];
        $totalPages = max(1, (int) ceil($total / $perPage));
        $page = min($page, $totalPages);
        $offset = ($page - 1) * $perPage;
        
        // Get balances
        $sql = "SELECT b.*,
                       s.student_id, s.student_school_id,
                       CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
                       d.department_name,
                       sy.sy_id, sy.sy_code,
                       sem.semester_name,
                       ap.app_period_id, ap.app_period_name,
                       sch.scholarship_code AS internal_scholarship_code,
                       sch.scholarship_name AS internal_scholarship_name,
                       COALESCE(ext.external_scholarship_names, '') AS external_scholarship_names,
                       COALESCE(ext.external_scholarship_codes, '') AS external_scholarship_codes
                FROM tbl_csdl_balances b
                JOIN tbl_csdl_students s ON s.student_id = b.balance_student_id
                LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
                LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = b.balance_period_id
                LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id
                LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                LEFT JOIN (
                    SELECT ss.student_id,
                           GROUP_CONCAT(es.scholarship_name ORDER BY es.scholarship_name SEPARATOR '; ') AS external_scholarship_names,
                           GROUP_CONCAT(es.scholarship_code ORDER BY es.scholarship_code SEPARATOR '; ') AS external_scholarship_codes
                    FROM tbl_csdl_student_scholarships ss
                    JOIN tbl_csdl_scholarships es ON es.scholarship_id = ss.scholarship_id AND es.scholarship_type = 'External'
                    GROUP BY ss.student_id
                ) ext ON ext.student_id = s.student_id
                $whereClause
                ORDER BY b.balance_as_of_date DESC, s.student_school_id
                LIMIT ? OFFSET ?";
        
        $params[] = $perPage;
        $params[] = $offset;
        
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $balances = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        echo json_encode([
            'success' => true,
            'balances' => $balances,
            'pagination' => [
                'page' => $page,
                'perPage' => $perPage,
                'total' => $total,
                'totalPages' => $totalPages
            ]
        ]);
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Error fetching balances']);
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Handle JSON input
    $input = json_decode(file_get_contents('php://input'), true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    // Validate after JSON is mapped so csrf_token in request body is recognized.
    CSRFProtection::validateRequest();
    
    $action = $_POST['action'] ?? '';
    $employeeId = (int) $_SESSION['user_id'];
    
    if ($action === 'create' || $action === 'update') {
        // Check RBAC permission
        if ($action === 'create') {
            RBAC::requirePermission($employeeId, 'assessment.balances.create', 'You do not have permission to add balances');
        } else {
            RBAC::requirePermission($employeeId, 'assessment.balances.edit', 'You do not have permission to edit balances');
        }
        
        try {
            $balanceId = !empty($_POST['balanceId']) ? intval($_POST['balanceId']) : null;
            $studentId = intval($_POST['studentId'] ?? 0);
            $syId = intval($_POST['schoolYearId'] ?? 0);
            $periodId = intval($_POST['periodId'] ?? 0);
            $totalBalance = floatval($_POST['totalBalance'] ?? 0);
            $previousBalance = floatval($_POST['previousBalance'] ?? 0);
            $currentBalance = floatval($_POST['currentBalance'] ?? 0);
            $adviceToPay = floatval($_POST['adviceToPay'] ?? 0);
            // For updates, keep the existing date
            $existing = null;
            if ($action === 'create') {
                $asOfDate = date('Y-m-d'); // Today's date for new records
            } else {
                // For updates, get existing date from database
                if ($balanceId) {
                    $existingStmt = $pdo->prepare("SELECT balance_as_of_date, balance_period_id, balance_student_id, balance_sy_id FROM tbl_csdl_balances WHERE balance_id = ?");
                    $existingStmt->execute([$balanceId]);
                    $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
                    $asOfDate = $existing['balance_as_of_date'] ?? date('Y-m-d');
                } else {
                    $asOfDate = date('Y-m-d');
                }
            }
            
            // Validation
            if ($studentId <= 0 || $syId <= 0 || $periodId <= 0 || $totalBalance < 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Missing required fields']);
                exit;
            }
            
            // Check if student exists (active students or pending Finance validation)
            $studentStmt = $pdo->prepare(
                "SELECT s.student_id, s.student_registration_status
                 FROM tbl_csdl_students s
                 WHERE s.student_id = ?
                   AND (s.student_is_active = 1 OR s.student_registration_status = 'pending_finance')
                 LIMIT 1"
            );
            $studentStmt->execute([$studentId]);
            $studentRow = $studentStmt->fetch(PDO::FETCH_ASSOC);
            if (!$studentRow) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid student']);
                exit;
            }

            // Check if school year exists
            $syStmt = $pdo->prepare("SELECT sy_id FROM tbl_csdl_school_years WHERE sy_id = ? AND sy_status = 1");
            $syStmt->execute([$syId]);
            if (!$syStmt->fetch()) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid school year']);
                exit;
            }
            
            // New balances must use an active period. Existing records may retain a period
            // that was deactivated after the balance was created.
            $periodStmt = $pdo->prepare("SELECT app_period_id, app_period_status FROM tbl_csdl_application_periods WHERE app_period_id = ?");
            $periodStmt->execute([$periodId]);
            $period = $periodStmt->fetch(PDO::FETCH_ASSOC);
            if (!$period) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid period']);
                exit;
            }
            if ((int) $period['app_period_status'] !== 1
                && !($action === 'update' && $existing
                    && (int) $existing['balance_period_id'] === $periodId
                    && (int) $existing['balance_student_id'] === $studentId
                    && (int) $existing['balance_sy_id'] === $syId)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select an active period']);
                exit;
            }
            
            if ($action === 'create') {
                // Check for duplicate (student + school year + period)
                $duplicateStmt = $pdo->prepare("SELECT balance_id FROM tbl_csdl_balances 
                                               WHERE balance_student_id = ? AND balance_sy_id = ? AND balance_period_id = ?");
                $duplicateStmt->execute([$studentId, $syId, $periodId]);
                if ($duplicateStmt->fetch()) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Balance record already exists for this student, school year, and period']);
                    exit;
                }
                
                $insertSql = "INSERT INTO tbl_csdl_balances 
                             (balance_student_id, balance_sy_id, balance_period_id, balance_total_balance, balance_previous_balance,
                              balance_current_balance, balance_advice_to_pay, balance_as_of_date)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
                $insertStmt = $pdo->prepare($insertSql);
                $insertStmt->execute([
                    $studentId, $syId, $periodId, $totalBalance, $previousBalance,
                    $currentBalance, $adviceToPay, $asOfDate
                ]);

                $activationResult = studentRegistrationCompleteAfterFinance($pdo, $studentId);
                $responseMessage = 'Balance created successfully';
                if (!empty($activationResult['completed'])) {
                    $responseMessage = 'Balance created successfully. ' . ($activationResult['message'] ?? 'Student balance setup completed.');
                }

                echo json_encode([
                    'success' => true,
                    'message' => $responseMessage,
                    'registration_activated' => !empty($activationResult['completed']),
                ]);
            } else {
                // Update
                if (!$balanceId || $balanceId <= 0) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid balance ID']);
                    exit;
                }
                
                // Check if balance exists
                $checkStmt = $pdo->prepare("SELECT balance_id FROM tbl_csdl_balances WHERE balance_id = ?");
                $checkStmt->execute([$balanceId]);
                if (!$checkStmt->fetch()) {
                    http_response_code(404);
                    echo json_encode(['success' => false, 'message' => 'Balance not found']);
                    exit;
                }
                
                $updateSql = "UPDATE tbl_csdl_balances SET
                              balance_student_id = ?, balance_sy_id = ?, balance_period_id = ?, balance_total_balance = ?,
                              balance_previous_balance = ?, balance_current_balance = ?,
                              balance_advice_to_pay = ?, balance_as_of_date = ?
                              WHERE balance_id = ?";
                $updateStmt = $pdo->prepare($updateSql);
                $updateStmt->execute([
                    $studentId, $syId, $periodId, $totalBalance, $previousBalance,
                    $currentBalance, $adviceToPay, $asOfDate,
                    $balanceId
                ]);
                
                echo json_encode(['success' => true, 'message' => 'Balance updated successfully']);
            }
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Finance save balance error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error saving balance']);
        }
        exit;
    }
    
    if ($action === 'delete') {
        // Check RBAC permission
        RBAC::requirePermission($employeeId, 'assessment.balances.delete', 'You do not have permission to delete balances');
        
        $balanceId = intval($_POST['balanceId'] ?? 0);
        if ($balanceId <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid balance ID']);
            exit;
        }
        
        try {
            // Check if balance exists
            $checkStmt = $pdo->prepare("SELECT balance_id FROM tbl_csdl_balances WHERE balance_id = ?");
            $checkStmt->execute([$balanceId]);
            if (!$checkStmt->fetch()) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Balance not found']);
                exit;
            }
            
            // Check if balance is being used by any loan
            $loanStmt = $pdo->prepare("SELECT loan_id FROM tbl_csdl_loans WHERE loan_balance_id = ? LIMIT 1");
            $loanStmt->execute([$balanceId]);
            if ($loanStmt->fetch()) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Cannot delete balance. It is being used by a loan application.']);
                exit;
            }
            
            $deleteStmt = $pdo->prepare("DELETE FROM tbl_csdl_balances WHERE balance_id = ?");
            $deleteStmt->execute([$balanceId]);
            
            echo json_encode(['success' => true, 'message' => 'Balance deleted successfully']);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error deleting balance']);
        }
        exit;
    }

    if ($action === 'bulk_delete_balances') {
        RBAC::requirePermission($employeeId, 'assessment.balances.delete', 'You do not have permission to delete balances');

        $rawIds = $_POST['balance_ids'] ?? [];
        $ids = is_array($rawIds)
            ? array_values(array_unique(array_filter(array_map('intval', $rawIds), static fn(int $id): bool => $id > 0)))
            : [];
        if ($ids === []) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Select at least one balance record to delete.']);
            exit;
        }
        if (count($ids) > 100) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'You can delete up to 100 balance records at a time.']);
            exit;
        }

        try {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $pdo->prepare(
                "SELECT b.balance_id, s.student_school_id,
                        CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                        EXISTS(SELECT 1 FROM tbl_csdl_loans l WHERE l.loan_balance_id = b.balance_id) AS has_loan
                 FROM tbl_csdl_balances b
                 JOIN tbl_csdl_students s ON s.student_id = b.balance_student_id
                 WHERE b.balance_id IN ({$placeholders})"
            );
            $stmt->execute($ids);
            $rowsById = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rowsById[(int) $row['balance_id']] = $row;
            }

            $deleteIds = [];
            $failed = [];
            foreach ($ids as $id) {
                $row = $rowsById[$id] ?? null;
                if (!$row) {
                    $failed[] = ['balance_id' => $id, 'label' => "Balance {$id}", 'reason' => 'Balance record was not found.'];
                } elseif ((int) $row['has_loan'] === 1) {
                    $failed[] = [
                        'balance_id' => $id,
                        'label' => $row['student_school_id'] ?: ($row['student_name'] ?: "Balance {$id}"),
                        'reason' => 'This balance is linked to a loan application.'
                    ];
                } else {
                    $deleteIds[] = $id;
                }
            }

            if ($deleteIds !== []) {
                $deletePlaceholders = implode(',', array_fill(0, count($deleteIds), '?'));
                $pdo->beginTransaction();
                $deleteStmt = $pdo->prepare("DELETE FROM tbl_csdl_balances WHERE balance_id IN ({$deletePlaceholders})");
                $deleteStmt->execute($deleteIds);
                $deletedCount = $deleteStmt->rowCount();
                $pdo->commit();
            } else {
                $deletedCount = 0;
            }

            echo json_encode([
                'success' => true,
                'message' => "{$deletedCount} balance record" . ($deletedCount === 1 ? '' : 's') . ' deleted.',
                'deleted_count' => $deletedCount,
                'failed_count' => count($failed),
                'failed' => $failed,
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Finance bulk balance delete error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to delete the selected balance records.']);
        }
        exit;
    }

    if ($action === 'bulk_delete_pending') {
        RBAC::requirePermission($employeeId, 'assessment.balances.delete', 'You do not have permission to delete pending balance registrations');

        $rawIds = $_POST['student_ids'] ?? [];
        $ids = is_array($rawIds)
            ? array_values(array_unique(array_filter(array_map('intval', $rawIds), static fn(int $id): bool => $id > 0)))
            : [];
        if ($ids === []) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Select at least one pending balance registration to delete.']);
            exit;
        }
        if (count($ids) > 100) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'You can delete up to 100 pending balance registrations at a time.']);
            exit;
        }

        try {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $pdo->prepare(
                "SELECT s.student_id, s.student_school_id, s.student_registration_status,
                        CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                        EXISTS(SELECT 1 FROM tbl_csdl_balances b WHERE b.balance_student_id = s.student_id) AS has_balance,
                        EXISTS(SELECT 1 FROM tbl_csdl_loans l WHERE l.loan_student_id = s.student_id) AS has_loan
                 FROM tbl_csdl_students s
                 WHERE s.student_id IN ({$placeholders})"
            );
            $stmt->execute($ids);
            $rowsById = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rowsById[(int) $row['student_id']] = $row;
            }

            $deleteIds = [];
            $failed = [];
            foreach ($ids as $id) {
                $row = $rowsById[$id] ?? null;
                $label = $row['student_school_id'] ?? ($row['student_name'] ?? "Student {$id}");
                if (!$row) {
                    $failed[] = ['student_id' => $id, 'label' => "Student {$id}", 'reason' => 'Student record was not found.'];
                } elseif (($row['student_registration_status'] ?? '') !== 'pending_finance') {
                    $failed[] = ['student_id' => $id, 'label' => $label, 'reason' => 'This registration is no longer pending balance setup.'];
                } elseif ((int) $row['has_balance'] === 1 || (int) $row['has_loan'] === 1) {
                    $failed[] = ['student_id' => $id, 'label' => $label, 'reason' => 'This student is already linked to a balance or loan record.'];
                } else {
                    $deleteIds[] = $id;
                }
            }

            if ($deleteIds !== []) {
                $deletePlaceholders = implode(',', array_fill(0, count($deleteIds), '?'));
                $pdo->beginTransaction();
                $deleteStmt = $pdo->prepare(
                    "DELETE FROM tbl_csdl_students
                     WHERE student_registration_status = 'pending_finance'
                       AND student_id IN ({$deletePlaceholders})"
                );
                $deleteStmt->execute($deleteIds);
                $deletedCount = $deleteStmt->rowCount();
                $pdo->commit();
            } else {
                $deletedCount = 0;
            }

            echo json_encode([
                'success' => true,
                'message' => "{$deletedCount} pending registration" . ($deletedCount === 1 ? '' : 's') . ' deleted.',
                'deleted_count' => $deletedCount,
                'failed_count' => count($failed),
                'failed' => $failed,
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Finance bulk pending registration delete error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to delete the selected pending registrations.']);
        }
        exit;
    }
    
    if ($action === 'import') {
        $importStartedAt = microtime(true);
        // Check RBAC permission
        RBAC::requirePermission($employeeId, 'assessment.balances.create', 'You do not have permission to import balances');
        
        if (!isset($_FILES['file'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'File upload required.']);
            exit;
        }

        $file = $_FILES['file'];
        $allowedExtensions = ['csv'];
        
        $fileExt = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($fileExt, $allowedExtensions)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid file type. Only CSV files are allowed.']);
            exit;
        }

        $maxImportBytes = 250 * 1024 * 1024;
        if ($file['size'] > $maxImportBytes) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'File size exceeds 250 MB limit.']);
            exit;
        }

        $allowedMimeTypes = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];
        [$uploadValid, $uploadMessage] = UploadSecurity::validateUploadedFile(
            $file,
            $allowedExtensions,
            $allowedMimeTypes,
            $maxImportBytes
        );
        if (!$uploadValid) {
            http_response_code(400);
            if ($uploadMessage === 'Invalid file extension.' || $uploadMessage === 'Invalid file content type.') {
                $uploadMessage = 'Invalid file content. Only CSV files are allowed.';
            }
            echo json_encode(['success' => false, 'message' => $uploadMessage]);
            exit;
        }

        $handle = null;
        $headerMap = [];
        $errors = [];
        $errorCount = 0;
        $errorReasons = [];
        $recordError = static function (string $message, string $reason) use (&$errors, &$errorCount, &$errorReasons): void {
            $errorCount++;
            $errorReasons[$reason] = ($errorReasons[$reason] ?? 0) + 1;
            if (count($errors) < 200) {
                $errors[] = $message;
            }
        };

        try {
            if ($fileExt === 'csv') {
                $handle = fopen($file['tmp_name'], 'r');
                if ($handle === false) {
                    throw new Exception('Failed to open CSV file.');
                }
                $header = fgetcsv($handle);
                if ($header === false) {
                    fclose($handle);
                    throw new Exception('Invalid CSV file format.');
                }
                $normalizeHeader = static function ($value) {
                    $value = preg_replace('/^\xEF\xBB\xBF/', '', (string) $value);
                    $value = strtolower(trim($value));
                    return trim((string) preg_replace('/[^a-z0-9]+/', '_', $value), '_');
                };
                $headerLabels = [
                    'student_id' => 'Student ID',
                    'student_name' => 'Student Name',
                    'school_year' => 'School Year',
                    'period' => 'Period',
                    'total_balance' => 'Total Balance',
                    'previous_balance' => 'Previous Balance',
                    'current_balance' => 'Current Balance',
                    'advice_to_pay' => 'Advice to Pay',
                    'as_of_date' => 'As of Date',
                    'internal_scholarship' => 'Internal Scholarship',
                    'external_scholarships' => 'External Scholarships'
                ];
                $normalizedHeader = array_map($normalizeHeader, $header);
                foreach ($headerLabels as $key => $label) {
                    $idx = array_search($key, $normalizedHeader, true);
                    if ($idx !== false) {
                        $headerMap[$key] = $idx;
                    }
                }

                $requiredHeaders = [
                    'student_id', 'school_year', 'period', 'total_balance',
                    'previous_balance', 'current_balance', 'advice_to_pay'
                ];
                $missingHeaders = array_values(array_diff($requiredHeaders, array_keys($headerMap)));
                if (!empty($missingHeaders)) {
                    fclose($handle);
                    $missingLabels = array_map(static function ($key) use ($headerLabels) {
                        return $headerLabels[$key];
                    }, $missingHeaders);
                    http_response_code(400);
                    echo json_encode([
                        'success' => false,
                        'message' => 'Missing required CSV column(s): ' . implode(', ', $missingLabels) . '.'
                    ]);
                    exit;
                }
            } else {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Only CSV format is supported.']);
                exit;
            }

            // Get mappings
            $studentMap = [];
            $syMap = [];
            $periodMap = [];

            // Get student mapping (active students and pending Finance validation)
            $studentStmt = $pdo->query(
                "SELECT student_id, student_school_id, student_first_name, student_last_name,
                        student_email, student_personal_email, student_registration_status
                 FROM tbl_csdl_students
                 WHERE student_is_active = 1 OR student_registration_status = 'pending_finance'"
            );
            $students = $studentStmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($students as $student) {
                $studentMap[strtolower(trim($student['student_school_id']))] = $student;
            }

            // Get school year mapping
            $syStmt = $pdo->query("SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1");
            $schoolYears = $syStmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($schoolYears as $sy) {
                $syMap[strtolower(trim($sy['sy_code']))] = $sy['sy_id'];
            }

            // Get period mapping
            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods");
            $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($periods as $period) {
                $periodMap[strtolower(trim($period['app_period_name']))] = $period['app_period_id'];
            }

            // Build one in-memory duplicate map instead of querying once per CSV row.
            $existingBalanceKeys = [];
            $existingStmt = $pdo->query(
                'SELECT balance_student_id, balance_sy_id, balance_period_id FROM tbl_csdl_balances'
            );
            while ($existing = $existingStmt->fetch(PDO::FETCH_ASSOC)) {
                $key = (int) $existing['balance_student_id'] . '|' . (int) $existing['balance_sy_id'] . '|' . (int) $existing['balance_period_id'];
                $existingBalanceKeys[$key] = true;
            }

            $imported = 0;
            $skipped = 0;
            $pendingStudentsToComplete = [];
            $parseAmount = static function ($value): ?float {
                $normalized = str_replace([',', '₱', ' '], '', (string) $value);
                return $normalized === '' || !is_numeric($normalized) ? null : (float) $normalized;
            };

            $pdo->beginTransaction();

            $balanceInsertBuffer = [];
            $flushBalanceInsertBuffer = static function () use ($pdo, &$balanceInsertBuffer): void {
                if ($balanceInsertBuffer === []) {
                    return;
                }
                $values = implode(',', array_fill(0, count($balanceInsertBuffer), '(?, ?, ?, ?, ?, ?, ?, ?)'));
                $params = [];
                foreach ($balanceInsertBuffer as $valuesRow) {
                    array_push($params, ...$valuesRow);
                }
                $pdo->prepare(
                    "INSERT INTO tbl_csdl_balances
                     (balance_student_id, balance_sy_id, balance_period_id, balance_total_balance, balance_previous_balance,
                      balance_current_balance, balance_advice_to_pay, balance_as_of_date)
                     VALUES {$values}"
                )->execute($params);
                $balanceInsertBuffer = [];
            };
            $rowNumber = 1;

            while (($data = fgetcsv($handle)) !== false) {
                $rowNumber++;
                $row = [];
                foreach ($headerMap as $key => $columnIndex) {
                    $row[$key] = isset($data[$columnIndex]) ? trim($data[$columnIndex]) : '';
                }
                if (count(array_filter($data, static function ($value): bool {
                    return trim((string) $value) !== '';
                })) === 0) {
                    continue;
                }
                $studentSchoolId = trim($row['student_id'] ?? '');
                $schoolYear = trim($row['school_year'] ?? '');
                $periodName = trim($row['period'] ?? '');
                if (empty($studentSchoolId) || empty($schoolYear) || empty($periodName)) {
                    $recordError("Row {$rowNumber}: Missing required fields (Student ID, School Year, or Period)", 'Missing student, school year, or period');
                    $skipped++;
                    continue;
                }

                $student = $studentMap[strtolower($studentSchoolId)] ?? null;
                if (!$student) {
                    $recordError("Row {$rowNumber}: Student ID not found among active or pending-finance students: " . $studentSchoolId, 'Student ID not found or inactive');
                    $skipped++;
                    continue;
                }
                $studentId = (int) $student['student_id'];

                $syId = $syMap[strtolower($schoolYear)] ?? null;
                if (!$syId) {
                    $recordError("Row {$rowNumber}: School Year not found or inactive: " . $schoolYear, 'School Year not found or inactive');
                    $skipped++;
                    continue;
                }

                $periodId = $periodMap[strtolower($periodName)] ?? null;
                if (!$periodId) {
                    $recordError("Row {$rowNumber}: Period not found: " . $periodName, 'Period not found');
                    $skipped++;
                    continue;
                }

                // Check the preloaded map and rows already accepted from this CSV.
                $balanceKey = $studentId . '|' . $syId . '|' . $periodId;
                if (isset($existingBalanceKeys[$balanceKey])) {
                    $recordError("Row {$rowNumber}: Balance already exists for this student, school year, and period", 'Duplicate student, school year, and period');
                    $skipped++;
                    continue;
                }

                $amounts = [
                    'Total Balance' => $row['total_balance'] ?? '',
                    'Previous Balance' => $row['previous_balance'] ?? '',
                    'Current Balance' => $row['current_balance'] ?? '',
                    'Advice to Pay' => $row['advice_to_pay'] ?? ''
                ];
                $parsedAmounts = [];
                foreach ($amounts as $label => $value) {
                    $parsedAmounts[$label] = $parseAmount($value);
                    if ($parsedAmounts[$label] === null) {
                        $recordError("Row {$rowNumber}: {$label} must be a number (received " . ($value === '' ? 'blank' : $value) . ').', "Invalid {$label}");
                        $skipped++;
                        continue 2;
                    }
                }
                $totalBalance = $parsedAmounts['Total Balance'];
                $previousBalance = $parsedAmounts['Previous Balance'];
                $currentBalance = $parsedAmounts['Current Balance'];
                $adviceToPay = $parsedAmounts['Advice to Pay'];

                // Insert balance
                $asOfDate = trim($row['as_of_date'] ?? '');
                if ($asOfDate === '') {
                    $asOfDate = date('Y-m-d');
                } else {
                    $parsedDate = financeParseImportedDate($asOfDate);
                    if ($parsedDate === null) {
                        $recordError("Row {$rowNumber}: Invalid As of Date: {$asOfDate}. Use YYYY-MM-DD or MM/DD/YYYY.", 'Invalid As of Date');
                        $skipped++;
                        continue;
                    }
                    $asOfDate = $parsedDate;
                }
                $balanceInsertBuffer[] = [
                    $studentId, $syId, $periodId, $totalBalance, $previousBalance,
                    $currentBalance, $adviceToPay, $asOfDate
                ];
                $existingBalanceKeys[$balanceKey] = true;
                if (($student['student_registration_status'] ?? '') === 'pending_finance') {
                    $pendingStudentsToComplete[$studentId] = $student;
                }
                $imported++;
                if (count($balanceInsertBuffer) >= 500) {
                    $flushBalanceInsertBuffer();
                }
            }

            $flushBalanceInsertBuffer();
            $activated = financeCompleteImportedRegistrations($pdo, $pendingStudentsToComplete);

            fclose($handle);
            $handle = null;

            $pdo->commit();

            if ($activated > 0) {
                $employeeIds = studentRegistrationGetEmployeeIdsByPermission($pdo, 'csdl.masterfiles.students.view');
                if ($employeeIds === []) {
                    $fallbackStmt = $pdo->query(
                        'SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = 100 AND employee_status = 1'
                    );
                    $employeeIds = array_map('intval', $fallbackStmt->fetchAll(PDO::FETCH_COLUMN));
                }
                studentRegistrationSendEmployeeNotifications(
                    $pdo,
                    $employeeIds,
                    'Student balance import completed',
                    "Assessment completed balance setup for {$activated} student registration(s) through CSV import."
                );
            }

            $elapsedSeconds = round(microtime(true) - $importStartedAt, 2);

            echo json_encode([
                'success' => true,
                'message' => "Import completed. {$imported} balances imported, {$skipped} skipped.",
                'imported' => $imported,
                'skipped' => $skipped,
                'registrationsActivated' => $activated,
                'elapsedSeconds' => $elapsedSeconds,
                'errors' => $errors,
                'errorReasons' => $errorReasons,
                'errorCount' => $errorCount,
                'errorsOmitted' => max(0, $errorCount - count($errors))
            ]);

        } catch (Throwable $e) {
            if (is_resource($handle)) {
                fclose($handle);
            }
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            http_response_code(500);
            error_log('Finance balance import error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Import failed. Please try again later.']);
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
