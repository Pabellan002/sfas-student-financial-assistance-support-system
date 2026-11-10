<?php
/**
 * Branch Admin dashboard — role 98, scoped by employee campus.
 * KPIs and charts use Branch Admin step (3) approval history.
 * Pending queue remains loans currently at branch with actionable statuses.
 */
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$userRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
if ($userRoleId !== 98) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Branch Admin role required.']);
    exit;
}

$campusId = (int) ($_SESSION['campus_id'] ?? 0);
if ($campusId <= 0) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'No campus assigned to your account.']);
    exit;
}

const BRANCH_STEP = 3;

/**
 * @return array<string, string>
 */
function branchAdminDashboardParseFilters(array $get): array
{
    return [
        'schoolYear' => trim((string) ($get['schoolYear'] ?? '')),
        'semester' => trim((string) ($get['semester'] ?? '')),
        'period' => trim((string) ($get['period'] ?? '')),
        'department' => trim((string) ($get['department'] ?? '')),
        'program' => trim((string) ($get['program'] ?? '')),
        'yearLevel' => trim((string) ($get['yearLevel'] ?? '')),
    ];
}

/**
 * Student profile filters only (department, program, year level).
 *
 * @param array<string, string> $filters
 * @return array<string, string>
 */
function branchAdminDashboardStudentProfileFilters(array $filters): array
{
    return [
        'department' => $filters['department'] ?? '',
        'program' => $filters['program'] ?? '',
        'yearLevel' => $filters['yearLevel'] ?? '',
    ];
}

/**
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function branchAdminDashboardStudentWhere(array $filters, array &$params, string $alias = 's'): string
{
    $profile = branchAdminDashboardStudentProfileFilters($filters);
    $parts = [];
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
    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

/**
 * Loan application filters: school year, semester, period (via loan/balance).
 *
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function branchAdminDashboardLoanApplicationWhere(array $filters, array &$params, string $loanAlias = 'l'): string
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
    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

/**
 * Chart dimension: drill down based on active student profile filters.
 *
 * @param array<string, string> $filters
 */
function branchAdminDashboardResolveChartGroupBy(array $filters): string
{
    $profile = branchAdminDashboardStudentProfileFilters($filters);
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

function branchAdminDashboardChartGroupLabel(string $groupBy): string
{
    return match ($groupBy) {
        'program' => 'Program',
        'yearLevel' => 'Year Level',
        default => 'Department',
    };
}

/**
 * @return array{labelExpr: string, groupBy: string, joins: string}
 */
function branchAdminDashboardChartGroupDefinition(string $groupBy): array
{
    $baseJoins = '
        LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
        LEFT JOIN tbl_csdl_departments d ON d.department_id = p.program_department_id';

    return match ($groupBy) {
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
function branchAdminDashboardFetchChartRows(PDO $pdo, array $filters, int $campusId): array
{
    $groupBy = branchAdminDashboardResolveChartGroupBy($filters);
    $group = branchAdminDashboardChartGroupDefinition($groupBy);
    $groupMeta = [
        'groupBy' => $groupBy,
        'groupLabel' => branchAdminDashboardChartGroupLabel($groupBy),
    ];

    $params = [':campusId' => $campusId];
    $studentWhere = branchAdminDashboardStudentWhere($filters, $params, 's');
    $loanWhere = branchAdminDashboardLoanApplicationWhere($filters, $params, 'l');
    // Chart shows all loans at or past Branch Admin step (current + processed)
    $chartWhere = $studentWhere . $loanWhere . ' AND (l.loan_current_step_id = ' . BRANCH_STEP . ' OR ' . sqlBranchProcessedAny() . ')';
    $loanStmt = $pdo->prepare("
        SELECT {$group['labelExpr']} AS label, COUNT(l.loan_id) AS value
        FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
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

    // If loan filters (schoolYear, semester, period) are active, don't fall back to students
    // Show empty chart instead to accurately reflect "no loan applications match these filters"
    $hasLoanFilters = !empty($filters['schoolYear']) || !empty($filters['semester']) || !empty($filters['period']);
    if ($hasLoanFilters) {
        return array_merge($groupMeta, ['metric' => 'applications', 'rows' => []]);
    }

    // Only fall back to student count if no loan-specific filters are active
    $params = [':campusId' => $campusId];
    $studentWhere = branchAdminDashboardStudentWhere($filters, $params, 's');
    $studentStmt = $pdo->prepare("
        SELECT {$group['labelExpr']} AS label, COUNT(s.student_id) AS value
        FROM tbl_csdl_students s
        {$group['joins']}
        WHERE s.student_campus_id = :campusId{$studentWhere}
        GROUP BY {$group['groupBy']}
        HAVING value > 0
        ORDER BY value DESC, label ASC
    ");
    foreach ($params as $key => $value) {
        $studentStmt->bindValue($key, $value);
    }
    $studentStmt->execute();

    return array_merge($groupMeta, [
        'metric' => 'students',
        'rows' => $studentStmt->fetchAll(PDO::FETCH_ASSOC),
    ]);
}

/** Branch processed at step 3: approved (2), declined (3), or returned (5). */
function sqlBranchProcessedAny(): string
{
    return 'EXISTS (
        SELECT 1 FROM tbl_csdl_loan_approvals la0
        WHERE la0.approval_loan_id = l.loan_id
        AND la0.approval_step_id = ' . BRANCH_STEP . '
        AND la0.approval_status_id IN (2, 3, 5)
    )';
}

try {
    $action = $_GET['action'] ?? '';
    $view = $_GET['view'] ?? '';
    $detail = $_GET['detail'] ?? '';
    $filters = branchAdminDashboardParseFilters($_GET);

    if ($action === 'filters') {
        $periods = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_name")->fetchAll(PDO::FETCH_ASSOC);
        $semesters = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_name")->fetchAll(PDO::FETCH_ASSOC);
        $schoolYears = $pdo->query("SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1 ORDER BY sy_id DESC")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($schoolYears as &$sy) {
            $sy['sy_name'] = $sy['sy_code'];
        }
        unset($sy);
        $departments = $pdo->query("SELECT department_id, department_name FROM tbl_csdl_departments ORDER BY department_name")->fetchAll(PDO::FETCH_ASSOC);
        $programs = $pdo->query("SELECT program_id, program_name, program_department_id FROM tbl_csdl_programs ORDER BY program_name")->fetchAll(PDO::FETCH_ASSOC);
        $yearLevels = $pdo->query("SELECT year_level_id, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_id")->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode([
            'success' => true,
            'periods' => $periods,
            'semesters' => $semesters,
            'schoolYears' => $schoolYears,
            'departments' => $departments,
            'programs' => $programs,
            'yearLevels' => $yearLevels,
        ]);
        return;
    }

    if ($action === 'summary') {
        // Check if unfiltered summary is requested (for dashboard cards)
        $includeFilters = ($_GET['includeFilters'] ?? 'true') === 'true';
        
        $params = [':campusId' => $campusId];
        $studentWhere = '';
        $loanWhere = '';
        
        if ($includeFilters) {
            $studentWhere = branchAdminDashboardStudentWhere($filters, $params, 's');
            $loanWhere = branchAdminDashboardLoanApplicationWhere($filters, $params, 'l');
        }
        
        $studentSql = 'SELECT COUNT(*) FROM tbl_csdl_students s WHERE s.student_campus_id = :campusId' . $studentWhere;
        $studentStmt = $pdo->prepare($studentSql);
        foreach ($params as $key => $value) {
            $studentStmt->bindValue($key, $value);
        }
        $studentStmt->execute();
        $enrolled = (int) $studentStmt->fetchColumn();

        $loanParams = [':campusId' => $campusId];
        if ($includeFilters) {
            $loanWhere = branchAdminDashboardLoanApplicationWhere($filters, $loanParams, 'l');
        }
        $branchBaseFrom = 'FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId WHERE 1=1' . $loanWhere;
        $allBaseFrom = 'FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId WHERE 1=1' . $loanWhere;

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
                'enrolled' => $enrolled,
                'applicants' => $distinct($branchBaseFrom, $loanParams, ' AND l.loan_current_step_id = ' . BRANCH_STEP),
                'applications' => $count($allBaseFrom, $loanParams, ' AND ' . sqlBranchProcessedAny()),
                'total' => $count($allBaseFrom, $loanParams, ' AND ' . sqlBranchProcessedAny()),
                'approvedApplications' => $count($allBaseFrom, $loanParams, ' AND EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals la WHERE la.approval_loan_id = l.loan_id AND la.approval_step_id = ' . BRANCH_STEP . ' AND la.approval_status_id = 2)'),
                'approved' => $count($allBaseFrom, $loanParams, ' AND EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals la WHERE la.approval_loan_id = l.loan_id AND la.approval_step_id = ' . BRANCH_STEP . ' AND la.approval_status_id = 2)'),
                'returned' => $count($allBaseFrom, $loanParams, ' AND EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals la WHERE la.approval_loan_id = l.loan_id AND la.approval_step_id = ' . BRANCH_STEP . ' AND la.approval_status_id = 5)'),
                'pending' => $count($branchBaseFrom, $loanParams, ' AND l.loan_current_step_id = ' . BRANCH_STEP . ' AND l.loan_status_id IN (1, 12)'),
            ],
        ]);
        return;
    }

    if ($action === 'chart') {
        $chart = branchAdminDashboardFetchChartRows($pdo, $filters, $campusId);
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

    if ($action === 'forApproval') {
        $approvalPeriod = trim((string) ($_GET['approvalPeriod'] ?? ''));
        $loanFilters = $filters;
        $loanFilters['period'] = '';
        $params = [':campusId' => $campusId];
        $loanWhere = branchAdminDashboardLoanApplicationWhere($loanFilters, $params, 'l')
            . branchAdminDashboardStudentWhere($loanFilters, $params, 's');
        if ($approvalPeriod !== '') {
            $loanWhere .= ' AND l.loan_app_period_id = :approvalPeriod';
            $params[':approvalPeriod'] = $approvalPeriod;
        }
        $loanWhere .= ' AND l.loan_status_id NOT IN (3, 8, 9)';

        $stmt = $pdo->prepare("
            SELECT
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 12 THEN 1 ELSE 0 END) AS csdl,
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS csdlPending,
                SUM(CASE WHEN l.loan_current_step_id = 11 AND l.loan_status_id IN (1, 12) THEN 1 ELSE 0 END) AS assessment,
                SUM(CASE WHEN l.loan_current_step_id = 3 AND l.loan_status_id IN (1, 12) THEN 1 ELSE 0 END) AS branch,
                SUM(CASE WHEN l.loan_current_step_id = 4 AND l.loan_status_id IN (1, 12) THEN 1 ELSE 0 END) AS coo
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
            WHERE 1=1{$loanWhere}
        ");
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->execute();
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $csdl = (int) ($row['csdl'] ?? 0);
        $csdlPending = (int) ($row['csdlPending'] ?? 0);
        $assessment = (int) ($row['assessment'] ?? 0);
        $branch = (int) ($row['branch'] ?? 0);
        $coo = (int) ($row['coo'] ?? 0);

        echo json_encode([
            'success' => true,
            'forApproval' => [
                'csdl' => $csdl,
                'csdlPending' => $csdlPending,
                'assessment' => $assessment,
                'branch' => $branch,
                'coo' => $coo,
                'total' => $csdl + $csdlPending + $assessment + $branch + $coo,
            ],
        ]);
        return;
    }

    if ($action === 'export') {
        $approvalPeriod = trim((string) ($_GET['approvalPeriod'] ?? ''));
        $loanFilters = $filters;
        if ($approvalPeriod !== '') {
            $loanFilters['period'] = '';
        }
        $params = [':campusId' => $campusId];
        $loanWhere = branchAdminDashboardLoanApplicationWhere($loanFilters, $params, 'l')
            . branchAdminDashboardStudentWhere($loanFilters, $params, 's');
        if ($approvalPeriod !== '') {
            $loanWhere .= ' AND l.loan_app_period_id = :approvalPeriod';
            $params[':approvalPeriod'] = $approvalPeriod;
        }

        $chartData = branchAdminDashboardFetchChartRows($pdo, $loanFilters, $campusId);
        $chartRows = $chartData['rows'];

        $approvalParams = $params;
        $approvalWhere = $loanWhere . ' AND l.loan_status_id NOT IN (3, 8, 9)';
        $approvalStmt = $pdo->prepare("
            SELECT
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 12 THEN 1 ELSE 0 END) AS csdl,
                SUM(CASE WHEN l.loan_current_step_id = 1 AND l.loan_status_id = 1 THEN 1 ELSE 0 END) AS csdlPending,
                SUM(CASE WHEN l.loan_current_step_id = 11 AND l.loan_status_id IN (1, 12) THEN 1 ELSE 0 END) AS assessment,
                SUM(CASE WHEN l.loan_current_step_id = 3 AND l.loan_status_id IN (1, 12) THEN 1 ELSE 0 END) AS branch,
                SUM(CASE WHEN l.loan_current_step_id = 4 AND l.loan_status_id IN (1, 12) THEN 1 ELSE 0 END) AS coo
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
            WHERE 1=1{$approvalWhere}
        ");
        foreach ($approvalParams as $key => $value) {
            $approvalStmt->bindValue($key, $value);
        }
        $approvalStmt->execute();
        $approvalRow = $approvalStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        echo json_encode([
            'success' => true,
            'chart' => $chartRows,
            'chartMetric' => $chartData['metric'],
            'chartGroupBy' => $chartData['groupBy'],
            'chartGroupLabel' => $chartData['groupLabel'],
            'forApproval' => [
                ['Office' => 'CSDL', 'Count' => (int) ($approvalRow['csdl'] ?? 0)],
                ['Office' => 'CSDL-PENDING', 'Count' => (int) ($approvalRow['csdlPending'] ?? 0)],
                ['Office' => 'ASSESSMENT', 'Count' => (int) ($approvalRow['assessment'] ?? 0)],
                ['Office' => 'BRANCH', 'Count' => (int) ($approvalRow['branch'] ?? 0)],
                ['Office' => 'COO', 'Count' => (int) ($approvalRow['coo'] ?? 0)],
            ],
        ]);
        return;
    }

    if ($detail) {
        try {
            if ($detail === 'enrolledBreakdownList') {
                $params = [':campusId' => $campusId];
                $where = branchAdminDashboardStudentWhere($filters, $params, 's');
                $stmt = $pdo->prepare("SELECT s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             p.program_name AS program,
                                             yl.year_level_name AS yearLevel
                                      FROM tbl_csdl_students s
                                      LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                                      LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                                      WHERE s.student_campus_id = :campusId{$where}
                                      ORDER BY s.student_last_name ASC, s.student_first_name ASC");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'applicantsList') {
                $params = [':campusId' => $campusId];
                $where = branchAdminDashboardLoanApplicationWhere($filters, $params, 'l');
                $stmt = $pdo->prepare("SELECT s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             p.program_name AS program,
                                             COUNT(l.loan_id) AS totalApplications
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
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
                $params = [':campusId' => $campusId];
                $where = branchAdminDashboardLoanApplicationWhere($filters, $params, 'l');
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                             s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             l.loan_amount_can_pay AS amount,
                                             ls.loan_status_name AS status,
                                             l.loan_application_date AS dateApplied
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
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
                $params = [':campusId' => $campusId];
                $where = branchAdminDashboardLoanApplicationWhere($filters, $params, 'l');
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                             s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             l.loan_amount_can_pay AS amount,
                                             ls.loan_status_name AS status,
                                             l.loan_application_date AS dateApplied,
                                             DATE_FORMAT((SELECT MAX(COALESCE(la.approval_date_processed, la.approval_created_at))
                                                    FROM tbl_csdl_loan_approvals la
                                                    WHERE la.approval_loan_id = l.loan_id
                                                    AND la.approval_step_id = " . BRANCH_STEP . "
                                                    AND la.approval_status_id = 2), '%Y-%m-%d') AS dateApproved
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
                                      LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                      WHERE EXISTS (
                                          SELECT 1 FROM tbl_csdl_loan_approvals la
                                          WHERE la.approval_loan_id = l.loan_id
                                          AND la.approval_step_id = " . BRANCH_STEP . "
                                          AND la.approval_status_id = 2
                                      ){$where}
                                      ORDER BY (SELECT MAX(COALESCE(la2.approval_date_processed, la2.approval_created_at))
                                            FROM tbl_csdl_loan_approvals la2
                                            WHERE la2.approval_loan_id = l.loan_id
                                            AND la2.approval_step_id = " . BRANCH_STEP . "
                                            AND la2.approval_status_id = 2) DESC, l.loan_id DESC");
                foreach ($params as $key => $value) {
                    $stmt->bindValue($key, $value);
                }
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'pendingList') {
                $params = [':campusId' => $campusId];
                $where = branchAdminDashboardLoanApplicationWhere($filters, $params, 'l');
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                             s.student_school_id AS schoolId,
                                             CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                             l.loan_amount_can_pay AS amount,
                                             ls.loan_status_name AS status,
                                             l.loan_application_date AS dateApplied
                                      FROM tbl_csdl_loans l
                                      JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = :campusId
                                      LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                      WHERE l.loan_current_step_id = " . BRANCH_STEP . " AND l.loan_status_id IN (1, 12){$where}
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

    $stmt = $pdo->prepare('SELECT COUNT(*) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
        WHERE l.loan_current_step_id = ' . BRANCH_STEP . ' AND l.loan_status_id IN (1, 12)');
    $stmt->execute([$campusId]);
    $pending = (int) $stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
        WHERE ' . sqlBranchProcessedAny());
    $stmt->execute([$campusId]);
    $total = (int) $stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
        INNER JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id
            AND la.approval_step_id = ' . BRANCH_STEP . ' AND la.approval_status_id = 2');
    $stmt->execute([$campusId]);
    $approved = (int) $stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
        INNER JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id
            AND la.approval_step_id = ' . BRANCH_STEP . ' AND la.approval_status_id = 3');
    $stmt->execute([$campusId]);
    $declined = (int) $stmt->fetchColumn();

    echo json_encode(['success' => true, 'summary' => [
        'pending' => $pending,
        'total' => $total,
        'approved' => $approved,
        'declined' => $declined,
    ]]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load dashboard']);
}
