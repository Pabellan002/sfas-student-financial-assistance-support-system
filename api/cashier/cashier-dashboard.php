<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Cashier performs the financial review and approval stage (role_id = 99).
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 99) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Cashier role required.']);
    exit;
}

/** @return array<string, string> */
function cashierDashboardParseFilters(array $get): array
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
 * Applies every dashboard filter to a loan and its linked student record.
 * Academic period filters come from the balance attached to the loan.
 *
 * @param array<string, string> $filters
 * @param array<int, mixed> $params - Numeric array for binding
 */
function cashierDashboardLoanWhere(array $filters, array &$params, string $loanAlias = 'l', string $studentAlias = 's'): string
{
    $parts = [];

    if ($filters['period'] !== '') {
        $parts[] = "{$loanAlias}.loan_app_period_id = ?";
        $params[] = $filters['period'];
    }
    if ($filters['schoolYear'] !== '') {
        $parts[] = "EXISTS (SELECT 1 FROM tbl_csdl_balances b_f WHERE b_f.balance_id = {$loanAlias}.loan_balance_id AND b_f.balance_sy_id = ?)";
        $params[] = $filters['schoolYear'];
    }
    if ($filters['semester'] !== '') {
        $parts[] = "EXISTS (SELECT 1 FROM tbl_csdl_balances b_f INNER JOIN tbl_csdl_school_years sy_f ON sy_f.sy_id = b_f.balance_sy_id WHERE b_f.balance_id = {$loanAlias}.loan_balance_id AND sy_f.sy_semester_id = ?)";
        $params[] = $filters['semester'];
    }
    if ($filters['department'] !== '') {
        $parts[] = "EXISTS (SELECT 1 FROM tbl_csdl_programs p_f WHERE p_f.program_id = {$studentAlias}.student_program_id AND p_f.program_department_id = ?)";
        $params[] = $filters['department'];
    }
    if ($filters['program'] !== '') {
        $parts[] = "{$studentAlias}.student_program_id = ?";
        $params[] = $filters['program'];
    }
    if ($filters['yearLevel'] !== '') {
        $parts[] = "{$studentAlias}.student_year_level_id = ?";
        $params[] = $filters['yearLevel'];
    }

    return $parts ? ' AND ' . implode(' AND ', $parts) : '';
}

try {
    $view = $_GET['view'] ?? '';
    $detail = $_GET['detail'] ?? '';
    $action = $_GET['action'] ?? '';
    $filters = cashierDashboardParseFilters($_GET);
    $loanParams = [];
    $loanWhere = cashierDashboardLoanWhere($filters, $loanParams);
    // A Cashier only sees payment-tagging work from their own campus.
    $campusStmt = $pdo->prepare('SELECT employee_campus_id FROM tbl_csdl_employees WHERE employee_id = ? AND employee_role_id = 99 AND employee_status = 1');
    $campusStmt->execute([(int) $_SESSION['user_id']]);
    $cashierCampusId = (int) ($campusStmt->fetchColumn() ?: 0);
    $loanWhere .= $cashierCampusId > 0
        ? ' AND s.student_campus_id = ' . $cashierCampusId
        : ' AND 1 = 0';

    // Cashier handles payment confirmation for every approved or partial-payment
    // loan in their campus. Paid records remain visible after Assessment PN tagging.
    $cashierApprovalExists = "EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals ca WHERE ca.approval_loan_id = l.loan_id AND ca.approval_step_id = 2 AND ca.approval_role_id = 99 AND ca.approval_status_id = 2)";
    $cashierDashboardScope = "(l.loan_status_id IN (2, 11) OR {$cashierApprovalExists})";

    if ($action === 'filters') {
        $periods = $pdo->query('SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_name')->fetchAll(PDO::FETCH_ASSOC);
        $semesters = $pdo->query('SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_name')->fetchAll(PDO::FETCH_ASSOC);
        $schoolYears = $pdo->query('SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1 ORDER BY sy_id DESC')->fetchAll(PDO::FETCH_ASSOC);
        $departments = $pdo->query('SELECT department_id, department_name FROM tbl_csdl_departments ORDER BY department_name')->fetchAll(PDO::FETCH_ASSOC);
        $programs = $pdo->query('SELECT program_id, program_name, program_department_id FROM tbl_csdl_programs ORDER BY program_name')->fetchAll(PDO::FETCH_ASSOC);
        $yearLevels = $pdo->query('SELECT year_level_id, year_level_name FROM tbl_csdl_year_levels ORDER BY year_level_id')->fetchAll(PDO::FETCH_ASSOC);

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
    
    if ($detail) {
        try {
            if ($detail === 'pendingPaymentTaggingList') {
                // NEW WORKFLOW: Loans awaiting payment confirmation at Cashier step
                // Step 2 (Cashier), Status 2 (Approved), with payment still awaiting completion.
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                           s.student_school_id AS schoolId,
                                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                           l.loan_amount_can_pay AS amount,
                                           COALESCE(ps.payment_status_name, 'Not Paid') AS paymentStatus,
                                           COALESCE(pns.pn_status_name, 'Not Tagged') AS pnStatus,
                                           l.loan_due_date AS dueDate
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                                    LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                                    WHERE l.loan_current_step_id = 2
                                      AND l.loan_status_id = 2
                                      AND l.loan_payment_status_id IN (1, 2, 4, 5){$loanWhere}
                                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                    LIMIT 100");
                $stmt->execute($loanParams);
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'totalList') {
                // NEW WORKFLOW: All loans that have been or are currently at Cashier step (step 2)
                // This includes: pending payment (step 2), marked as paid (moved to step 3), or completed
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                           s.student_school_id AS schoolId,
                                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                           l.loan_amount_can_pay AS amount,
                                           ls.loan_status_name AS status,
                                           COALESCE(ps.payment_status_name, 'Not Paid') AS paymentStatus,
                                           l.loan_application_date AS dateApplied
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                                    WHERE (l.loan_current_step_id = 2 OR l.loan_payment_status_id IN (2, 3, 4, 5))
                                      AND s.student_campus_id = ?{$loanWhere}
                                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                    LIMIT 100");
                $params = array_merge([$cashierCampusId], $loanParams);
                $stmt->execute($params);
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'approvedList') {
                // Final Cashier approvals remain visible after routing to Assessment.
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                           s.student_school_id AS schoolId,
                                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                           l.loan_amount_can_pay AS amount,
                                           ls.loan_status_name AS status,
                                           l.loan_application_date AS dateApplied
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                    WHERE {$cashierApprovalExists}{$loanWhere}
                                    ORDER BY l.loan_approval_date DESC, l.loan_id DESC
                                    LIMIT 100");
                $stmt->execute($loanParams);
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'returnedList') {
                // Applications returned by Cashier during financial review.
                $stmt = $pdo->query("SELECT l.loan_application_no AS applicationNo,
                                           s.student_school_id AS schoolId,
                                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                           l.loan_amount_can_pay AS amount,
                                           ls.loan_status_name AS status,
                                           l.loan_application_date AS dateApplied
                                    FROM tbl_csdl_loan_approvals a
                                    JOIN tbl_csdl_loans l ON l.loan_id = a.approval_loan_id
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                    WHERE a.approval_step_id = 2 AND a.approval_status_id = 5
                                    ORDER BY a.approval_processed_at DESC, a.approval_loan_id DESC
                                    LIMIT 100");
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'declinedList') {
                // Declined loans (status_id = 3)
                $stmt = $pdo->query("SELECT l.loan_application_no AS applicationNo,
                                           s.student_school_id AS schoolId,
                                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                           l.loan_amount_can_pay AS amount,
                                           ls.loan_status_name AS status,
                                           l.loan_application_date AS dateApplied
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                    WHERE l.loan_current_step_id = 2 AND l.loan_status_id = 3
                                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                    LIMIT 100");
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'exportList') {
                // Export all loans matching the current filters (no limit for export)
                $stmt = $pdo->prepare("SELECT l.loan_application_no AS applicationNo,
                                           s.student_school_id AS schoolId,
                                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                                           l.loan_amount_can_pay AS amount,
                                           ls.loan_status_name AS statusName,
                                           COALESCE(ps.payment_status_name, 'Not Paid') AS paymentStatus,
                                           l.loan_application_date AS dateApplied
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                                    WHERE (l.loan_current_step_id = 2 OR l.loan_payment_status_id IN (2, 3, 4, 5))
                                      AND s.student_campus_id = ?{$loanWhere}
                                    ORDER BY l.loan_application_date DESC, l.loan_id DESC");
                $params = array_merge([$cashierCampusId], $loanParams);
                $stmt->execute($params);
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

            if (in_array($view, ['appsDaily','appsWeekly','appsMonthly','appsYearly'], true)) {
                // Applications grouped by date buckets
                if ($view === 'appsDaily') {
                    $stmt = $pdo->query("SELECT HOUR(l.loan_application_date) AS h, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       WHERE l.loan_current_step_id = 2
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
                                       WHERE l.loan_current_step_id = 2
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
                                       WHERE l.loan_current_step_id = 2
                                       AND l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
                                       GROUP BY YEAR(l.loan_application_date), MONTH(l.loan_application_date)
                                       ORDER BY ym ASC");
                    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                        $labels[] = date('M Y', strtotime($r['ym'] . '-01'));
                        $values[] = (int) $r['c'];
                    }
                } else { // appsYearly
                    $stmt = $pdo->query("SELECT YEAR(l.loan_application_date) AS y, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       WHERE l.loan_current_step_id = 2
                                       AND l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 4 YEAR)
                                       GROUP BY YEAR(l.loan_application_date)
                                       ORDER BY y ASC");
                    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                        $labels[] = (string) $r['y'];
                        $values[] = (int) $r['c'];
                    }
                }
            } elseif ($view === 'statusBreakdown') {
                // Show the Cashier workload by payment status
                $q = $pdo->prepare("SELECT COALESCE(ps.payment_status_name, 'Not Paid') AS label,
                                           COUNT(DISTINCT l.loan_id) AS value
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                                    WHERE (l.loan_current_step_id = 2 OR l.loan_payment_status_id IN (2, 3, 4, 5))
                                      AND s.student_campus_id = ?{$loanWhere}
                                    GROUP BY l.loan_payment_status_id, ps.payment_status_name
                                    ORDER BY value DESC");
                $chartParams = array_merge([$cashierCampusId], $loanParams);
                $q->execute($chartParams);
                foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) { 
                    $labels[] = $r['label']; 
                    $values[] = (int)$r['value']; 
                }
            }

            echo json_encode(['success' => true, 'labels' => $labels, 'values' => $values]);
            return;
        } catch (Throwable $e) {
            echo json_encode(['success' => true, 'labels' => [], 'values' => []]);
            return;
        }
    }

    // Summary counts for the Cashier dashboard.
    // Pending payment tagging includes Not Paid, required Partial Payment,
    // Paid Pending, and Cashier-recorded Paid Partial loans.
    $pendingStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l 
                                   JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id 
                                   WHERE l.loan_current_step_id = 2 
                                   AND l.loan_status_id = 2 
                                   AND l.loan_payment_status_id IN (1, 2, 4, 5){$loanWhere}");
    $pendingStmt->execute($loanParams);
    $pending = (int) $pendingStmt->fetchColumn();
    
    // NEW WORKFLOW: Total = all loans at or past Cashier step (current step 2, or payment status Partial/Paid)
    $totalStmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_id) 
                                FROM tbl_csdl_loans l 
                                JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id 
                                WHERE (l.loan_current_step_id = 2 OR l.loan_payment_status_id IN (2, 3, 4, 5))
                                AND s.student_campus_id = ?{$loanWhere}");
    $totalParams = array_merge([$cashierCampusId], $loanParams);
    $totalStmt->execute($totalParams);
    $total = (int) $totalStmt->fetchColumn();
    
    // Approved: final decisions recorded at the Cashier step.
    $approvedStmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$cashierApprovalExists}{$loanWhere}");
    $approvedStmt->execute($loanParams);
    $approved = (int) $approvedStmt->fetchColumn();
    echo json_encode(['success' => true, 'summary' => [
        'pendingPaymentTagging' => $pending,
        'total' => $total,
        'approved' => $approved
    ]]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load dashboard']);
}
?>
