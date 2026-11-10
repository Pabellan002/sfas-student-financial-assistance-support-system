<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-send-push-notification.php';
require_once __DIR__ . '/../includes/includes-loan-promised-amount.php';
require_once __DIR__ . '/../includes/includes-assessment-pn-tagging.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$userRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
if ($userRoleId !== 101) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Assessment role required.']);
    exit;
}

RBAC::init($pdo);
$employeeId = (int) ($_SESSION['user_id'] ?? 0);
queueOverdueLoanNotifications($pdo);

function resolveNextLoanAssignment(PDO $pdo, array $loanRow, string $pnStatus, float $partialPaymentAmount = 0.0, float $totalPaymentApplied = 0.0): array {
    $currentBalance = (float) ($loanRow['balance_current_balance'] ?? 0);
    $loanAmountCanPay = (float) ($loanRow['loan_amount_can_pay'] ?? 0);
    $campusId = (int) ($loanRow['student_campus_id'] ?? 0);
    $campusCode = strtolower(trim((string) ($loanRow['campus_code'] ?? '')));
    $isBranchCampus = str_contains($campusCode, 'iligan')
        || str_contains($campusCode, 'puerto')
        || str_contains($campusCode, 'butuan');

    if ($pnStatus === 'Partial Payment') {
        $paymentAmount = max(0, $partialPaymentAmount);
    } elseif ($pnStatus === 'Paid') {
        $paymentAmount = $totalPaymentApplied > 0 ? $totalPaymentApplied : max(0, $loanAmountCanPay);
    } else {
        $paymentAmount = max(0, $loanAmountCanPay);
    }

    $balanceAfterPayment = max(0, $currentBalance - $paymentAmount);
    $routingAmount = $balanceAfterPayment;

    if ($routingAmount <= 3000) {
        if ($isBranchCampus) {
            return ['stepId' => 3, 'roleId' => 98, 'campusId' => $campusId, 'paymentAmount' => $paymentAmount, 'balanceAfterPayment' => $balanceAfterPayment];
        }
        return ['stepId' => 1, 'roleId' => 100, 'campusId' => $campusId, 'paymentAmount' => $paymentAmount, 'balanceAfterPayment' => $balanceAfterPayment];
    }

    if ($routingAmount <= 7000) {
        return ['stepId' => 2, 'roleId' => 99, 'campusId' => $campusId, 'paymentAmount' => $paymentAmount, 'balanceAfterPayment' => $balanceAfterPayment];
    }

    return ['stepId' => 4, 'roleId' => 97, 'campusId' => $campusId, 'paymentAmount' => $paymentAmount, 'balanceAfterPayment' => $balanceAfterPayment];
}

function resolveAssignedEmployee(PDO $pdo, int $roleId, int $campusId = 0): ?int {
    if ($campusId > 0) {
        $stmt = $pdo->prepare("SELECT employee_id
                               FROM tbl_csdl_employees
                               WHERE employee_role_id = ?
                                 AND employee_status = 1
                                 AND employee_campus_id = ?
                               ORDER BY employee_id ASC
                               LIMIT 1");
        $stmt->execute([$roleId, $campusId]);
        $id = (int) ($stmt->fetchColumn() ?: 0);
        if ($id > 0) return $id;
    }
    $stmt = $pdo->prepare("SELECT employee_id
                           FROM tbl_csdl_employees
                           WHERE employee_role_id = ?
                             AND employee_status = 1
                           ORDER BY employee_id ASC
                           LIMIT 1");
    $stmt->execute([$roleId]);
    $id = (int) ($stmt->fetchColumn() ?: 0);
    return $id > 0 ? $id : null;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';
    if ($action === 'details') {
        RBAC::requireAnyPermission(
            $employeeId,
            ['assessment.loans.view', 'assessment.pntagging.view'],
            'You do not have permission to view loan details'
        );
        if (!RBAC::hasPermission($employeeId, 'assessment.loans.view')
            && !canReadAssessmentPnTagging($pdo, (int) ($_GET['loanId'] ?? 0))) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'This loan is not in the Assessment PN tagging queue.']);
            exit;
        }
    } else {
        RBAC::requirePermission($employeeId, 'assessment.loans.view', 'You do not have permission to view loans');
    }
    
    if ($action === 'export') {
        try {
            $format = $_GET['format'] ?? 'csv';
            $statusFilter = $_GET['status'] ?? '';
            $periodFilter = $_GET['period'] ?? '';
            $semesterFilter = $_GET['semester'] ?? '';
            $schoolYearFilter = $_GET['schoolYear'] ?? '';
            $campusFilter = (int) ($_GET['campus'] ?? 0);
            $search = trim($_GET['search'] ?? '');
            
            $where = ['l.loan_status_id = 1', 'l.loan_current_step_id = 11'];
            $params = [];
            
            if ($statusFilter === '1') {
                $where = ['l.loan_status_id = ?', 'l.loan_current_step_id = 11'];
                $params = [$statusFilter];
            }

            if ($campusFilter > 0) {
                $where[] = 's.student_campus_id = ?';
                $params[] = $campusFilter;
            }
            
            if ($semesterFilter !== '') {
                $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = ?)';
                $params[] = $semesterFilter;
            }
            
            if ($schoolYearFilter !== '') {
                $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = ?)';
                $params[] = $schoolYearFilter;
            }
            
            if ($periodFilter !== '') {
                $where[] = 'l.loan_app_period_id = ?';
                $params[] = $periodFilter;
            }
            
            if ($search !== '') {
                $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_last_name, ", ", s.student_first_name) LIKE ?)';
                $searchParam = "%{$search}%";
                $params[] = $searchParam;
                $params[] = $searchParam;
                $params[] = $searchParam;
            }
            
            $whereClause = implode(' AND ', $where);
            
            $exportSql = "SELECT l.loan_application_no AS 'Application No.',
                                 s.student_school_id AS 'Student ID',
                                 CONCAT(s.student_last_name, ', ', s.student_first_name) AS 'Student Name',
                                 FORMAT(l.loan_amount_can_pay, 2) AS 'Amount',
                                 ls.loan_status_name AS 'Status',
                                 ws.step_name AS 'Current Step',
                                 ap.app_period_name AS 'Period',
                                 DATE_FORMAT(l.loan_application_date, '%Y-%m-%d') AS 'Date Applied',
                                 DATE_FORMAT(l.loan_due_date, '%Y-%m-%d') AS 'Due Date'
                          FROM tbl_csdl_loans l
                          JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                          LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                          LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                          LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                          WHERE {$whereClause}
                          ORDER BY l.loan_application_date DESC, l.loan_id DESC";
            
            $exportStmt = $pdo->prepare($exportSql);
            $exportStmt->execute($params);
            $data = $exportStmt->fetchAll(PDO::FETCH_ASSOC);
            
            $filename = 'assessment_untagged_loans_' . date('Y-m-d_His');
            
            if ($format === 'csv') {
                header('Content-Type: text/csv; charset=utf-8');
                header('Content-Disposition: attachment; filename="' . $filename . '.csv"');
                header('Pragma: no-cache');
                header('Expires: 0');
                
                $output = fopen('php://output', 'w');
                fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
                
                if (!empty($data)) {
                    fputcsv($output, array_keys($data[0]));
                    foreach ($data as $row) {
                        fputcsv($output, $row);
                    }
                } else {
                    fputcsv($output, ['Application No.', 'Student ID', 'Student Name', 'Amount', 'Status', 'Current Step', 'Period', 'Date Applied', 'Due Date']);
                }
                
                fclose($output);
            } elseif ($format === 'pdf') {
                // PDF Export
                header('Content-Type: application/pdf');
                header('Content-Disposition: attachment; filename="' . $filename . '.pdf"');
                
                // Simple PDF generation using HTML
                $html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
                    body { font-family: Arial, sans-serif; font-size: 10px; }
                    h1 { text-align: center; color: #03600f; font-size: 16px; margin-bottom: 20px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
                    th { background-color: #03600f; color: white; font-weight: bold; }
                    tr:nth-child(even) { background-color: #f9f9f9; }
                </style></head><body>';
                $html .= '<h1>Assessment - Untagged Loans Report</h1>';
                $html .= '<p style="text-align:center; margin-bottom:15px;">Generated on ' . date('F d, Y h:i A') . '</p>';
                $html .= '<table><thead><tr>';
                
                if (!empty($data)) {
                    foreach (array_keys($data[0]) as $header) {
                        $html .= '<th>' . htmlspecialchars($header) . '</th>';
                    }
                    $html .= '</tr></thead><tbody>';
                    
                    foreach ($data as $row) {
                        $html .= '<tr>';
                        foreach ($row as $cell) {
                            $html .= '<td>' . htmlspecialchars($cell ?? '') . '</td>';
                        }
                        $html .= '</tr>';
                    }
                } else {
                    $html .= '<th>Application No.</th><th>Student ID</th><th>Student Name</th><th>Amount</th><th>Status</th><th>Current Step</th><th>Period</th><th>Date Applied</th><th>Due Date</th></tr></thead><tbody>';
                    $html .= '<tr><td colspan="9" style="text-align:center;">No data available</td></tr>';
                }
                
                $html .= '</tbody></table></body></html>';
                
                // Use DomPDF or similar if available, otherwise output HTML
                echo $html;
            } elseif ($format === 'word') {
                // Word Export (HTML format that Word can open)
                header('Content-Type: application/vnd.ms-word');
                header('Content-Disposition: attachment; filename="' . $filename . '.doc"');
                
                $html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">';
                $html .= '<head><meta charset="UTF-8"><style>
                    body { font-family: Arial, sans-serif; }
                    h1 { text-align: center; color: #03600f; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { border: 1px solid #000; padding: 8px; }
                    th { background-color: #03600f; color: white; font-weight: bold; }
                </style></head><body>';
                $html .= '<h1>Assessment - Untagged Loans Report</h1>';
                $html .= '<p style="text-align:center;">Generated on ' . date('F d, Y h:i A') . '</p>';
                $html .= '<table><thead><tr>';
                
                if (!empty($data)) {
                    foreach (array_keys($data[0]) as $header) {
                        $html .= '<th>' . htmlspecialchars($header) . '</th>';
                    }
                    $html .= '</tr></thead><tbody>';
                    
                    foreach ($data as $row) {
                        $html .= '<tr>';
                        foreach ($row as $cell) {
                            $html .= '<td>' . htmlspecialchars($cell ?? '') . '</td>';
                        }
                        $html .= '</tr>';
                    }
                } else {
                    $html .= '<th>Application No.</th><th>Student ID</th><th>Student Name</th><th>Amount</th><th>Status</th><th>Current Step</th><th>Period</th><th>Date Applied</th><th>Due Date</th></tr></thead><tbody>';
                    $html .= '<tr><td colspan="9" style="text-align:center;">No data available</td></tr>';
                }
                
                $html .= '</tbody></table></body></html>';
                echo $html;
            }
            
            exit;
        } catch (Throwable $e) {
            http_response_code(500);
            header('Content-Type: application/json');
            error_log('Assessment export error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error exporting loans']);
            exit;
        }
    }
    
    if ($action === 'stats') {
        // Prevent caching
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('Pragma: no-cache');
        header('Expires: 0');
        
        try {
            $campusFilter = (int) ($_GET['campus'] ?? 0);
            $campusWhere = $campusFilter > 0 ? ' AND s.student_campus_id = ?' : '';
            $statsParams = $campusFilter > 0 ? [$campusFilter] : [];
            $allStmt = $pdo->prepare("SELECT COUNT(*) 
                FROM tbl_csdl_loans l 
                INNER JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                WHERE l.loan_status_id = 1
                AND l.loan_current_step_id = 11
                {$campusWhere}");
            $allStmt->execute($statsParams);
            $allApplications = $allStmt->fetchColumn();

            $overdueStmt = $pdo->prepare("SELECT COUNT(*)
                FROM tbl_csdl_loans l 
                INNER JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                WHERE l.loan_status_id = 1
                AND l.loan_current_step_id = 11
                AND l.loan_due_date IS NOT NULL
                AND l.loan_due_date < CURDATE()
                {$campusWhere}");
            $overdueStmt->execute($statsParams);
            $overdueApplications = $overdueStmt->fetchColumn();
            
            echo json_encode([
                'success' => true,
                'stats' => [
                    'allApplications' => (int)$allApplications,
                    'overdueApplications' => (int)$overdueApplications
                ]
            ]);
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Error fetching stats']);
        }
        return;
    }
    
    if ($action === 'filters') {
        try {
            $statusStmt = $pdo->query("SELECT loan_status_id, loan_status_name FROM tbl_csdl_loan_statuses ORDER BY loan_status_id");
            $statuses = $statusStmt->fetchAll(PDO::FETCH_ASSOC);
            
            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods WHERE app_period_status = 1 ORDER BY app_period_id");
            $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC);
            
            $semesterStmt = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id");
            $semesters = $semesterStmt->fetchAll(PDO::FETCH_ASSOC);
            
            $schoolYearStmt = $pdo->query("SELECT sy.sy_id, CONCAT(sy.sy_code, ' - ', sem.semester_name) as sy_display FROM tbl_csdl_school_years sy LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id ORDER BY sy.sy_id DESC");
            $schoolYears = $schoolYearStmt->fetchAll(PDO::FETCH_ASSOC);

            $campusStmt = $pdo->query("SELECT campus_id, campus_code, campus_name FROM tbl_csdl_campuses WHERE campus_status = 1 ORDER BY campus_name");
            $campuses = $campusStmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'statuses' => $statuses,
                'periods' => $periods,
                'semesters' => $semesters,
                'schoolYears' => $schoolYears,
                'campuses' => $campuses
            ]);
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Error fetching filters']);
        }
        return;
    }
    
    if ($action === 'details') {
        // Prevent caching
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('Pragma: no-cache');
        header('Expires: 0');
        
        $loanId = intval($_GET['loanId'] ?? 0);
        if ($loanId <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid loan ID']);
            return;
        }
        
        try {
            $sql = "SELECT l.*,
                           s.student_school_id,
                           CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
                           s.student_email,
                           s.student_personal_email,
                           s.student_contact_number,
                           p.program_name,
                           yl.year_level_name,
                           ls.loan_status_name,
                           ws.step_name as current_step_name,
                           ap.app_period_name,
                           g.guardian_name,
                           rel.relationship_name as guardian_relationship,
                           g.guardian_contact,
                           b.balance_total_balance,
                           b.balance_current_balance,
                           b.balance_advice_to_pay,
                           c.campus_name,
                           sch.scholarship_name,
                           COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                           COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status,
                           (SELECT la.approval_pn_tagging
                              FROM tbl_csdl_loan_approvals la
                             WHERE la.approval_loan_id = l.loan_id
                               AND la.approval_pn_tagging IS NOT NULL
                             ORDER BY la.approval_pn_date_processed DESC
                             LIMIT 1) AS pnStatus
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                    LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                    LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                    LEFT JOIN tbl_csdl_guardians g ON g.guardian_id = l.loan_guardian_id
                    LEFT JOIN tbl_csdl_relationships rel ON rel.relationship_id = g.guardian_relationship_id
                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                    LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                    LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                    LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                    WHERE l.loan_id = ?";
            
            $stmt = $pdo->prepare($sql);
            $stmt->execute([$loanId]);
            $loan = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Loan not found']);
                return;
            }

            $displayAmounts = getLoanPromisedDisplayAmount(
                $pdo,
                $loanId,
                (float) ($loan['loan_amount_can_pay'] ?? 0)
            );
            $loan['loan_amount_remaining'] = $displayAmounts['remainingAmount'];
            $loan['loan_partial_payment_total'] = $displayAmounts['partialPaymentTotal'];
            $loan['loan_promised_amount'] = $displayAmounts['promisedAmount'];
            
            $docStmt = $pdo->prepare("SELECT ld.*, dt.doc_type_name FROM tbl_csdl_loan_documents ld LEFT JOIN tbl_csdl_document_types dt ON dt.doc_type_id = ld.loan_document_doc_type_id WHERE ld.loan_document_loan_id = ?");
            $docStmt->execute([$loanId]);
            $loan['documents'] = $docStmt->fetchAll(PDO::FETCH_ASSOC);
            
            $trackStmt = $pdo->prepare("SELECT lt.*, ws.step_name,
                                               CONCAT_WS(' ', tracking_employee.employee_first_name, tracking_employee.employee_last_name) AS tracking_employee_name,
                                               tracking_employee.employee_id AS matched_employee_id
                                        FROM tbl_csdl_loan_tracking lt
                                        LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = lt.loan_tracking_step_id
                                        LEFT JOIN tbl_csdl_employees tracking_employee
                                          ON lt.loan_tracking_remarks LIKE CONCAT('%employee #', tracking_employee.employee_id, '%')
                                        WHERE lt.loan_tracking_loan_id = ?
                                        ORDER BY lt.loan_tracking_created_at DESC");
            $trackStmt->execute([$loanId]);
            $tracking = $trackStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Replace employee ID with employee name in remarks and map to statusHistory format
            $statusHistory = [];
            foreach ($tracking as $track) {
                $remarks = $track['loan_tracking_remarks'] ?? '';
                if (!empty($track['tracking_employee_name']) && !empty($remarks)) {
                    $remarks = preg_replace(
                        '/employee #\d+/',
                        'employee ' . $track['tracking_employee_name'],
                        $remarks
                    );
                }
                
                $statusHistory[] = [
                    'status_name' => $track['loan_tracking_action'] ?? '-',
                    'created_at' => $track['loan_tracking_created_at'] ?? '',
                    'remarks' => $remarks,
                    'updated_by_name' => $track['tracking_employee_name'] ?? null,
                    // Keep original fields for backward compatibility
                    'loan_tracking_action' => $track['loan_tracking_action'] ?? null,
                    'loan_tracking_remarks' => $remarks,
                    'loan_tracking_created_at' => $track['loan_tracking_created_at'] ?? null,
                    'step_name' => $track['step_name'] ?? null,
                ];
            }
            
            $loan['tracking'] = $tracking;
            $loan['statusHistory'] = $statusHistory;
            
            echo json_encode(['success' => true, 'loan' => $loan], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching loan details']);
        }
        return;
    }
    
    if ($action === 'list') {
        try {
            $page = max(1, intval($_GET['page'] ?? 1));
            $perPage = max(10, min(100, intval($_GET['perPage'] ?? 25)));
            $offset = ($page - 1) * $perPage;
            
            $statusFilter = $_GET['status'] ?? '';
            $periodFilter = $_GET['period'] ?? '';
            $semesterFilter = $_GET['semester'] ?? '';
            $schoolYearFilter = $_GET['schoolYear'] ?? '';
            $campusFilter = (int) ($_GET['campus'] ?? 0);
            $search = trim($_GET['search'] ?? '');
            $overdue = isset($_GET['overdue']) && $_GET['overdue'] === '1';
            
            $where = [];
            $params = [];

            // Active Loans contains only newly endorsed applications awaiting
            // Assessment review. Cashier-paid loans belong to PN Tagging.
            $where[] = 'l.loan_status_id = 1';
            $where[] = 'l.loan_current_step_id = 11';
            if ($overdue) {
                $where[] = 'l.loan_due_date IS NOT NULL AND l.loan_due_date < CURDATE()';
            }

            if ($campusFilter > 0) {
                $where[] = 's.student_campus_id = ?';
                $params[] = $campusFilter;
            }
            
            if ($semesterFilter !== '') {
                $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = ?)';
                $params[] = $semesterFilter;
            }
            
            if ($schoolYearFilter !== '') {
                $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = ?)';
                $params[] = $schoolYearFilter;
            }
            
            if ($periodFilter !== '') {
                $where[] = 'l.loan_app_period_id = ?';
                $params[] = $periodFilter;
            }
            
            if ($search !== '') {
                $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_last_name, ", ", s.student_first_name) LIKE ?)';
                $searchParam = "%{$search}%";
                $params[] = $searchParam;
                $params[] = $searchParam;
                $params[] = $searchParam;
            }
            
            $whereClause = implode(' AND ', $where);
            
            $countSql = "SELECT COUNT(*) as total FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$whereClause}";
            $countStmt = $pdo->prepare($countSql);
            $countStmt->execute($params);
            $total = $countStmt->fetch(PDO::FETCH_ASSOC)['total'];
            
            $sql = "SELECT l.loan_id, l.loan_application_no AS applicationNo, s.student_school_id AS schoolId,
                           CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                           l.loan_amount_can_pay AS amountCanPay,
                           l.loan_amount_can_pay AS remainingAmount,
                           b.balance_total_balance,
                           b.balance_advice_to_pay,
                           COALESCE(b.balance_current_balance, 0) AS balance,
                           l.loan_status_id AS statusId, ls.loan_status_name AS statusName,
                           l.loan_current_step_id AS stepId, ws.step_name AS stepName,
                           l.loan_application_date AS dateApplied, l.loan_due_date AS dueDate,
                           COALESCE(l.loan_updated_at, l.loan_application_date) AS dateUpdated,
                           l.loan_expiry_timestamp AS expiryTimestamp,
                           c.campus_code AS campusCode,
                           l.loan_payment_status_id AS loan_payment_status_id,
                           COALESCE(ps.payment_status_name, 'Not Paid') AS paymentStatus,
                           COALESCE(pns.pn_status_name, 'Not Tagged') AS pnStatus
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                    LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                    WHERE {$whereClause}
                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                    LIMIT ? OFFSET ?";
            
            $params[] = $perPage;
            $params[] = $offset;
            
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($rows as &$row) {
                $loanId = (int) ($row['loan_id'] ?? 0);
                $amounts = getLoanPromisedDisplayAmount($pdo, $loanId, (float) ($row['remainingAmount'] ?? 0));
                $row['amount'] = $amounts['promisedAmount'];
                $row['remainingAmount'] = $amounts['remainingAmount'];
                $row['partialPaymentTotal'] = $amounts['partialPaymentTotal'];
            }
            unset($row);
            
            echo json_encode([
                'success' => true,
                'data' => $rows,
                'total' => $total,
                'page' => $page,
                'perPage' => $perPage,
                'totalPages' => ceil($total / $perPage)
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching loans']);
        }
        return;
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    CSRFProtection::validateRequest();
    $action = $_POST['action'] ?? '';

    if ($action === 'process') {
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $processType = trim((string) ($_POST['processType'] ?? ''));
        $remarks = trim((string) ($_POST['remarks'] ?? ''));
        $amountApproved = (float) ($_POST['amountApproved'] ?? 0);
        $partialAmount = (float) ($_POST['partialPaymentAmount'] ?? 0);
        
        if ($loanId <= 0 || !in_array($processType, ['approve', 'partial', 'endorse_branch', 'endorse_coo'], true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid loan action.']);
            exit;
        }

        $permissionByAction = [
            'approve' => 'assessment.loans.approve',
            'partial' => 'assessment.loans.partial_payment',
            'endorse_branch' => 'assessment.loans.endorse',
            'endorse_coo' => 'assessment.loans.endorse',
        ];
        RBAC::requirePermission($employeeId, $permissionByAction[$processType], 'You do not have permission to perform this loan action');

        try {
            $pdo->beginTransaction();
            
            // Get loan details with campus information
            $loanStmt = $pdo->prepare("SELECT l.*, s.student_campus_id, s.student_email, s.student_personal_email, s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                                               c.campus_code, b.balance_current_balance, b.balance_total_balance
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                                       LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                       WHERE l.loan_id = ? FOR UPDATE");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                throw new RuntimeException('Loan not found.');
            }
            
            // NEW WORKFLOW: Assessment handles loans that come from student application
            // For initial review: step_id=11, status=1 (Pending)
            // For PN tagging: step_id=11, status=2 (Approved), payment_status=3 (Paid)
            if ((int) $loan['loan_current_step_id'] !== 11 || (int) $loan['loan_status_id'] !== 1) {
                throw new RuntimeException('This loan is not waiting for Assessment initial review.');
            }
            
            $campus = strtolower(trim((string) ($loan['campus_code'] ?? '')));
            $isBranchCampus = str_contains($campus, 'puerto') || str_contains($campus, 'iligan') || str_contains($campus, 'butuan');
            $loanAmount = (float) ($loan['loan_amount_can_pay'] ?? 0);
            // Routing is based on the balance remaining after the student's declared payment.
            $remainingBalance = max(0, (float) ($loan['balance_total_balance'] ?? 0) - $loanAmount);
            
            $nextStepId = 0;
            $nextRoleId = 0;
            $loanStatusId = 1;
            $approvalStatusId = 2;
            $approvalAmount = null;
            $trackingAction = '';
            $trackingRemarks = $remarks;
            $studentTitle = '';
            $studentMessage = '';
            $emailType = 'approve';
            $emailDestination = null;
            $newAmountCanPay = null;
            
            // Process approval amount and handle endorsements with extended amounts
            if (in_array($processType, ['approve', 'endorse_branch', 'endorse_coo'], true)) {
                // NEW WORKFLOW: Assessment approval/endorsement rules
                if ($processType === 'approve') {
                    $approvalAmount = resolveLoanApprovedAmount($pdo, $loanId, $amountApproved, $loanAmount);
                    if ($approvalAmount <= 0) {
                        throw new InvalidArgumentException('Enter an approved amount greater than zero.');
                    }
                    
                    // Assessment can approve only a remaining balance above ₱3,000
                    // and up to ₱7,500. The remaining balance is total less
                    // the student's declared amount to pay.
                    if ($remainingBalance <= 3000) {
                        throw new InvalidArgumentException('Loans with a remaining balance of ₱3,000 or below must be handled by CSDL.');
                    }
                    if ($remainingBalance > 7500 && $remainingBalance < 10000) {
                        throw new InvalidArgumentException('Loans with a remaining balance above ₱7,500 and below ₱10,000 must be endorsed to Branch Admin.');
                    }
                    if ($remainingBalance >= 10000) {
                        throw new InvalidArgumentException('Loans with a remaining balance of ₱10,000 or more must be endorsed to COO.');
                    }
                    // Assessment can approve loans within their authority (varies by campus)
                    // Carmen: Can approve without specific upper limit mentioned
                    // Puerto/Iligan/Butuan: Can approve up to ₱7,500
                    // Above limits → must endorse to Branch Admin or COO
                    
                    $totalBalance = $remainingBalance;
                    
                    // Get campus-specific limits
                    if ($isBranchCampus) {
                        // Branch campuses: Assessment can approve up to ₱7,500
                        if ($totalBalance > 7500 && $totalBalance < 10000) {
                            throw new InvalidArgumentException('For branch campuses, loans with balance > ₱7,500 and < ₱10,000 must be endorsed to Branch Admin.');
                        } elseif ($totalBalance >= 10000) {
                            throw new InvalidArgumentException('Loans with balance ≥ ₱10,000 must be endorsed to COO.');
                        }
                    } else {
                        // Carmen Assessment approves up to PHP 10,000; higher balances go to COO.
                        if ($totalBalance > 10000) {
                            throw new InvalidArgumentException('Loans with a remaining balance above PHP 10,000 must be endorsed to COO.');
                        }
                    }
                    
                    // Approve and route to Cashier for payment confirmation
                    $nextStepId = 2; // Cashier step
                    $nextRoleId = 99; // Cashier role
                    $loanStatusId = 2; // Approved
                    $trackingAction = 'Loan Approved - Awaiting Payment Confirmation';
                    $trackingRemarks = 'Approved amount: ₱' . number_format($approvalAmount, 2) . '. Routed to Cashier for payment confirmation.' . ($remarks !== '' ? ' ' . $remarks : '');
                    $studentTitle = 'Loan Application Approved';
                    $studentMessage = "Congratulations! Your loan application {$loan['loan_application_no']} has been approved for ₱" . number_format($approvalAmount, 2) . ". Please proceed to the Cashier's office for payment processing.";
                    $emailType = 'approve';
                    
                } elseif ($processType === 'endorse_branch') {
                    // Endorse to Branch Admin (₱7,501-₱9,999, branch campuses only)
                    // Carmen campus should NEVER be endorsed to Branch Admin
                    $campusCode = strtolower(trim((string) ($loan['campus_code'] ?? '')));
                    if (str_contains($campusCode, 'carmen')) {
                        throw new InvalidArgumentException('Carmen campus loans cannot be endorsed to Branch Admin. Please endorse to COO instead.');
                    }
                    
                    $totalBalance = $remainingBalance;
                    
                    if ($totalBalance <= 7500) {
                        throw new InvalidArgumentException('Loans with balance ≤ ₱7,500 can be approved directly by Assessment.');
                    }
                    if ($totalBalance > 10000) {
                        throw new InvalidArgumentException('Loans with balance > ₱10,000 must be endorsed to COO, not Branch Admin.');
                    }
                    
                    // Validate extended amount
                    if ($amountApproved > 0 && $amountApproved > $loanAmount) {
                        // Assessment is extending the amount can pay
                        $approvalAmount = $amountApproved;
                    } else {
                        $approvalAmount = $loanAmount;
                    }
                    
                    $nextStepId = 3; // Branch Admin step
                    $nextRoleId = 98; // Branch Admin role
                    $loanStatusId = 12; // Endorsed
                    $trackingAction = 'Endorsed to Branch Admin';
                    $trackingRemarks = 'Total balance: ₱' . number_format($totalBalance, 2) . '. Amount can pay: ₱' . number_format($approvalAmount, 2) . '. Endorsed to Branch Admin for approval.' . ($remarks !== '' ? ' ' . $remarks : '');
                    $studentTitle = 'Loan Application Endorsed to Branch Admin';
                    $studentMessage = "Your loan application {$loan['loan_application_no']} has been endorsed to Branch Admin for review.";
                    $emailType = 'endorse';
                    $emailDestination = 'Branch Admin Office';
                    
                } elseif ($processType === 'endorse_coo') {
                    // Endorse to COO (≥ ₱10,000 for branch campuses, > ₱7,500 for Carmen)
                    $campusCode = strtolower(trim((string) ($loan['campus_code'] ?? '')));
                    $isCarmenCampus = str_contains($campusCode, 'carmen');
                    $totalBalance = $remainingBalance;
                    
                    if ($isCarmenCampus) {
                        // Carmen campus: Allow COO endorsement for balance > ₱7,500
                        if ($totalBalance <= 7500) {
                            throw new InvalidArgumentException('Carmen campus loans with balance ≤ ₱7,500 can be approved directly by Assessment.');
                        }
                    } else {
                        // Branch campuses: Only balance > ₱10,000 goes to COO
                        if ($totalBalance <= 10000) {
                            throw new InvalidArgumentException('For branch campuses, only loans with balance > ₱10,000 should be endorsed to COO.');
                        }
                    }
                    
                    // Validate extended amount
                    if ($amountApproved > 0 && $amountApproved > $loanAmount) {
                        // Assessment is extending the amount can pay
                        $approvalAmount = $amountApproved;
                    } else {
                        $approvalAmount = $loanAmount;
                    }
                    
                    $nextStepId = 4; // COO step
                    $nextRoleId = 97; // COO role
                    $loanStatusId = 12; // Endorsed
                    $trackingAction = 'Endorsed to COO';
                    $trackingRemarks = 'Total balance: ₱' . number_format($totalBalance, 2) . '. Amount can pay: ₱' . number_format($approvalAmount, 2) . '. Endorsed to COO for final approval.' . ($remarks !== '' ? ' ' . $remarks : '');
                    $studentTitle = 'Loan Application Endorsed to COO';
                    $studentMessage = "Your loan application {$loan['loan_application_no']} has been endorsed to COO for review.";
                    $emailType = 'endorse';
                    $emailDestination = 'COO Office';
                }
                
            } elseif ($processType === 'partial') {
                if ($remainingBalance <= 3000 || $remainingBalance > 7500) {
                    throw new InvalidArgumentException('Partial payment is available only for loans within the Assessment approval range (above ₱3,000 and up to ₱7,500).');
                }
                if ($partialAmount <= 0) {
                    throw new InvalidArgumentException('Enter a partial-payment amount greater than zero.');
                }
                // Use the remaining balance used by the workflow threshold, rather than
                // the balance record's current balance, to cap a required partial payment.
                $remainingBalance = max(0, (float) ($loan['balance_total_balance'] ?? 0)
                    - (float) ($loan['loan_amount_can_pay'] ?? 0));
                if ($partialAmount > $remainingBalance) {
                    throw new InvalidArgumentException(
                        'The partial payment cannot be greater than the remaining balance (₱'
                        . number_format($remainingBalance, 2) . ').'
                    );
                }
                $newAmountCanPay = round($loanAmount + $partialAmount, 2);
                
                // NEW WORKFLOW: Partial payment is conditional approval
                // After student pays, Cashier confirms, then goes to Assessment PN
                $nextStepId = 2; // Cashier step (student will pay there)
                $nextRoleId = 99; // Cashier role
                $loanStatusId = 2; // Approved (conditionally)
                $approvalAmount = $partialAmount;
                $trackingAction = 'Partial Payment';
                $trackingRemarks = 'Previous amount can pay: ₱' . number_format($loanAmount, 2)
                    . '. Additional partial amount: ₱' . number_format($partialAmount, 2)
                    . '. New amount can pay: ₱' . number_format($newAmountCanPay, 2) . '.';
                $studentTitle = 'Partial Payment';
                $studentMessage = "An additional partial amount of ₱" . number_format($partialAmount, 2)
                    . " was added to loan {$loan['loan_application_no']}. Your new amount can pay is ₱"
                    . number_format($newAmountCanPay, 2) . ". Please proceed to the Cashier's office.";
                $emailType = 'partial_payment';
                
            } else { // return
                $nextStepId = 8;
                $loanStatusId = 6;
                $approvalStatusId = 5;
                $trackingAction = 'Returned to Student';
                $trackingRemarks = $remarks !== '' ? $remarks : 'Returned to the student for revision.';
                $studentTitle = 'Loan Application Returned';
                $studentMessage = "Loan {$loan['loan_application_no']} was returned for revision. Please review the office remarks and resubmit.";
                $emailType = 'return';
            }
            
            // Route notifications to the next office at the student's campus.
            $recipients = [];
            if ($nextRoleId > 0) {
                if ($nextRoleId === 99 || $nextRoleId === 97) {
                    $recipientStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1');
                    $recipientStmt->execute([$nextRoleId]);
                } else {
                    $recipientStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_campus_id = ? AND employee_status = 1');
                    $recipientStmt->execute([$nextRoleId, (int) $loan['student_campus_id']]);
                }
                $recipients = array_map('intval', $recipientStmt->fetchAll(PDO::FETCH_COLUMN));
                if ($recipients === []) {
                    throw new RuntimeException('The target office does not have an active employee at this campus.');
                }
            }
            
            // Update loan
            if ($processType === 'partial') {
                // Add the partial amount to the student's existing commitment.
                // Keep the additional amount separately for audit/Cashier use.
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans 
                    SET loan_status_id = 2, 
                        loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 2 END, 
                        loan_current_step_id = ?, 
                        loan_amount_can_pay = ?,
                        loan_required_partial_amount = ?, 
                        loan_approval_date = CURDATE(),
                        loan_updated_by = ?, 
                        loan_updated_at = NOW() 
                    WHERE loan_id = ?');
                $updateStmt->execute([$nextStepId, $newAmountCanPay, $partialAmount, $employeeId, $loanId]);
            } elseif ($processType === 'return') {
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 6, loan_current_step_id = 8, loan_returned_date = NOW(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$employeeId, $loanId]);
            } elseif ($loanStatusId === 2) { // approve
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 2, loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 1 END, loan_current_step_id = ?, loan_approval_date = CURDATE(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$nextStepId, $employeeId, $loanId]);
            } elseif ($loanStatusId === 12) { // endorse
                // For endorsements, update loan_amount_can_pay if Assessment extended it
                if ($approvalAmount !== null && $approvalAmount > $loanAmount) {
                    $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 12, loan_current_step_id = ?, loan_amount_can_pay = ?, loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                    $updateStmt->execute([$nextStepId, $approvalAmount, $employeeId, $loanId]);
                } else {
                    $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 12, loan_current_step_id = ?, loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                    $updateStmt->execute([$nextStepId, $employeeId, $loanId]);
                }
            } else {
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = ?, loan_current_step_id = ?, loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$loanStatusId, $nextStepId, $employeeId, $loanId]);
            }
            
            // Add approval record (only for non-endorse actions)
            if (!in_array($processType, ['endorse_branch', 'endorse_coo'], true)) {
                $approvalCheck = $pdo->prepare('SELECT approval_id FROM tbl_csdl_loan_approvals WHERE approval_loan_id = ? AND approval_step_id = 2 AND approval_role_id = 101 ORDER BY approval_id DESC LIMIT 1');
                $approvalCheck->execute([$loanId]);
                $approvalId = (int) ($approvalCheck->fetchColumn() ?: 0);
                if ($approvalId > 0) {
                    $approvalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals SET approval_amount_approved = ?, approval_processed_by = ?, approval_date_processed = NOW(), approval_channel_used = 'Email', approval_date_contacted = NOW(), approval_remarks = ?, approval_status_id = ?, approval_approved_email = 1, approval_updated_at = NOW() WHERE approval_id = ?");
                    $approvalStmt->execute([$approvalAmount, $employeeId, $remarks, $approvalStatusId, $approvalId]);
                } else {
                    $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, approval_processed_by, approval_date_processed, approval_channel_used, approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email) VALUES (?, 2, 101, ?, ?, NOW(), 'Email', NOW(), ?, ?, 1)");
                    $approvalStmt->execute([$loanId, $approvalAmount, $employeeId, $remarks, $approvalStatusId]);
                }
            }
            
            // Add tracking entry
            $trackingStmt = $pdo->prepare('INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, ?, ?, ?)');
            // loan_tracking_updated_by is constrained to the student record.
            // Keep the Assessment employee in the audit remark instead.
            $trackingStmt->execute([$loanId, $nextStepId, $trackingAction, $trackingRemarks . " Processed by Assessment employee #{$employeeId}.", (int) $loan['loan_student_id']]);
            
            // Send notifications
            $notificationStmt = $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, ?, NOW())');
            $pushQueue = [];
            foreach ($recipients as $recipientId) {
                $officeTitle = 'Loan Assigned for Review';
                $officeMessage = "Loan {$loan['loan_application_no']} is now assigned to your office.";
                $notificationStmt->execute([$recipientId, null, $nextStepId, $loanId, $officeTitle, $officeMessage]);
                $pushQueue[] = [$recipientId, 'employee', (int) $pdo->lastInsertId(), $officeTitle, $officeMessage];
            }
            $notificationStmt->execute([null, (int) $loan['loan_student_id'], $nextStepId, $loanId, $studentTitle, $studentMessage]);
            $pushQueue[] = [(int) $loan['loan_student_id'], 'student', (int) $pdo->lastInsertId(), $studentTitle, $studentMessage];
            
            $pdo->commit();
            
            // Send push notifications
            queueLoanNotifications(
                $pdo,
                $loan,
                $emailType,
                (string) $loan['loan_application_no'],
                $approvalAmount !== null ? '₱' . number_format($approvalAmount, 2) : null,
                null,
                $emailDestination,
                $processType === 'partial' ? '₱' . number_format((float) $newAmountCanPay, 2) : null,
                senderRole: 'assessment'
            );
            foreach ($pushQueue as [$recipientId, $recipientType, $notificationId, $title, $message]) {
                sendPushNotification($pdo, $recipientId, $recipientType, ['id' => $notificationId, 'title' => $title, 'message' => $message, 'loanId' => $loanId]);
            }
            
            $successMessage = $processType === 'partial'
                ? 'Additional partial amount saved. New Amount Can Pay: ₱' . number_format((float) $newAmountCanPay, 2) . '. Sent to Cashier.'
                : ($processType === 'return'
                    ? 'Loan returned to the student.'
                    : ($processType === 'approve'
                        ? 'Loan approved and sent to Cashier.'
                        : 'Loan endorsed successfully.'));
            echo json_encode(['success' => true, 'message' => $successMessage]);
        } catch (InvalidArgumentException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('Assessment loan workflow: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to process this loan right now.']);
        }
        exit;
    }

    // The ownership guard also rejects CSDL-approved loans through this endpoint.
    if ($action === 'tag_pn') {
        RBAC::requirePermission($employeeId, 'assessment.loans.tag_pn', 'You do not have permission to tag promissory notes');
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $remarks = trim((string) ($_POST['remarks'] ?? ''));
        if ($loanId <= 0 || ($_POST['pnStatus'] ?? '') !== 'Tagged') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid PN tagging request.']);
            exit;
        }
        try {
            completeAssessmentPnTagging($pdo, $employeeId, $loanId, $remarks);
            echo json_encode(['success' => true, 'message' => 'PN tagged successfully. Loan has been completed and student notified.']);
        } catch (PDOException $e) {
            error_log('Assessment PN tagging database error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to tag the PN right now.']);
        } catch (RuntimeException $e) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            error_log('Assessment PN tagging workflow: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to tag the PN right now.']);
        }
        exit;
    }
    
    if (false && $action === 'legacy_tag_pn') {
        $partialPaymentPermissionByRole = [
            100 => 'csdl.loans.approve',
            99 => 'cashier.loans.approve',
            97 => 'coo.loans.approve',
            101 => 'assessment.loans.tag_pn',
        ];
        $requiredPermission = $partialPaymentPermissionByRole[$userRoleId] ?? '';
        RBAC::requirePermission($employeeId, $requiredPermission, 'You do not have permission to record a partial payment');
        $loanId = intval($_POST['loanId'] ?? 0);
        $pnStatus = trim($_POST['pnStatus'] ?? '');
        $partialPaymentAmount = (float) ($_POST['partialPaymentAmount'] ?? 0);
        $partialPaymentDueDate = trim($_POST['partialPaymentDueDate'] ?? '');
        $remarks = trim($_POST['remarks'] ?? '');
        
        if ($loanId <= 0 || $pnStatus === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Missing required fields']);
            exit;
        }
        
        if (!in_array($pnStatus, ['Paid', 'Partial Payment'], true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid PN status']);
            exit;
        }
        if ($pnStatus !== 'Partial Payment' && $userRoleId !== 101) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Only Cashier can mark a PN as paid']);
            exit;
        }
        if ($pnStatus === 'Partial Payment' && $partialPaymentAmount <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Partial payment amount is required']);
            exit;
        }
        try {
            $pdo->beginTransaction();

            $sourceStepByRole = [100 => 1, 99 => 2, 97 => 4, 101 => 11];
            $sourceStepId = $sourceStepByRole[$userRoleId] ?? 0;
            
            $loanStmt = $pdo->prepare("SELECT l.loan_id,
                                              l.loan_application_no,
                                              l.loan_student_id,
                                              l.loan_amount_can_pay,
                                              l.loan_balance_id,
                                              l.loan_current_step_id,
                                              l.loan_due_date,
                                              b.balance_current_balance,
                                              s.student_campus_id,
                                              s.student_email,
                                              s.student_personal_email,
                                              s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                                              c.campus_code
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                       LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                                       WHERE l.loan_id = ?");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                throw new Exception('Loan not found');
            }
            if ((int) $loan['loan_current_step_id'] !== $sourceStepId) {
                throw new Exception('Loan is no longer assigned to your office');
            }

            // Partial-payment processing keeps the fixed 30-day application deadline.
            if ($pnStatus === 'Partial Payment') {
                $tz = new DateTimeZone('Asia/Manila');
                $currentLoanDue = false;
                if (!empty($loan['loan_due_date'])) {
                    $currentLoanDue = DateTimeImmutable::createFromFormat('Y-m-d', (string)$loan['loan_due_date'], $tz);
                }
                $partialPaymentDueDate = $currentLoanDue
                    ? $currentLoanDue->format('Y-m-d')
                    : (new DateTimeImmutable('today', $tz))->modify('+30 days')->format('Y-m-d');
            }
            
            $userId = $_SESSION['user_id'] ?? 0;
            $isPartialPayment = $pnStatus === 'Partial Payment';
            $nextAssignment = null;
            $nextEmployeeId = null;

            if (!$isPartialPayment) {
                $totalPaymentApplied = getLoanPaymentTotalForRouting(
                    $pdo,
                    $loanId,
                    (float) ($loan['loan_amount_can_pay'] ?? 0)
                );
                $nextAssignment = resolveNextLoanAssignment($pdo, $loan, $pnStatus, $partialPaymentAmount, $totalPaymentApplied);
                $nextEmployeeId = resolveAssignedEmployee($pdo, $nextAssignment['roleId'], $nextAssignment['campusId']);
            }
            
            // Reuse the unique approval row for Assessment step 11 if it already exists.
            // The table enforces uniqueness by (loan_id, step_id, role_id), so this must
            // check by that key instead of approval_pn_tagging presence.
            $checkStmt = $pdo->prepare("SELECT approval_id
                                        FROM tbl_csdl_loan_approvals
                                        WHERE approval_loan_id = ?
                                          AND approval_step_id = ?
                                          AND approval_role_id = ?");
            $checkStmt->execute([$loanId, $sourceStepId, $userRoleId]);
            $existingPNRecord = $checkStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existingPNRecord) {
                // Update existing PN tagging record
                if ($pnStatus === 'Partial Payment') {
                    $updateSql = "UPDATE tbl_csdl_loan_approvals
                                  SET approval_pn_tagging = ?,
                                      approval_pn_date_processed = NOW(),
                                      approval_processed_by = ?,
                                      approval_remarks = ?,
                                      approval_amount_approved = ?,
                                      approval_updated_at = NOW()
                                  WHERE approval_id = ?";
                    $updateStmt = $pdo->prepare($updateSql);
                    $updateStmt->execute([
                        $pnStatus,
                        $userId,
                        $remarks,
                        $partialPaymentAmount,
                        $existingPNRecord['approval_id']
                    ]);
                } else {
                    $updateSql = "UPDATE tbl_csdl_loan_approvals
                                  SET approval_pn_tagging = ?,
                                      approval_pn_date_processed = NOW(),
                                      approval_processed_by = ?,
                                      approval_remarks = ?,
                                      approval_updated_at = NOW()
                                  WHERE approval_id = ?";
                    $updateStmt = $pdo->prepare($updateSql);
                    $updateStmt->execute([
                        $pnStatus,
                        $userId,
                        $remarks,
                        $existingPNRecord['approval_id']
                    ]);
                }
            } else {
                // Insert new PN tagging record - use step_id = 11 (Assessment PN Tagging step)
                if ($pnStatus === 'Partial Payment') {
                    $insertSql = "INSERT INTO tbl_csdl_loan_approvals
                                 (approval_loan_id, approval_step_id, approval_role_id, approval_pn_tagging, approval_pn_date_processed, approval_processed_by, approval_remarks, approval_amount_approved, approval_status_id)
                                 VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, 1)";
                    $insertStmt = $pdo->prepare($insertSql);
                    $insertStmt->execute([
                        $loanId,
                        $sourceStepId,
                        $userRoleId,
                        $pnStatus,
                        $userId,
                        $remarks,
                        $partialPaymentAmount
                    ]);
                } else {
                    $insertSql = "INSERT INTO tbl_csdl_loan_approvals
                                 (approval_loan_id, approval_step_id, approval_role_id, approval_pn_tagging, approval_pn_date_processed, approval_processed_by, approval_remarks, approval_status_id)
                                 VALUES (?, ?, ?, ?, NOW(), ?, ?, 1)";
                    $insertStmt = $pdo->prepare($insertSql);
                    $insertStmt->execute([
                        $loanId,
                        $sourceStepId,
                        $userRoleId,
                        $pnStatus,
                        $userId,
                        $remarks
                    ]);
                }
            }

            if ($isPartialPayment) {
                // Remaining promised amount after this partial payment.
                // When fully paid via partial, remaining becomes 0 in DB but promised amount
                // stays visible via recorded partial payment totals.
                $remainingBalance = max(0, (float) ($loan['loan_amount_can_pay'] ?? 0) - $partialPaymentAmount);
                $loanUpdate = $pdo->prepare("UPDATE tbl_csdl_loans
                                             SET loan_status_id = ?,
                                                 loan_current_step_id = ?,
                                                 loan_amount_can_pay = ?,
                                                 loan_due_date = ?,
                                                 loan_promised_payment_date = ?,
                                                 loan_updated_by = ?,
                                                 loan_updated_at = NOW()
                                             WHERE loan_id = ?");
                $loanUpdate->execute([
                    1,
                    11,
                    $remainingBalance,
                    $partialPaymentDueDate,
                    $partialPaymentDueDate,
                    $userId,
                    $loanId
                ]);

                // Add tracking for partial payment + next due date.
                $trackStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking
                                            (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by, loan_tracking_created_at)
                                            VALUES (?, 11, 'Partial Payment Recorded', ?, ?, NOW())");
                $trackRemarks = "Partial payment of ₱" . number_format($partialPaymentAmount, 2) . " recorded. Due: {$partialPaymentDueDate}.";
                if ($remarks !== '') {
                    $trackRemarks .= " " . $remarks;
                }
                // NOTE: tbl_csdl_loan_tracking.loan_tracking_updated_by is FK -> tbl_csdl_students.student_id
                // so we store the student id here to satisfy the constraint.
                $trackStmt->execute([$loanId, $trackRemarks, (int)$loan['loan_student_id']]);
            } else {
                $loanUpdate = $pdo->prepare("UPDATE tbl_csdl_loans
                                             SET loan_status_id = ?,
                                                 loan_current_step_id = ?,
                                                 loan_updated_by = ?,
                                                 loan_updated_at = NOW()
                                             WHERE loan_id = ?");
                $loanUpdate->execute([
                    1,
                    $nextAssignment['stepId'],
                    $userId,
                    $loanId
                ]);
            }

            $officeNameMap = [
                100 => 'CSDL Office',
                98 => 'Branch Admin Office',
                99 => 'Cashier Office',
                97 => 'COO Office',
                101 => 'Assessment Office'
            ];
            $targetOffice = $isPartialPayment
                ? 'Cashier Office'
                : ($officeNameMap[$nextAssignment['roleId']] ?? 'next office');
            $studentName = trim((string) ($loan['student_name'] ?? 'Student'));
            $applicationNo = (string) ($loan['loan_application_no'] ?? '');
            $actorOfficeMap = [100 => 'CSDL', 99 => 'Cashier', 97 => 'COO', 101 => 'Assessment'];
            $actorOffice = $actorOfficeMap[$userRoleId] ?? 'Loan Office';
            $notifTitle = $isPartialPayment ? 'Loan Routed to Cashier' : "Loan Assigned From {$actorOffice}";
            $notifMessage = "Loan {$applicationNo} assigned to {$targetOffice}.";

            $pushQueue = [];
            $notificationStepId = $isPartialPayment ? 11 : (int)$nextAssignment['stepId'];

            if (!$isPartialPayment) {
                // Notify assigned office users only when forwarding.
                if ($nextEmployeeId > 0) {
                    $recipients = [$nextEmployeeId];
                } else {
                    if ((int)$nextAssignment['roleId'] === 98 && (int)$nextAssignment['campusId'] > 0) {
                        $empStmt = $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees
                                                  WHERE employee_role_id = ? AND employee_status = 1 AND employee_campus_id = ?");
                        $empStmt->execute([(int)$nextAssignment['roleId'], (int)$nextAssignment['campusId']]);
                    } else {
                        $empStmt = $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees
                                                  WHERE employee_role_id = ? AND employee_status = 1");
                        $empStmt->execute([(int)$nextAssignment['roleId']]);
                    }
                    $recipients = array_map('intval', $empStmt->fetchAll(PDO::FETCH_COLUMN));
                }

                $notifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications
                                            (notification_employee_id, notification_loan_id, notification_workflow_step_id, notification_title, notification_message, notification_sent_at)
                                            VALUES (?, ?, ?, ?, ?, NOW())");
                foreach ($recipients as $recipientId) {
                    if ($recipientId <= 0) continue;
                    $notifStmt->execute([$recipientId, $loanId, $notificationStepId, $notifTitle, $notifMessage]);
                    $pushQueue[] = [
                        'userId' => $recipientId,
                        'notificationId' => (int)$pdo->lastInsertId()
                    ];
                }
            }

            // Notify student as well for transparency.
            $partialPaymentDueDateLabel = $isPartialPayment
                ? date('F j, Y', strtotime($partialPaymentDueDate))
                : null;
            $studentNotifTitle = $isPartialPayment ? 'Partial Payment Required' : "{$actorOffice} Updated Your Loan";
            $studentNotifMessage = $isPartialPayment
                ? ("Please pay the required partial payment of ₱" . number_format($partialPaymentAmount, 2) . " for loan {$applicationNo} on or before {$partialPaymentDueDateLabel}.")
                : "Loan {$applicationNo} routed to {$targetOffice}.";
            $studentNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications
                                               (notification_student_id, notification_loan_id, notification_workflow_step_id, notification_title, notification_message, notification_sent_at)
                                               VALUES (?, ?, ?, ?, ?, NOW())");
            $studentNotifStmt->execute([(int)$loan['loan_student_id'], $loanId, $notificationStepId, $studentNotifTitle, $studentNotifMessage]);
            $studentPush = [
                'userId' => (int)$loan['loan_student_id'],
                'notificationId' => (int)$pdo->lastInsertId()
            ];
            
            $pdo->commit();

            $loanForNotification = [
                'student_name' => $studentName,
                'student_email' => $loan['student_email'] ?? '',
                'student_personal_email' => $loan['student_personal_email'] ?? '',
                'student_contact_number' => $loan['student_contact_number'] ?? '',
            ];
            if ($isPartialPayment) {
                queueLoanNotifications(
                    $pdo,
                    $loanForNotification,
                    'partial_payment',
                    $applicationNo,
                    '₱' . number_format($partialPaymentAmount, 2),
                    $partialPaymentDueDateLabel,
                    senderRole: 'assessment'
                );
            } else {
                queueLoanNotifications(
                    $pdo,
                    $loanForNotification,
                    'pn_paid',
                    $applicationNo,
                    null,
                    senderRole: 'assessment'
                );
            }

            foreach ($pushQueue as $item) {
                sendPushNotification($pdo, $item['userId'], 'employee', [
                    'id' => $item['notificationId'],
                    'title' => $notifTitle,
                    'message' => $notifMessage,
                    'loanId' => $loanId
                ]);
            }
            sendPushNotification($pdo, $studentPush['userId'], 'student', [
                'id' => $studentPush['notificationId'],
                'title' => $studentNotifTitle,
                'message' => $studentNotifMessage,
                'loanId' => $loanId
            ]);

            echo json_encode(['success' => true, 'message' => 'PN status tagged successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('Assessment PN tagging error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error tagging PN status']);
        }
        return;
    }
    
    if (false && $action === 'legacy_process') {
        $loanId = intval($_POST['loanId'] ?? 0);
        $processType = $_POST['processType'] ?? '';
        $amountApproved = floatval($_POST['amountApproved'] ?? 0);
        $remarks = trim($_POST['remarks'] ?? '');

        if (in_array($processType, ['decline', 'return'], true)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Declining and returning loans are not available for Assessment']);
            exit;
        } elseif ($processType === 'approve') {
            RBAC::requirePermission($employeeId, 'assessment.loans.tag_pn', 'You do not have permission to approve loans');
        } elseif ($processType === 'endorsed') {
            RBAC::requirePermission($employeeId, 'assessment.loans.tag_pn', 'You do not have permission to endorse loans');
        }
        
        if ($loanId <= 0 || $processType === '' || $remarks === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Missing required fields']);
            exit;
        }
        
        if ($processType === 'approve' && $amountApproved <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Amount approved is required']);
            exit;
        }
        
        try {
            $pdo->beginTransaction();
            
            $loanStmt = $pdo->prepare("SELECT l.*,
                                              s.student_school_id,
                                              s.student_campus_id,
                                              s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                                              s.student_email,
                                              s.student_personal_email,
                                              b.balance_current_balance
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                       WHERE l.loan_id = ?");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                throw new Exception('Loan not found');
            }

            $loanStep = (int) ($loan['loan_current_step_id'] ?? 0);
            $loanStatus = (int) ($loan['loan_status_id'] ?? 0);
            $studentCampusId = (int) ($loan['student_campus_id'] ?? 0);

            if ($loanStep === 11) {
                if (!in_array($processType, ['decline', 'return'], true)) {
                    throw new Exception('Only decline or return is allowed during Assessment intake');
                }
                if ($loanStatus !== 1) {
                    throw new Exception('Only pending applications can be declined or returned at Assessment');
                }
            } elseif ($loanStep === 2) {
                if (!in_array($processType, ['approve', 'decline', 'return', 'endorsed'], true)) {
                    throw new Exception('Invalid process type for Assessment review');
                }
            } else {
                throw new Exception('Invalid loan or not at Assessment step');
            }
            
            $userId = $_SESSION['user_id'] ?? 0;
            $currentStepId = $loanStep;
            $currentBalance = floatval($loan['balance_current_balance'] ?? 0);
            
            $newStatusId = (int) $loan['loan_status_id'];
            $newStepId = $currentStepId;
            $approvalStatusId = 1;
            
            if ($processType === 'approve') {
                $paymentAmount = $amountApproved > 0 ? $amountApproved : floatval($loan['loan_amount_can_pay'] ?? 0);
                $balanceAfterPayment = $currentBalance - $paymentAmount;
                
                if ($balanceAfterPayment > 7000) {
                    throw new Exception('Cannot approve: Balance after payment exceeds ₱7,000');
                }
                
                $approvalStatusId = 2;
                $newStatusId = 2;
                $newStepId = 5;
            } elseif ($processType === 'decline') {
                $approvalStatusId = 3;
                $newStatusId = 3;
                $newStepId = 7;
                $amountApproved = null;
            } elseif ($processType === 'return') {
                $approvalStatusId = 5;
                $newStatusId = 6;
                $newStepId = 8;
                $amountApproved = null;
            } elseif ($processType === 'endorsed') {
                $approvalStatusId = 4;
                $newStatusId = 7;
                $newStepId = 4;
            }
            
            $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?");
            $checkApprovalStmt->execute([$loanId, $currentStepId, $userRoleId]);
            $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existingApproval) {
                $approvalSql = "UPDATE tbl_csdl_loan_approvals SET approval_step_id = ?, approval_amount_approved = ?, approval_processed_by = ?, approval_date_processed = NOW(), approval_remarks = ?, approval_status_id = ?, approval_updated_at = NOW() WHERE approval_id = ?";
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([$newStepId, $amountApproved, $userId, $remarks, $approvalStatusId, $existingApproval['approval_id']]);
            } else {
                $approvalSql = "INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, approval_processed_by, approval_date_processed, approval_remarks, approval_status_id) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)";
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([$loanId, $newStepId, $userRoleId, $amountApproved, $userId, $remarks, $approvalStatusId]);
            }
            
            $updateSql = "UPDATE tbl_csdl_loans SET loan_status_id = ?, loan_current_step_id = ?, loan_updated_by = ?, loan_updated_at = NOW()";
            $updateParams = [$newStatusId, $newStepId, $userId];
            
            if ($processType === 'approve') {
                $updateSql .= ", loan_approval_date = CURDATE()";
            } elseif ($processType === 'decline') {
                $updateSql .= ", loan_declined_date = NOW()";
            } elseif ($processType === 'return') {
                $updateSql .= ", loan_returned_date = NOW()";
            }
            
            $updateSql .= " WHERE loan_id = ?";
            $updateParams[] = $loanId;
            
            $updateStmt = $pdo->prepare($updateSql);
            $updateStmt->execute($updateParams);
            
            $actionTextMap = ['approve' => 'Approved', 'decline' => 'Declined', 'return' => 'Returned', 'endorsed' => 'Endorsed'];
            $actionText = $actionTextMap[$processType] ?? ucfirst($processType);
            
            $trackingSql = "INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, ?, ?, ?)";
            $trackStmt = $pdo->prepare($trackingSql);
            $trackStmt->execute([$loanId, $newStepId, $actionText, $remarks, $loan['loan_student_id']]);

            $applicationNo = (string) ($loan['loan_application_no'] ?? '');
            $studentId = (int) ($loan['loan_student_id'] ?? 0);
            $studentNotifTitle = '';
            $studentNotifMessage = '';

            if ($processType === 'decline') {
                $studentNotifTitle = 'Loan Declined';
                $studentNotifMessage = "Loan {$applicationNo} declined.";
            } elseif ($processType === 'return') {
                $studentNotifTitle = 'Loan Application Returned';
                $studentNotifMessage = "Loan {$applicationNo} returned for revision.";
            } elseif ($processType === 'approve') {
                $studentNotifTitle = 'Loan Approved';
                $studentNotifMessage = "Loan {$applicationNo} approved.";
            } elseif ($processType === 'endorsed') {
                $studentNotifTitle = 'Loan Endorsed to COO';
                $studentNotifMessage = "Loan {$applicationNo} endorsed to COO Office for review.";
            }

            if ($studentNotifTitle !== '' && $studentId > 0) {
                $notifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications
                                           (notification_student_id, notification_loan_id, notification_workflow_step_id, notification_title, notification_message, notification_sent_at)
                                           VALUES (?, ?, ?, ?, ?, NOW())");
                $notifStmt->execute([$studentId, $loanId, $newStepId, $studentNotifTitle, $studentNotifMessage]);
                $notificationId = (int) $pdo->lastInsertId();
            } else {
                $notificationId = 0;
            }
            
            $pdo->commit();

            if ($notificationId > 0) {
                sendPushNotification($pdo, $studentId, 'student', [
                    'id' => $notificationId,
                    'title' => $studentNotifTitle,
                    'message' => $studentNotifMessage,
                    'loanId' => $loanId,
                ]);
            }

            if (in_array($processType, ['decline', 'return', 'approve', 'endorsed'], true)) {
                queueLoanNotifications(
                    $pdo,
                    $loan,
                    $processType,
                    $applicationNo,
                    null,
                    null,
                    $processType === 'endorsed' ? 'COO Office' : null,
                    senderRole: 'assessment'
                );
            }

            echo json_encode(['success' => true, 'message' => 'Loan processed successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('Assessment process loan error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => $e->getMessage() ?: 'Error processing loan']);
        }
        return;
    }
}

http_response_code(400);
echo json_encode(['success' => false, 'message' => 'Invalid action']);
?>
