<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$userRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
if ($userRoleId !== 97) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied']);
    exit;
}

define('COO_STEP', 4);

/** @return array<string, string> */
function cooDashboardParseFilters(array $get): array
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
 * Apply the same academic and student filters as the Cashier dashboard while
 * preserving the COO approval scope.
 *
 * @param array<string, string> $filters
 * @param array<string, mixed> $params
 */
function cooDashboardLoanWhere(array $filters, array &$params, string $loanAlias = 'l', string $studentAlias = 's'): string
{
    $parts = [];
    if ($filters['period'] !== '') {
        $parts[] = "{$loanAlias}.loan_app_period_id = :period";
        $params[':period'] = $filters['period'];
    }
    if ($filters['schoolYear'] !== '') {
        $parts[] = "EXISTS (SELECT 1 FROM tbl_csdl_balances b_f WHERE b_f.balance_id = {$loanAlias}.loan_balance_id AND b_f.balance_sy_id = :schoolYear)";
        $params[':schoolYear'] = $filters['schoolYear'];
    }
    if ($filters['semester'] !== '') {
        $parts[] = "EXISTS (SELECT 1 FROM tbl_csdl_balances b_f INNER JOIN tbl_csdl_school_years sy_f ON sy_f.sy_id = b_f.balance_sy_id WHERE b_f.balance_id = {$loanAlias}.loan_balance_id AND sy_f.sy_semester_id = :semester)";
        $params[':semester'] = $filters['semester'];
    }
    if ($filters['department'] !== '') {
        $parts[] = "EXISTS (SELECT 1 FROM tbl_csdl_programs p_f WHERE p_f.program_id = {$studentAlias}.student_program_id AND p_f.program_department_id = :department)";
        $params[':department'] = $filters['department'];
    }
    if ($filters['program'] !== '') {
        $parts[] = "{$studentAlias}.student_program_id = :program";
        $params[':program'] = $filters['program'];
    }
    if ($filters['yearLevel'] !== '') {
        $parts[] = "{$studentAlias}.student_year_level_id = :yearLevel";
        $params[':yearLevel'] = $filters['yearLevel'];
    }

    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

try {
    $view = $_GET['view'] ?? '';
    $detail = $_GET['detail'] ?? '';
    $action = $_GET['action'] ?? '';
    $filters = cooDashboardParseFilters($_GET);
    $loanParams = [];
    $loanWhere = cooDashboardLoanWhere($filters, $loanParams);
    $cooApprovalExists = "EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals ca WHERE ca.approval_loan_id = l.loan_id AND ca.approval_step_id = " . COO_STEP . " AND ca.approval_role_id = 97 AND ca.approval_status_id = 2)";
    $cooFinalApproval = "({$cooApprovalExists} AND l.loan_status_id = 2)";
    $cooDashboardScope = "(l.loan_current_step_id = " . COO_STEP . " OR {$cooApprovalExists})";

    if ($action === 'filters') {
        echo json_encode([
            'success' => true,
            'periods' => $pdo->query('SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_name')->fetchAll(PDO::FETCH_ASSOC),
            'semesters' => $pdo->query('SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_name')->fetchAll(PDO::FETCH_ASSOC),
            'schoolYears' => $pdo->query('SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1 ORDER BY sy_id DESC')->fetchAll(PDO::FETCH_ASSOC),
            'departments' => $pdo->query('SELECT department_id, department_name FROM tbl_csdl_departments ORDER BY department_name')->fetchAll(PDO::FETCH_ASSOC),
            'programs' => $pdo->query('SELECT program_id, program_name, program_department_id FROM tbl_csdl_programs ORDER BY program_name')->fetchAll(PDO::FETCH_ASSOC),
            'yearLevels' => $pdo->query('SELECT year_level_id, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_id')->fetchAll(PDO::FETCH_ASSOC),
        ]);
        exit;
    }

    if ($detail) {
        if ($detail === 'pendingList') {
            $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                        s.student_school_id AS schoolId,
                                        CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                        l.loan_amount_can_pay AS amount,
                                        COALESCE(b.balance_current_balance, 0) AS balance,
                                        l.loan_application_date AS dateApplied
                                 FROM tbl_csdl_loans l
                                 JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                 LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                 WHERE l.loan_current_step_id = " . COO_STEP . " AND l.loan_status_id IN (1, 12){$loanWhere}
                                 ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                 LIMIT 100");
            $stmt->execute($loanParams);
            echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
            exit;
        }
        if ($detail === 'totalList') {
            $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                        s.student_school_id AS schoolId,
                                        CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                        l.loan_amount_can_pay AS amount,
                                        ls.loan_status_name AS status,
                                        l.loan_application_date AS dateApplied
                                 FROM tbl_csdl_loans l
                                 JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                 LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                 WHERE {$cooDashboardScope}{$loanWhere}
                                 ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                 LIMIT 100");
            $stmt->execute($loanParams);
            echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
            exit;
        }
        if ($detail === 'approvedList') {
            $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                        s.student_school_id AS schoolId,
                                        CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                        l.loan_amount_can_pay AS amount,
                                        ls.loan_status_name AS status,
                                        l.loan_application_date AS dateApplied
                                 FROM tbl_csdl_loans l
                                 JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                 LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                 WHERE {$cooFinalApproval}{$loanWhere}
                                 ORDER BY l.loan_approval_date DESC, l.loan_id DESC
                                 LIMIT 100");
            $stmt->execute($loanParams);
            echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
            exit;
        }
        echo json_encode(['success' => true, 'rows' => []]);
        exit;
    }

    if ($view) {
        $labels = [];
        $values = [];

        if ($view === 'appsDaily') {
            $stmt = $pdo->query("SELECT HOUR(l.loan_application_date) AS h, COUNT(*) AS c
                               FROM tbl_csdl_loans l
                               WHERE l.loan_current_step_id = 4
                               AND DATE(l.loan_application_date) = CURDATE()
                               GROUP BY HOUR(l.loan_application_date)
                               ORDER BY h ASC");
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $hour = (int) $r['h'];
                $labels[] = date('g A', mktime($hour, 0, 0));
                $values[] = (int) $r['c'];
            }
        } elseif ($view === 'appsWeekly') {
            $stmt = $pdo->query("SELECT DATE(l.loan_application_date) AS d, COUNT(*) AS c
                               FROM tbl_csdl_loans l
                               WHERE l.loan_current_step_id = 4
                               AND l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                               GROUP BY DATE(l.loan_application_date)
                               ORDER BY d ASC");
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $labels[] = date('M j', strtotime($r['d']));
                $values[] = (int) $r['c'];
            }
        } elseif ($view === 'appsMonthly') {
            $stmt = $pdo->query("SELECT DATE_FORMAT(l.loan_application_date, '%Y-%m') AS ym, COUNT(*) AS c
                               FROM tbl_csdl_loans l
                               WHERE l.loan_current_step_id = 4
                               AND l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
                               GROUP BY YEAR(l.loan_application_date), MONTH(l.loan_application_date)
                               ORDER BY ym ASC");
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $labels[] = date('M Y', strtotime($r['ym'] . '-01'));
                $values[] = (int) $r['c'];
            }
        } elseif ($view === 'appsYearly') {
            $stmt = $pdo->query("SELECT YEAR(l.loan_application_date) AS y, COUNT(*) AS c
                               FROM tbl_csdl_loans l
                               WHERE l.loan_current_step_id = 4
                               AND l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 4 YEAR)
                               GROUP BY YEAR(l.loan_application_date)
                               ORDER BY y ASC");
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $labels[] = (string) $r['y'];
                $values[] = (int) $r['c'];
            }
        } elseif ($view === 'statusBreakdown') {
            $stmt = $pdo->prepare("SELECT CASE
                                        WHEN l.loan_current_step_id = " . COO_STEP . " AND l.loan_status_id IN (1, 12) THEN 'Pending'
                                        WHEN l.loan_status_id = 11 THEN 'Partial Payment'
                                        WHEN {$cooFinalApproval} THEN 'Approved'
                                        ELSE 'In progress'
                                    END AS label,
                                    COUNT(DISTINCT l.loan_id) AS value
                               FROM tbl_csdl_loans l
                               JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                               WHERE {$cooDashboardScope}{$loanWhere}
                               GROUP BY label
                               ORDER BY value DESC");
            $stmt->execute($loanParams);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $labels[] = $r['label'];
                $values[] = (int) $r['value'];
            }
        }

        echo json_encode(['success' => true, 'labels' => $labels, 'values' => $values]);
        exit;
    }

    $pendingStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE l.loan_current_step_id = " . COO_STEP . " AND l.loan_status_id IN (1, 12){$loanWhere}");
    $pendingStmt->execute($loanParams);
    $pending = (int) $pendingStmt->fetchColumn();
    $totalStmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$cooDashboardScope}{$loanWhere}");
    $totalStmt->execute($loanParams);
    $total = (int) $totalStmt->fetchColumn();
    $approvedStmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$cooFinalApproval}{$loanWhere}");
    $approvedStmt->execute($loanParams);
    $approved = (int) $approvedStmt->fetchColumn();

echo json_encode(['success' => true, 'summary' => [
    'pending' => $pending,
    'total' => $total,
    'approved' => $approved,
]]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Error: ' . $e->getMessage()]);
}


