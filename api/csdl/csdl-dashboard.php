<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

/**
 * @return array<string, string>
 */
function csdlDashboardParseFilters(array $get): array
{
    return [
        'schoolYear' => trim((string) ($get['schoolYear'] ?? '')),
        'campus' => trim((string) ($get['campus'] ?? '')),
        'semester' => trim((string) ($get['semester'] ?? '')),
        'period' => trim((string) ($get['period'] ?? '')),
        'department' => trim((string) ($get['department'] ?? '')),
        'program' => trim((string) ($get['program'] ?? '')),
        'yearLevel' => trim((string) ($get['yearLevel'] ?? '')),
        'modality' => trim((string) ($get['modality'] ?? '')),
        'status' => in_array((string) ($get['status'] ?? ''), ['1', '2', '6'], true) ? (string) $get['status'] : '',
        'scholarship' => trim((string) ($get['scholarship'] ?? '')),
    ];
}

/**
 * Student profile filters only (campus, department, program, year level).
 *
 * @param array<string, string> $filters
 * @return array<string, string>
 */
function csdlDashboardStudentProfileFilters(array $filters): array
{
    return [
        'campus' => $filters['campus'] ?? '',
        'department' => $filters['department'] ?? '',
        'program' => $filters['program'] ?? '',
        'yearLevel' => $filters['yearLevel'] ?? '',
        'modality' => $filters['modality'] ?? '',
        'scholarship' => $filters['scholarship'] ?? '',
    ];
}

/**
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function csdlDashboardStudentWhere(array $filters, array &$params, string $alias = 's'): string
{
    $profile = csdlDashboardStudentProfileFilters($filters);
    $parts = [];
    if ($profile['campus'] !== '') {
        $parts[] = "{$alias}.student_campus_id = :campus";
        $params[':campus'] = $profile['campus'];
    }
    if ($profile['department'] !== '') {
        $parts[] = "EXISTS (
            SELECT 1 FROM tbl_csdl_programs p_f
            WHERE p_f.program_id = {$alias}.student_program_id
            AND p_f.program_department_id = :department
        )";
        $params[':department'] = $profile['department'];
    }
    if ($profile['program'] !== '') {
        $parts[] = "{$alias}.student_program_id = :program";
        $params[':program'] = $profile['program'];
    }
    if ($profile['yearLevel'] !== '') {
        $parts[] = "{$alias}.student_year_level_id = :yearLevel";
        $params[':yearLevel'] = $profile['yearLevel'];
    }
    if ($profile['modality'] !== '') {
        $parts[] = "{$alias}.student_modality_id = (SELECT modality_id FROM tbl_csdl_modalities WHERE modality_code = :modality)";
        $params[':modality'] = $profile['modality'];
    }
    if ($profile['scholarship'] !== '') {
        $parts[] = "({$alias}.student_scholarship_id = :scholarship
            OR EXISTS (
                SELECT 1 FROM tbl_csdl_student_scholarships ss_f
                WHERE ss_f.student_id = {$alias}.student_id
                  AND ss_f.scholarship_id = :externalScholarship
            ))";
        $params[':scholarship'] = $profile['scholarship'];
        $params[':externalScholarship'] = $profile['scholarship'];
    }
    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

/**
 * Loan application filters: school year, semester, period (via loan/balance).
 *
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function csdlDashboardLoanApplicationWhere(array $filters, array &$params, string $loanAlias = 'l'): string
{
    $parts = [];
    if ($filters['period'] !== '') {
        $parts[] = "{$loanAlias}.loan_app_period_id = :period";
        $params[':period'] = $filters['period'];
    }
    if ($filters['semester'] !== '') {
        $parts[] = "EXISTS (
            SELECT 1 FROM tbl_csdl_balances b_f
            INNER JOIN tbl_csdl_school_years sy_f ON sy_f.sy_id = b_f.balance_sy_id
            WHERE b_f.balance_id = {$loanAlias}.loan_balance_id
            AND sy_f.sy_semester_id = :loanSemester
        )";
        $params[':loanSemester'] = $filters['semester'];
    }
    if ($filters['schoolYear'] !== '') {
        $parts[] = "EXISTS (
            SELECT 1 FROM tbl_csdl_balances b_f
            WHERE b_f.balance_id = {$loanAlias}.loan_balance_id
            AND b_f.balance_sy_id = :loanSchoolYear
        )";
        $params[':loanSchoolYear'] = $filters['schoolYear'];
    }
    if ($filters['status'] !== '') {
        $parts[] = "{$loanAlias}.loan_status_id = :status";
        $params[':status'] = $filters['status'];
    }
    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

function csdlDashboardVisibleLoanWhere(array $filters, string $alias = 'l'): string
{
    return ($filters['status'] ?? '') === '6' ? '' : " AND {$alias}.loan_status_id NOT IN (6, 9)";
}

/**
 * Loan queries: school year, semester, period, and campus.
 *
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function csdlDashboardLoanWhere(array $filters, array &$params, string $loanAlias = 'l', string $studentAlias = 's'): string
{
    $where = csdlDashboardLoanApplicationWhere($filters, $params, $loanAlias);
    $campusOnly = ['campus' => $filters['campus'] ?? ''];
    return $where . csdlDashboardStudentWhere($campusOnly, $params, $studentAlias);
}

/**
 * Chart/export: loan application filters plus student profile filters.
 *
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function csdlDashboardChartWhere(array $filters, array &$params, string $loanAlias = 'l', string $studentAlias = 's'): string
{
    $parts = [];
    $loanPart = ltrim(csdlDashboardLoanApplicationWhere($filters, $params, $loanAlias), ' AND ');
    if ($loanPart !== '') {
        $parts[] = $loanPart;
    }
    $studentPart = ltrim(csdlDashboardStudentWhere($filters, $params, $studentAlias), ' AND ');
    if ($studentPart !== '') {
        $parts[] = $studentPart;
    }
    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

/**
 * @param array<string, string> $filters
 */
function csdlDashboardHasLoanApplicationFilters(array $filters): bool
{
    return ($filters['schoolYear'] ?? '') !== ''
        || ($filters['semester'] ?? '') !== ''
        || ($filters['period'] ?? '') !== '';
}

/**
 * Chart dimension: drill down based on active filters.
 * Priority: School Year > Semester > Campus > Modality > Year Level > Program > Department (default)
 *
 * @param array<string, string> $filters
 */
function csdlDashboardResolveChartGroupBy(array $filters): string
{
    // Loan application filters take priority
    if (($filters['schoolYear'] ?? '') !== '') {
        return 'schoolYear';
    }
    if (($filters['semester'] ?? '') !== '') {
        return 'semester';
    }
    
    // Student profile filters
    $profile = csdlDashboardStudentProfileFilters($filters);
    if ($profile['campus'] !== '') {
        return 'campus';
    }
    if ($profile['modality'] !== '') {
        return 'modality';
    }
    if ($profile['yearLevel'] !== '') {
        return 'yearLevel';
    }
    if ($profile['program'] !== '') {
        return 'program';
    }
    if ($profile['department'] !== '') {
        return 'program';
    }

    return 'department';
}

function csdlDashboardChartGroupLabel(string $groupBy): string
{
    return match ($groupBy) {
        'schoolYear' => 'School Year',
        'semester' => 'Semester',
        'campus' => 'Campus',
        'modality' => 'Modality',
        'program' => 'Program',
        'yearLevel' => 'Year Level',
        default => 'Department',
    };
}

/**
 * @return array{labelExpr: string, groupBy: string, joins: string}
 */
function csdlDashboardChartGroupDefinition(string $groupBy): array
{
    $baseJoins = '
        LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
        LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id';

    return match ($groupBy) {
        'schoolYear' => [
            'labelExpr' => "COALESCE(sy.sy_code, 'Unassigned')",
            'groupBy' => 'sy.sy_id, sy.sy_code',
            'joins' => $baseJoins . '
        LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
        LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id',
        ],
        'semester' => [
            'labelExpr' => "COALESCE(sem.semester_name, 'Unassigned')",
            'groupBy' => 'sem.semester_id, sem.semester_name',
            'joins' => $baseJoins . '
        LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
        LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
        LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id',
        ],
        'campus' => [
            'labelExpr' => "COALESCE(c.campus_name, 'Unassigned')",
            'groupBy' => 'c.campus_id, c.campus_name',
            'joins' => $baseJoins . '
        LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id',
        ],
        'modality' => [
            'labelExpr' => "COALESCE(m.modality_name, 'Unassigned')",
            'groupBy' => 'm.modality_id, m.modality_name',
            'joins' => $baseJoins . '
        LEFT JOIN tbl_csdl_modalities m ON m.modality_id = s.student_modality_id',
        ],
        'program' => [
            'labelExpr' => "COALESCE(p.program_name, 'Unassigned')",
            'groupBy' => 'p.program_id, p.program_name',
            'joins' => $baseJoins,
        ],
        'yearLevel' => [
            'labelExpr' => "COALESCE(yl.year_level_name, 'Unassigned')",
            'groupBy' => 'yl.year_level_id, yl.year_level_name',
            'joins' => $baseJoins . '
        LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id',
        ],
        default => [
            'labelExpr' => "COALESCE(d.department_name, 'Unassigned')",
            'groupBy' => 'd.department_id, d.department_name',
            'joins' => $baseJoins,
        ],
    };
}

/**
 * @param array<string, string> $filters
 * @return array{metric: string, groupBy: string, groupLabel: string, rows: array<int, array<string, mixed>>}
 */
function csdlDashboardFetchChartRows(PDO $pdo, array $filters): array
{
    $groupBy = csdlDashboardResolveChartGroupBy($filters);
    $group = csdlDashboardChartGroupDefinition($groupBy);
    $groupMeta = [
        'groupBy' => $groupBy,
        'groupLabel' => csdlDashboardChartGroupLabel($groupBy),
    ];

    $params = [];
    $chartWhere = csdlDashboardChartWhere($filters, $params, 'l', 's') . csdlDashboardVisibleLoanWhere($filters);
    $loanStmt = $pdo->prepare("
        SELECT {$group['labelExpr']} AS label, COUNT(l.loan_id) AS value
        FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
        {$group['joins']}
        WHERE 1=1{$chartWhere}
        GROUP BY {$group['groupBy']}
        HAVING value > 0
        ORDER BY value DESC, label ASC
    ");
    foreach ($params as $key => $value) {
        $loanStmt->bindValue($key, $value);
    }
    $loanStmt->execute();
    $loanRows = $loanStmt->fetchAll(PDO::FETCH_ASSOC);
    $loanTotal = array_sum(array_map(static fn ($row) => (int) ($row['value'] ?? 0), $loanRows));
    if ($loanTotal > 0) {
        return array_merge($groupMeta, ['metric' => 'applications', 'rows' => $loanRows]);
    }

    // The CSDL dashboard is loan-driven. Do not fall back to registered-student
    // profile data when no loan matches the selected filters.
    return array_merge($groupMeta, ['metric' => 'applications', 'rows' => []]);
}

try {
    $action = $_GET['action'] ?? '';
    $view = $_GET['view'] ?? '';
    $detail = $_GET['detail'] ?? '';
    $filters = csdlDashboardParseFilters($_GET);

    if ($action === 'filters') {
        $periods = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_name")->fetchAll(PDO::FETCH_ASSOC);
        $semesters = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_name")->fetchAll(PDO::FETCH_ASSOC);
        $schoolYears = $pdo->query("SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1 ORDER BY sy_id DESC")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($schoolYears as &$sy) {
            $sy['sy_name'] = $sy['sy_code'];
        }
        unset($sy);
        $departments = $pdo->query("SELECT department_id, department_name FROM tbl_csdl_departments ORDER BY department_name")->fetchAll(PDO::FETCH_ASSOC);
        $campuses = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses ORDER BY campus_name")->fetchAll(PDO::FETCH_ASSOC);
        $programs = $pdo->query("SELECT program_id, program_name, program_department_id FROM tbl_csdl_programs ORDER BY program_name")->fetchAll(PDO::FETCH_ASSOC);
        $yearLevels = $pdo->query("SELECT year_level_id, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_id")->fetchAll(PDO::FETCH_ASSOC);
        $modalities = $pdo->query("SELECT modality_code, modality_name FROM tbl_csdl_modalities WHERE modality_status = 1 ORDER BY modality_id")->fetchAll(PDO::FETCH_ASSOC);
        $scholarships = $pdo->query("SELECT scholarship_id, scholarship_name FROM tbl_csdl_scholarships ORDER BY scholarship_name")->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode([
            'success' => true,
            'periods' => $periods,
            'semesters' => $semesters,
            'schoolYears' => $schoolYears,
            'departments' => $departments,
            'campuses' => $campuses,
            'programs' => $programs,
            'yearLevels' => $yearLevels,
            'modalities' => $modalities,
            'scholarships' => $scholarships,
        ]);
        return;
    }

    if ($action === 'summary') {
        $loanParams = [];
        $loanWhere = csdlDashboardChartWhere($filters, $loanParams, 'l', 's');
        $allBaseFrom = 'FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE 1=1' . $loanWhere;

        $count = static function (string $baseFrom, array $params, string $extra) use ($pdo): int {
            $stmt = $pdo->prepare("SELECT COUNT(*) {$baseFrom}{$extra}");
            foreach ($params as $key => $value) {
                $stmt->bindValue($key, $value);
            }
            $stmt->execute();
            return (int) $stmt->fetchColumn();
        };

        $distinct = static function (string $baseFrom, array $params, string $extra) use ($pdo): int {
            $stmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_student_id) {$baseFrom}{$extra}");
            foreach ($params as $key => $value) {
                $stmt->bindValue($key, $value);
            }
            $stmt->execute();
            return (int) $stmt->fetchColumn();
        };

        echo json_encode([
            'success' => true,
            'summary' => [
                // The default scope excludes returned/cancelled loans; an explicit Returned filter includes them.
                'enrolled' => $distinct($allBaseFrom, $loanParams, csdlDashboardVisibleLoanWhere($filters)),
                'applicants' => $distinct($allBaseFrom, $loanParams, csdlDashboardVisibleLoanWhere($filters)),
                // All Applications follows the same scope as the chart and its export.
                'applications' => $count($allBaseFrom, $loanParams, csdlDashboardVisibleLoanWhere($filters)),
                'approvedApplications' => $count($allBaseFrom, $loanParams, ' AND l.loan_status_id = 2'),
                'pending' => $count($allBaseFrom, $loanParams, ' AND l.loan_status_id = 1'),
            ],
        ]);
        return;
    }

    if ($action === 'chart') {
        $chart = csdlDashboardFetchChartRows($pdo, $filters);
        $rows = $chart['rows'];
        echo json_encode([
            'success' => true,
            'metric' => $chart['metric'],
            'groupBy' => $chart['groupBy'],
            'groupLabel' => $chart['groupLabel'],
            'labels' => array_column($rows, 'label'),
            'values' => array_map('intval', array_column($rows, 'value')),
        ]);
        return;
    }

    if ($action === 'chartExport') {
        if (!array_filter($filters, static fn (string $value): bool => $value !== '')) {
            $where = csdlDashboardVisibleLoanWhere($filters);
            $stmt = $pdo->prepare("
                SELECT
                    sy.sy_code AS `SCHOOL YEAR`,
                    c.campus_name AS `CAMPUS`,
                    sem.semester_name AS `SEMESTER`,
                    ap.app_period_name AS `PERIOD`,
                    d.department_name AS `DEPARTMENT`,
                    p.program_name AS `PROGRAM`,
                    yl.year_level_name AS `YEAR LEVEL`,
                    m.modality_name AS `MODALITY`,
                    ls.loan_status_name AS `STATUS`,
                    sch.scholarship_name AS `SCHOLARSHIP`,
                    COUNT(l.loan_id) AS `Count`
                FROM tbl_csdl_loans l
                JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
                LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id
                LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                LEFT JOIN tbl_csdl_modalities m ON m.modality_id = s.student_modality_id
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                WHERE 1=1{$where}
                GROUP BY sy.sy_code, c.campus_name, sem.semester_name,
                         ap.app_period_name, d.department_name, p.program_name,
                         yl.year_level_name, m.modality_name, ls.loan_status_name,
                         sch.scholarship_name
                ORDER BY `Count` DESC, sy.sy_code DESC, c.campus_name ASC
            ");
            $stmt->execute();
            echo json_encode(['success' => true, 'defaultRows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
            return;
        }

        $chart = csdlDashboardFetchChartRows($pdo, $filters);
        echo json_encode([
            'success' => true,
            'chart' => $chart['rows'],
            'chartMetric' => $chart['metric'],
            'chartGroupLabel' => $chart['groupLabel'],
        ]);
        return;
    }

    if ($action === 'forApproval') {
        $approvalPeriod = trim((string) ($_GET['approvalPeriod'] ?? ''));
        $loanFilters = $filters;
        $loanFilters['period'] = '';
        $params = [];
        $loanWhere = csdlDashboardChartWhere($loanFilters, $params, 'l', 's');
        if ($approvalPeriod !== '') {
            $loanWhere .= ' AND l.loan_app_period_id = :approvalPeriod';
            $params[':approvalPeriod'] = $approvalPeriod;
        }
        $loanWhere .= ' AND l.loan_status_id NOT IN (3, 8, 9)';

        $pendingStmt = $pdo->prepare("
            SELECT
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS pendingCsdl,
                SUM(CASE WHEN l.loan_current_step_id = 2 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS pendingCashier,
                SUM(CASE WHEN l.loan_current_step_id = 11 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS pendingAssessment,
                SUM(CASE WHEN l.loan_current_step_id = 3 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS pendingBranch,
                SUM(CASE WHEN l.loan_current_step_id = 4 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS pendingCoo
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            WHERE 1=1{$loanWhere}
        ");
        foreach ($params as $key => $value) {
            $pendingStmt->bindValue($key, $value);
        }
        $pendingStmt->execute();
        $pendingRow = $pendingStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $pendingCsdl = (int) ($pendingRow['pendingCsdl'] ?? 0);
        $pendingAssessment = (int) ($pendingRow['pendingAssessment'] ?? 0);
        $pendingCashier = (int) ($pendingRow['pendingCashier'] ?? 0);
        $pendingBranch = (int) ($pendingRow['pendingBranch'] ?? 0);
        $pendingCoo = (int) ($pendingRow['pendingCoo'] ?? 0);

        $scholarshipStmt = $pdo->prepare("
            SELECT
                COALESCE(NULLIF(TRIM(sch.scholarship_name), ''), 'No Scholarship') AS classification,
                COUNT(DISTINCT l.loan_id) AS count
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
            WHERE 1=1{$loanWhere}
            GROUP BY sch.scholarship_id, sch.scholarship_name
            ORDER BY count DESC, classification ASC
        ");
        foreach ($params as $key => $value) {
            $scholarshipStmt->bindValue($key, $value);
        }
        $scholarshipStmt->execute();
        $scholarshipSummary = $scholarshipStmt->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode([
            'success' => true,
            'pendingSummary' => [
                'csdl' => $pendingCsdl,
                'assessment' => $pendingAssessment,
                'cashier' => $pendingCashier,
                'branch' => $pendingBranch,
                'coo' => $pendingCoo,
                'total' => $pendingCsdl + $pendingAssessment + $pendingCashier + $pendingBranch + $pendingCoo,
            ],
            'scholarshipSummary' => $scholarshipSummary,
        ]);
        return;
    }

    if ($action === 'export') {
        $approvalPeriod = trim((string) ($_GET['approvalPeriod'] ?? ''));
        $loanFilters = $filters;
        if ($approvalPeriod !== '') {
            $loanFilters['period'] = '';
        }
        $params = [];
        // Exports respect every dashboard filter, including program and year level.
        $loanWhere = csdlDashboardChartWhere($loanFilters, $params, 'l', 's');
        if ($approvalPeriod !== '') {
            $loanWhere .= ' AND l.loan_app_period_id = :approvalPeriod';
            $params[':approvalPeriod'] = $approvalPeriod;
        }

        $chartData = csdlDashboardFetchChartRows($pdo, $loanFilters);
        $chartRows = $chartData['rows'];

        $approvalParams = $params;
        $approvalWhere = $loanWhere . ' AND l.loan_status_id NOT IN (3, 8, 9)';
        $approvalStmt = $pdo->prepare("
            SELECT
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 7 THEN 1 ELSE 0 END) AS csdl,
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS csdlPending,
                SUM(CASE WHEN l.loan_current_step_id = 2 AND l.loan_status_id IN (1, 7) THEN 1 ELSE 0 END) AS cashier,
                SUM(CASE WHEN l.loan_current_step_id = 11 AND l.loan_status_id IN (1, 7) THEN 1 ELSE 0 END) AS assessment,
                SUM(CASE WHEN l.loan_current_step_id = 3 AND l.loan_status_id IN (1, 7) THEN 1 ELSE 0 END) AS branch,
                SUM(CASE WHEN l.loan_current_step_id = 4 AND l.loan_status_id IN (1, 7) THEN 1 ELSE 0 END) AS coo
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            WHERE 1=1{$approvalWhere}
        ");
        foreach ($approvalParams as $key => $value) {
            $approvalStmt->bindValue($key, $value);
        }
        $approvalStmt->execute();
        $approvalRow = $approvalStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        // Export 1: applications still waiting at each office's workflow step.
        $pendingStmt = $pdo->prepare("\n            SELECT\n                SUM(CASE WHEN l.loan_current_step_id = 2 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS cashier,\n                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS csdl,\n                SUM(CASE WHEN l.loan_current_step_id = 11 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS assessment,\n                SUM(CASE WHEN l.loan_current_step_id = 3 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS branch,\n                SUM(CASE WHEN l.loan_current_step_id = 4 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS coo\n            FROM tbl_csdl_loans l\n            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id\n            WHERE 1=1{$loanWhere}\n        ");
        foreach ($params as $key => $value) {
            $pendingStmt->bindValue($key, $value);
        }
        $pendingStmt->execute();
        $pendingRow = $pendingStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        // Approval export: completed office approvals and fully paid Assessment PN tags.
        // Partial payments remain active and are intentionally excluded.
        $approvalHistoryStmt = $pdo->prepare("\n            SELECT\n                CASE a.approval_step_id\n                    WHEN 11 THEN 'Assessment'\n                    WHEN 1 THEN 'CSDL'\n                    WHEN 2 THEN 'Cashier'\n                    WHEN 3 THEN 'Branch Admin'\n                    WHEN 4 THEN 'COO'\n                END AS approver,\n                COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.employee_first_name, e.employee_middle_name, e.employee_last_name)), ''), 'Unassigned') AS approver_name,\n                COUNT(DISTINCT a.approval_loan_id) AS applications,\n                COUNT(DISTINCT a.approval_loan_id) AS approved\n            FROM tbl_csdl_loan_approvals a\n            JOIN tbl_csdl_loans l ON l.loan_id = a.approval_loan_id\n            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id\n            LEFT JOIN tbl_csdl_employees e ON e.employee_id = a.approval_processed_by\n            WHERE a.approval_step_id IN (1, 2, 3, 4, 11){$loanWhere}\n              AND (\n                  (a.approval_step_id IN (1, 2, 3, 4) AND a.approval_status_id = 2)\n                  OR (a.approval_step_id = 11 AND a.approval_pn_tagging = 'Paid')\n              )\n            GROUP BY a.approval_step_id, e.employee_id, approver_name\n            ORDER BY FIELD(a.approval_step_id, 11, 1, 2, 3, 4), approver_name ASC\n        ");
        foreach ($params as $key => $value) {
            $approvalHistoryStmt->bindValue($key, $value);
        }
        $approvalHistoryStmt->execute();
        $approvalHistory = $approvalHistoryStmt->fetchAll(PDO::FETCH_ASSOC);

        // Export 3: application counts by program for today, the last seven days,
        // and the current calendar month.
        $programStmt = $pdo->prepare("\n            SELECT\n                COALESCE(p.program_name, 'Unassigned') AS program,\n                SUM(CASE WHEN l.loan_application_date = CURDATE() THEN 1 ELSE 0 END) AS daily_report,\n                SUM(CASE WHEN l.loan_application_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND CURDATE() THEN 1 ELSE 0 END) AS weekly_report,\n                SUM(CASE WHEN YEAR(l.loan_application_date) = YEAR(CURDATE())\n                          AND MONTH(l.loan_application_date) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS monthly_report\n            FROM tbl_csdl_loans l\n            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id\n            LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id\n            WHERE 1=1{$loanWhere}\n            GROUP BY p.program_id, p.program_name\n            ORDER BY program ASC\n        ");
        foreach ($params as $key => $value) {
            $programStmt->bindValue($key, $value);
        }
        $programStmt->execute();
        $programReports = $programStmt->fetchAll(PDO::FETCH_ASSOC);

        $officeNames = [
            11 => ['label' => 'Assessment', 'pendingKey' => 'assessment'],
            1 => ['label' => 'CSDL', 'pendingKey' => 'csdl'],
            2 => ['label' => 'Cashier', 'pendingKey' => 'cashier'],
            3 => ['label' => 'Branch Admin', 'pendingKey' => 'branch'],
            4 => ['label' => 'COO', 'pendingKey' => 'coo'],
        ];
        $pendingApprovals = [];
        foreach ($officeNames as $stepId => $office) {
            $pendingApprovals[] = [
                'Approver' => $office['label'],
                'Pending Approval' => (int) ($pendingRow[$office['pendingKey']] ?? 0),
            ];
        }
        $approverApplications = array_map(static function (array $historyRow): array {
            return [
                'Approver' => $historyRow['approver'] ?? '',
                'Name' => $historyRow['approver_name'] ?? 'Unassigned',
                'Applications' => (int) ($historyRow['applications'] ?? 0),
                'Approved' => (int) ($historyRow['approved'] ?? 0),
            ];
        }, $approvalHistory);

        echo json_encode([
            'success' => true,
            'chart' => $chartRows,
            'chartMetric' => $chartData['metric'],
            'chartGroupBy' => $chartData['groupBy'],
            'chartGroupLabel' => $chartData['groupLabel'],
            'forApproval' => [
                ['Office' => 'CSDL', 'Count' => (int) ($approvalRow['csdl'] ?? 0)],
                ['Office' => 'CSDL-PENDING', 'Count' => (int) ($approvalRow['csdlPending'] ?? 0)],
                ['Office' => 'CASHIER', 'Count' => (int) ($approvalRow['cashier'] ?? 0)],
                ['Office' => 'ASSESSMENT', 'Count' => (int) ($approvalRow['assessment'] ?? 0)],
                ['Office' => 'BRANCH', 'Count' => (int) ($approvalRow['branch'] ?? 0)],
                ['Office' => 'COO', 'Count' => (int) ($approvalRow['coo'] ?? 0)],
            ],
            'pendingApprovals' => $pendingApprovals,
            'approverApplications' => $approverApplications,
            'programReports' => $programReports,
        ]);
        return;
    }

    // Complete row-level export for the All Applications dashboard card.
    // Use the same filters and status scope as the card's count and modal.
    if ($action === 'applicationExport') {
        $params = [];
        $where = csdlDashboardChartWhere($filters, $params, 'l', 's')
            . csdlDashboardVisibleLoanWhere($filters);

        $stmt = $pdo->prepare("
            SELECT
                l.loan_application_no AS `Application No.`,
                l.loan_application_date AS `Application Date`,
                ls.loan_status_name AS `Loan Status`,
                ws.step_name AS `Current Step`,
                s.student_school_id AS `Student ID`,
                CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS `Student Name`,
                s.student_email AS `School Email`,
                s.student_personal_email AS `Personal Email`,
                s.student_contact_number AS `Student Contact`,
                s.student_fb_account AS `Facebook Account`,
                s.student_gender AS `Gender`,
                s.student_date_of_birth AS `Birth Date`,
                c.campus_name AS `Campus`,
                d.department_name AS `Department`,
                p.program_code AS `Program Code`,
                p.program_name AS `Program`,
                yl.year_level_name AS `Year Level`,
                sch.scholarship_name AS `Scholarship`,
                ap.app_period_name AS `Application Period`,
                sy.sy_code AS `School Year`,
                sem.semester_name AS `Semester`,
                b.balance_previous_balance AS `Previous Balance`,
                b.balance_current_balance AS `Current Balance`,
                b.balance_total_balance AS `Total Balance`,
                b.balance_advice_to_pay AS `Advised To Pay`,
                b.balance_as_of_date AS `Balance As Of Date`,
                l.loan_amount_can_pay AS `Amount Can Pay`,
                l.loan_reason AS `Reason for Application`,
                l.loan_promised_payment_date AS `Promised Payment Date`,
                l.loan_due_date AS `Due Date`,
                CASE WHEN l.loan_data_privacy_consent = 1 THEN 'Yes' ELSE 'No' END AS `Data Privacy Consent`,
                CASE WHEN l.loan_promissory_agreement = 1 THEN 'Yes' ELSE 'No' END AS `Promissory Agreement`,
                g.guardian_name AS `Guardian Name`,
                rel.relationship_name AS `Guardian Relationship`,
                g.guardian_contact AS `Guardian Contact`
            FROM tbl_csdl_loans l
            INNER JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
            LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
            LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
            LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
            LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
            LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
            LEFT JOIN tbl_csdl_guardians g ON g.guardian_id = l.loan_guardian_id
            LEFT JOIN tbl_csdl_relationships rel ON rel.relationship_id = g.guardian_relationship_id
            LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
            LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id
            LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
            LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
            LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
            WHERE 1=1{$where}
            ORDER BY l.loan_application_date DESC, l.loan_id DESC
        ");
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->execute();
        echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
        return;
    }

    if ($detail) {
        try {
            if ($detail === 'enrolledBreakdown') {
                $freshmen = (int) $pdo->query("SELECT COUNT(*) c FROM tbl_csdl_students WHERE student_year_level_id = 1")->fetchColumn();
                $upper = (int) $pdo->query("SELECT COUNT(*) c FROM tbl_csdl_students WHERE student_year_level_id > 1")->fetchColumn();
                echo json_encode(['success' => true, 'freshmen' => $freshmen, 'upper' => $upper]);
                return;
            }
            if ($detail === 'enrolledBreakdownList') {
                $params = [];
                $where = csdlDashboardChartWhere($filters, $params, 'l', 's') . csdlDashboardVisibleLoanWhere($filters);
                $stmt = $pdo->prepare("SELECT s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             p.program_name AS program,
                                             yl.year_level_name AS yearLevel
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                      LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                                      LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                                      WHERE 1=1{$where}
                                      GROUP BY s.student_id, s.student_school_id, s.student_last_name, s.student_first_name, p.program_name, yl.year_level_name
                                      ORDER BY s.student_last_name ASC, s.student_first_name ASC");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'applicantsList') {
                $params = [];
                // Match the card's filtered loan scope.
                $where = csdlDashboardChartWhere($filters, $params, 'l', 's') . csdlDashboardVisibleLoanWhere($filters);
                $stmt = $pdo->prepare("SELECT s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             p.program_name AS program,
                                             COUNT(l.loan_id) AS totalApplications
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                      LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                                      WHERE 1=1{$where}
                                      GROUP BY s.student_id, s.student_school_id, s.student_last_name, s.student_first_name, p.program_name
                                      ORDER BY s.student_last_name, s.student_first_name");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'applicationsList') {
                $params = [];
                // Keep the modal aligned with the All Applications card.
                $where = csdlDashboardChartWhere($filters, $params, 'l', 's') . csdlDashboardVisibleLoanWhere($filters);
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                             s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             l.loan_amount_can_pay AS amount,
                                             ls.loan_status_name AS status,
                                             l.loan_application_date AS dateApplied
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                      LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                      WHERE 1=1{$where}
                                      ORDER BY l.loan_application_date DESC, l.loan_id DESC");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'approvedList') {
                $params = [];
                $where = csdlDashboardChartWhere($filters, $params, 'l', 's') . ' AND l.loan_status_id = 2';
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                             s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             l.loan_amount_can_pay AS amount,
                                             l.loan_application_date AS dateApplied,
                                             l.loan_approval_date AS dateApproved
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                      WHERE 1=1{$where}
                                      ORDER BY COALESCE(l.loan_approval_date, l.loan_application_date) DESC, l.loan_id DESC");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'pendingList') {
                $params = [];
                $where = csdlDashboardChartWhere($filters, $params, 'l', 's') . ' AND l.loan_status_id = 1';
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                             s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             l.loan_amount_can_pay AS amount,
                                             ls.loan_status_name AS status,
                                             l.loan_application_date AS dateApplied
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                      LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                      WHERE 1=1{$where}
                                      ORDER BY l.loan_application_date DESC, l.loan_id DESC");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
        } catch (Throwable $e) {
            echo json_encode(['success' => true, 'rows' => []]);
            return;
        }
    }

    if ($view) {
        try {
            $labels = [];
            $values = [];

            if ($view === 'studentsByDept') {
                $params = [];
                $where = csdlDashboardStudentWhere($filters, $params, 's');
                $q = $pdo->prepare("SELECT d.department_name AS label, COUNT(s.student_id) AS value
                                  FROM tbl_csdl_departments d
                                  LEFT JOIN tbl_csdl_programs p ON p.program_department_id = d.department_id
                                  LEFT JOIN tbl_csdl_students s ON s.student_program_id = p.program_id
                                  WHERE 1=1{$where}
                                  GROUP BY d.department_id, d.department_name
                                  ORDER BY d.department_name");
                foreach ($params as $key => $value) {
                    $q->bindValue($key, $value);
                }
                $q->execute();
                foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $labels[] = $r['label'];
                    $values[] = (int) $r['value'];
                }
            } elseif ($view === 'employeesByDept') {
                $q = $pdo->query("SELECT r.role_name AS label, COUNT(e.employee_id) AS value
                                  FROM tbl_csdl_roles r
                                  LEFT JOIN tbl_csdl_employees e ON e.employee_role_id = r.role_id
                                  GROUP BY r.role_id, r.role_name
                                  ORDER BY r.role_name");
                foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $labels[] = $r['label'];
                    $values[] = (int) $r['value'];
                }
            } elseif (in_array($view, ['appsWeekly', 'appsMonthly', 'appsYearly'], true)) {
                $params = [];
                $loanFilter = csdlDashboardLoanWhere($filters, $params, 'l', 's');
                if ($view === 'appsWeekly') {
                    $today = new DateTime();
                    $dayOfWeek = (int) $today->format('N');
                    $daysToMonday = $dayOfWeek - 1;
                    $monday = clone $today;
                    $monday->modify("-{$daysToMonday} days");
                    $monday->setTime(0, 0, 0);
                    $sunday = clone $monday;
                    $sunday->modify('+6 days');
                    $mondayStr = $monday->format('Y-m-d');
                    $sundayStr = $sunday->format('Y-m-d');

                    $q = $pdo->prepare("SELECT DATE(l.loan_application_date) AS d, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE DATE(l.loan_application_date) >= :weekStart AND DATE(l.loan_application_date) <= :weekEnd{$loanFilter}
                                       GROUP BY DATE(l.loan_application_date)
                                       ORDER BY d ASC");
                    $q->bindValue(':weekStart', $mondayStr);
                    $q->bindValue(':weekEnd', $sundayStr);
                    foreach ($params as $key => $value) {
                        $q->bindValue($key, $value);
                    }
                    $q->execute();
                    $map = [];
                    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
                        $map[$r['d']] = (int) $r['c'];
                    }
                    $currentDate = clone $monday;
                    for ($i = 0; $i < 7; $i++) {
                        $key = $currentDate->format('Y-m-d');
                        $labels[] = $currentDate->format('M j');
                        $values[] = $map[$key] ?? 0;
                        $currentDate->modify('+1 day');
                    }
                } elseif ($view === 'appsMonthly') {
                    $q = $pdo->prepare("SELECT DATE_FORMAT(l.loan_application_date, '%Y-%m') AS ym, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH){$loanFilter}
                                       GROUP BY YEAR(l.loan_application_date), MONTH(l.loan_application_date)
                                       ORDER BY YEAR(l.loan_application_date), MONTH(l.loan_application_date) ASC");
                    foreach ($params as $key => $value) {
                        $q->bindValue($key, $value);
                    }
                    $q->execute();
                    $map = [];
                    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
                        $map[$r['ym']] = (int) $r['c'];
                    }
                    $cursor = new DateTime('first day of this month');
                    $cursor->modify('-11 months');
                    for ($i = 0; $i < 12; $i++) {
                        $key = $cursor->format('Y-m');
                        $labels[] = $cursor->format('M Y');
                        $values[] = $map[$key] ?? 0;
                        $cursor->modify('+1 month');
                    }
                } else {
                    $q = $pdo->prepare("SELECT DATE_FORMAT(l.loan_application_date, '%Y') AS y, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 4 YEAR){$loanFilter}
                                       GROUP BY YEAR(l.loan_application_date)
                                       ORDER BY YEAR(l.loan_application_date) ASC");
                    foreach ($params as $key => $value) {
                        $q->bindValue($key, $value);
                    }
                    $q->execute();
                    $map = [];
                    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
                        $map[$r['y']] = (int) $r['c'];
                    }
                    $year = (int) date('Y') - 4;
                    for ($i = 0; $i < 5; $i++) {
                        $y = (string) ($year + $i);
                        $labels[] = $y;
                        $values[] = $map[$y] ?? 0;
                    }
                }
            }

            echo json_encode(['success' => true, 'labels' => $labels, 'values' => $values]);
            return;
        } catch (Throwable $e) {
            echo json_encode(['success' => true, 'labels' => [], 'values' => []]);
            return;
        }
    }

    // Default summary follows the same loan-only scope as action=summary.
    $loanParams = [];
    $loanWhere = csdlDashboardChartWhere($filters, $loanParams, 'l', 's');
    $allBaseFrom = 'FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE 1=1' . $loanWhere;

    $countStmt = static function (string $baseFrom, array $params, string $extra) use ($pdo): int {
        $stmt = $pdo->prepare("SELECT COUNT(*) {$baseFrom}{$extra}");
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->execute();
        return (int) $stmt->fetchColumn();
    };

    $distinctStmt = static function (string $baseFrom, array $params, string $extra) use ($pdo): int {
        $stmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_student_id) {$baseFrom}{$extra}");
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->execute();
        return (int) $stmt->fetchColumn();
    };

    echo json_encode(['success' => true, 'summary' => [
        'enrolled' => $distinctStmt($allBaseFrom, $loanParams, ''),
        'applicants' => $distinctStmt($allBaseFrom, $loanParams, ''),
        'applications' => $countStmt($allBaseFrom, $loanParams, ''),
        'approvedApplications' => $countStmt($allBaseFrom, $loanParams, ' AND l.loan_status_id = 2'),
        'pending' => $countStmt($allBaseFrom, $loanParams, ' AND l.loan_status_id = 1'),
    ]]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load dashboard']);
}
