<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-send-push-notification.php';
require_once __DIR__ . '/../includes/includes-email-templates.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';
require_once __DIR__ . '/../includes/includes-loan-promised-amount.php';
require_once __DIR__ . '/../includes/includes-csdl-pn-tagging.php';
require_once __DIR__ . '/../config/config-env.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

RBAC::init($pdo);
$employeeId = (int) ($_SESSION['user_id'] ?? 0);
$employeeCampusStmt = $pdo->prepare('SELECT employee_role_id FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1');
$employeeCampusStmt->execute([$employeeId]);
$employeeContext = $employeeCampusStmt->fetch(PDO::FETCH_ASSOC) ?: [];
if ((int) ($employeeContext['employee_role_id'] ?? 0) !== 100) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'No active CSDL assignment is available for your account.']);
    exit;
}

queueOverdueLoanNotifications($pdo);

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';
    if ($action === 'details') {
        RBAC::requireAnyPermission($employeeId, ['csdl.loans.view', 'csdl.pntagging.view'], 'You do not have permission to view this loan.');
        if (!RBAC::hasPermission($employeeId, 'csdl.loans.view')
            && !canReadCsdlPnTagging($pdo, (int) ($_GET['loanId'] ?? 0))) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'This loan is not in the CSDL PN tagging queue.']);
            exit;
        }
    } else {
        RBAC::requirePermission($employeeId, 'csdl.loans.view', 'You do not have permission to view loans');
    }
    
    if ($action === 'list') {
        try {
            $page = max(1, intval($_GET['page'] ?? 1));
            $perPage = max(10, min(100, intval($_GET['perPage'] ?? 25)));
            $offset = ($page - 1) * $perPage;
            
            $statusFilter = $_GET['status'] ?? '';
            $semesterFilter = $_GET['semester'] ?? '';
            $schoolYearFilter = $_GET['schoolYear'] ?? '';
            $periodFilter = $_GET['period'] ?? '';
            $campusFilter = $_GET['campus'] ?? '';
            $overdue = $_GET['overdue'] ?? '';
            $newToday = $_GET['newToday'] ?? '';
            $newThisWeek = $_GET['newThisWeek'] ?? '';
            $search = trim($_GET['search'] ?? '');
            $scope = strtolower(trim((string) ($_GET['scope'] ?? 'active')));
            if (!in_array($scope, ['active', 'all', 'archived'], true)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid application view']);
                return;
            }
            $isAllApplications = $scope === 'all';
            $isArchived = $scope === 'archived';
            
            // CSDL is the first reviewer for every campus. Eligibility is
            // enforced by the remaining-balance threshold when processing.
            $employeeContextStmt = $pdo->prepare("SELECT employee_role_id FROM tbl_csdl_employees WHERE employee_id = ?");
            $employeeContextStmt->execute([$employeeId]);
            $employeeContext = $employeeContextStmt->fetch(PDO::FETCH_ASSOC) ?: [];
            if ((int) ($employeeContext['employee_role_id'] ?? 0) !== 100) {
                throw new RuntimeException('Your account is not assigned to the CSDL role.');
            }

            // Active keeps the CSDL processing queue. All Applications and
            // Archived cover every workflow route without changing loan status.
            $where = ($isAllApplications || $isArchived) ? ['1 = 1'] : ['l.loan_current_step_id = 1'];
            $where[] = $isArchived ? 'l.loan_archived_at IS NOT NULL' : 'l.loan_archived_at IS NULL';
            $params = [];
            
            // Default: Show only Pending loans (status_id = 1) for Active Loans
            // But allow status filter for modal views
            if ($statusFilter !== '') {
                $where[] = 'l.loan_status_id = ?';
                $params[] = $statusFilter;
            } elseif (!$isAllApplications && !$isArchived) {
                // Default: Show pending loans only.
                $where[] = 'l.loan_status_id = 1';
            }
            
            // Filter: Overdue (past expiry timestamp)
            if ($overdue === '1') {
                $where[] = 'l.loan_expiry_timestamp IS NOT NULL 
                            AND l.loan_expiry_timestamp < NOW()
                            AND l.loan_status_id = 1';
            }
            
            // Filter: New Today
            if ($newToday === '1') {
                $where[] = 'DATE(l.loan_application_date) = CURDATE()';
            }
            
            // Filter: New This Week (Monday to Sunday)
            if ($newThisWeek === '1') {
                $where[] = 'YEARWEEK(l.loan_application_date, 1) = YEARWEEK(CURDATE(), 1)';
            }
            
            // Filter by semester (through balance -> school year -> semester)
            if ($semesterFilter !== '') {
                $where[] = 'EXISTS (
                    SELECT 1 FROM tbl_csdl_balances b
                    INNER JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                    WHERE b.balance_id = l.loan_balance_id
                    AND sy.sy_semester_id = ?
                )';
                $params[] = $semesterFilter;
            }
            
            // Filter by school year (through balance -> school year)
            if ($schoolYearFilter !== '') {
                $where[] = 'EXISTS (
                    SELECT 1 FROM tbl_csdl_balances b
                    WHERE b.balance_id = l.loan_balance_id
                    AND b.balance_sy_id = ?
                )';
                $params[] = $schoolYearFilter;
            }
            
            // Filter by application period
            if ($periodFilter !== '') {
                $where[] = 'l.loan_app_period_id = ?';
                $params[] = $periodFilter;
            }

            // Optional CSDL filter only. It must not restrict which campuses
            // CSDL is allowed to process when no campus is selected.
            if ($campusFilter !== '') {
                $where[] = 's.student_campus_id = ?';
                $params[] = $campusFilter;
            }
            
            if ($search !== '') {
                $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_first_name, " ", s.student_last_name) LIKE ?)';
                $searchParam = "%{$search}%";
                $params[] = $searchParam;
                $params[] = $searchParam;
                $params[] = $searchParam;
            }
            
            $whereClause = implode(' AND ', $where);
            
            // Get total count
            $countSql = "SELECT COUNT(*) as total 
                        FROM tbl_csdl_loans l
                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                        WHERE {$whereClause}";
            $countStmt = $pdo->prepare($countSql);
            $countStmt->execute($params);
            $total = $countStmt->fetch(PDO::FETCH_ASSOC)['total'];
            
            // Get loans
            $sql = "SELECT l.loan_id,
                           l.loan_application_no,
                           l.loan_student_id,
                           s.student_school_id,
                           CONCAT(s.student_last_name, ', ', s.student_first_name, IFNULL(CONCAT(' ', s.student_middle_name), '')) as student_name,
                           COALESCE(c.campus_name, 'Unassigned') AS campus_name,
                           l.loan_amount_can_pay,
                           l.loan_recorded_payment_amount,
                           b.balance_total_balance,
                           b.balance_advice_to_pay,
                           l.loan_status_id,
                           l.loan_payment_status_id,
                           ls.loan_status_name,
                           COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                           COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status,
                           l.loan_current_step_id,
                           ws.step_name as current_step_name,
                           l.loan_application_date,
                           l.loan_approval_date,
                           l.loan_due_date,
                           l.loan_promised_payment_date,
                           l.loan_archived_at,
                           l.loan_expiry_timestamp
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                    LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                    WHERE {$whereClause}
                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                    LIMIT ? OFFSET ?";
            
            $params[] = $perPage;
            $params[] = $offset;
            
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $loans = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'data' => $loans,
                'total' => $total,
                'page' => $page,
                'perPage' => $perPage,
                'totalPages' => ceil($total / $perPage)
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('CSDL list loans error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error fetching loans']);
        }
        return;
    }
    
    if ($action === 'stats') {
        try {
            // A passed timestamp creates an overdue alert only. It never changes
            // the loan status or removes the application from the active queue.
            
            $employeeContextStmt = $pdo->prepare("SELECT employee_role_id FROM tbl_csdl_employees WHERE employee_id = ?");
            $employeeContextStmt->execute([$employeeId]);
            $employeeContext = $employeeContextStmt->fetch(PDO::FETCH_ASSOC) ?: [];
            if ((int) ($employeeContext['employee_role_id'] ?? 0) !== 100) {
                throw new RuntimeException('Your account is not assigned to the CSDL role.');
            }

            $stats = [];
            $queueJoin = ' FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id ';
            $queueWhere = ' WHERE l.loan_current_step_id = 1 AND l.loan_archived_at IS NULL ';
            
            // Total Pending (for current user's workflow step)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count {$queueJoin} {$queueWhere} AND l.loan_status_id = 1");
            $stmt->execute();
            $stats['pending'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];

            $stmt = $pdo->query('SELECT COUNT(*) AS count FROM tbl_csdl_loans WHERE loan_archived_at IS NULL');
            $stats['allApplications'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            $stmt = $pdo->query('SELECT COUNT(*) AS count FROM tbl_csdl_loans WHERE loan_archived_at IS NOT NULL');
            $stats['archivedApplications'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Expiring Soon (within 24 hours from now, for current user's workflow step)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count {$queueJoin} {$queueWhere}
                                AND l.loan_status_id = 1
                                AND l.loan_expiry_timestamp IS NOT NULL
                                AND l.loan_expiry_timestamp <= DATE_ADD(NOW(), INTERVAL 24 HOUR)
                                AND l.loan_expiry_timestamp > NOW()");
            $stmt->execute();
            
            // Overdue (expiry timestamp in the past, for current user's workflow step)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count {$queueJoin} {$queueWhere}
                                AND l.loan_expiry_timestamp IS NOT NULL
                                AND l.loan_expiry_timestamp < NOW()
                                AND l.loan_status_id = 1");
            $stmt->execute();
            $stats['overdue'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // New Today (applications submitted today, for current user's workflow step)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count {$queueJoin} {$queueWhere}
                                AND l.loan_status_id = 1
                                AND DATE(l.loan_application_date) = CURDATE()");
            $stmt->execute();
            $stats['newToday'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // New This Week (applications submitted this week, Monday to Sunday, for current user's workflow step)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count {$queueJoin} {$queueWhere}
                                AND l.loan_status_id = 1
                                AND YEARWEEK(l.loan_application_date, 1) = YEARWEEK(CURDATE(), 1)");
            $stmt->execute();
            $stats['newThisWeek'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            echo json_encode(['success' => true, 'stats' => $stats]);
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Error fetching stats']);
        }
        return;
    }
    
    if ($action === 'export') {
        try {
            $statusFilter = $_GET['status'] ?? '';
            $stepFilter = $_GET['step'] ?? '';
            $periodFilter = $_GET['period'] ?? '';
            $campusFilter = $_GET['campus'] ?? '';
            $dateFrom = $_GET['dateFrom'] ?? '';
            $dateTo = $_GET['dateTo'] ?? '';
            $search = trim($_GET['search'] ?? '');
            
            $where = ['l.loan_current_step_id = 1'];
            $params = [];
            
            if ($statusFilter !== '') {
                $where[] = 'l.loan_status_id = ?';
                $params[] = $statusFilter;
            } else {
                // Match Active Loans; paid applications have their own PN queue.
                $where[] = 'l.loan_status_id = 1';
            }
            
            if ($stepFilter !== '') {
                $where[] = 'l.loan_current_step_id = ?';
                $params[] = $stepFilter;
            }
            
            if ($periodFilter !== '') {
                $where[] = 'l.loan_app_period_id = ?';
                $params[] = $periodFilter;
            }

            if ($campusFilter !== '') {
                $where[] = 's.student_campus_id = ?';
                $params[] = $campusFilter;
            }
            
            if ($dateFrom !== '') {
                $where[] = 'DATE(l.loan_application_date) >= ?';
                $params[] = $dateFrom;
            }
            
            if ($dateTo !== '') {
                $where[] = 'DATE(l.loan_application_date) <= ?';
                $params[] = $dateTo;
            }
            
            if ($search !== '') {
                $searchParam = "%{$search}%";
                $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ?)';
                $params[] = $searchParam;
                $params[] = $searchParam;
            }
            
            $whereClause = implode(' AND ', $where);
            
            // Get all loans for export
            $exportSql = "SELECT 
                            l.loan_application_no AS 'Application No.',
                            s.student_school_id AS 'Student ID',
                            CONCAT(s.student_last_name, ', ', s.student_first_name, IFNULL(CONCAT(' ', s.student_middle_name), '')) AS 'Student Name',
                            FORMAT(l.loan_amount_can_pay, 2) AS 'Amount',
                            ls.loan_status_name AS 'Status',
                            COALESCE(ps.payment_status_name, 'Not Paid') AS 'Payment Status',
                            COALESCE(pns.pn_status_name, 'Not Tagged') AS 'PN Status',
                            ws.step_name AS 'Current Step',
                            ap.app_period_name AS 'Application Period',
                            DATE_FORMAT(l.loan_application_date, '%Y-%m-%d') AS 'Date Applied',
                            DATE_FORMAT(l.loan_due_date, '%Y-%m-%d') AS 'Due Date'
                         FROM tbl_csdl_loans l
                         JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                         LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                         LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                         LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                         LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                         LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                         WHERE {$whereClause}
                         ORDER BY l.loan_application_date DESC, l.loan_id DESC";
            
            $exportStmt = $pdo->prepare($exportSql);
            $exportStmt->execute($params);
            $data = $exportStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Generate CSV
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="csdl_loans_export_' . date('Y-m-d_His') . '.csv"');
            header('Pragma: no-cache');
            header('Expires: 0');
            
            $output = fopen('php://output', 'w');
            
            // Add UTF-8 BOM for Excel compatibility
            fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
            
            // Write headers
            if (!empty($data)) {
                fputcsv($output, array_keys($data[0]));
            }
            
            // Write data
            foreach ($data as $row) {
                fputcsv($output, $row);
            }
            
            fclose($output);
            exit;
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('CSDL export loans error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error exporting loans']);
        }
        return;
    }
    
    if ($action === 'details') {
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
                           COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                           COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status,
                           COALESCE(pns.pn_status_name, 'Not Tagged') AS pnStatus,
                           ws.step_name as current_step_name,
                           ap.app_period_name,
                           g.guardian_name,
                           rel.relationship_name as guardian_relationship,
                           g.guardian_contact,
                           b.balance_total_balance,
                           b.balance_current_balance,
                           b.balance_advice_to_pay,
                           l.loan_promised_payment_date,
                           c.campus_name,
                           sch.scholarship_name
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
                    LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                    LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                    LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                    LEFT JOIN tbl_csdl_guardians g ON g.guardian_id = l.loan_guardian_id
                    LEFT JOIN tbl_csdl_relationships rel ON rel.relationship_id = g.guardian_relationship_id
                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                    LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                    LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
                    WHERE l.loan_id = ?";
            
            $stmt = $pdo->prepare($sql);
            if (!$stmt) {
                throw new Exception('Failed to prepare SQL statement: ' . implode(', ', $pdo->errorInfo()));
            }
            
            $stmt->execute([$loanId]);
            $loan = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Loan not found']);
                return;
            }

            attachLoanPromisedAmountFields($pdo, $loanId, $loan);
            
            // Get documents
            $docStmt = $pdo->prepare("SELECT ld.*, dt.doc_type_name,
                                      r.review_status AS guardian_review_status,
                                      r.review_provider AS guardian_review_provider,
                                      r.review_evidence_json AS guardian_review_evidence
                                      FROM tbl_csdl_loan_documents ld
                                      LEFT JOIN tbl_csdl_document_types dt ON dt.doc_type_id = ld.loan_document_doc_type_id
                                      LEFT JOIN tbl_csdl_loan_document_reviews r ON r.review_document_id = ld.loan_document_id
                                      WHERE ld.loan_document_loan_id = ?");
            if ($docStmt) {
                $docStmt->execute([$loanId]);
                $loan['documents'] = $docStmt->fetchAll(PDO::FETCH_ASSOC);
            } else {
                $loan['documents'] = [];
            }
            
            // Get approval history
            $approvalStmt = $pdo->prepare("SELECT la.*, 
                                                  ws.step_name,
                                                  r.role_name,
                                                  e.employee_first_name,
                                                  e.employee_last_name,
                                                  ast.status_name as approval_status_name
                                           FROM tbl_csdl_loan_approvals la
                                           LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = la.approval_step_id
                                           LEFT JOIN tbl_csdl_roles r ON r.role_id = la.approval_role_id
                                           LEFT JOIN tbl_csdl_employees e ON e.employee_id = la.approval_processed_by
                                           LEFT JOIN tbl_csdl_approval_statuses ast ON ast.status_id = la.approval_status_id
                                           WHERE la.approval_loan_id = ?
                                           ORDER BY la.approval_created_at DESC");
            if ($approvalStmt) {
                $approvalStmt->execute([$loanId]);
                $loan['approvals'] = $approvalStmt->fetchAll(PDO::FETCH_ASSOC);
            } else {
                $loan['approvals'] = [];
            }
            
            // Get tracking history
            $trackStmt = $pdo->prepare("SELECT lt.*, 
                                               ws.step_name,
                                               lt.loan_tracking_step_id,
                                               lt.loan_tracking_action,
                                               lt.loan_tracking_remarks,
                                               lt.loan_tracking_created_at
                                        FROM tbl_csdl_loan_tracking lt
                                        LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = lt.loan_tracking_step_id
                                        WHERE lt.loan_tracking_loan_id = ?
                                        ORDER BY lt.loan_tracking_created_at DESC");
            if ($trackStmt) {
                $trackStmt->execute([$loanId]);
                $loan['tracking'] = $trackStmt->fetchAll(PDO::FETCH_ASSOC);
            } else {
                $loan['tracking'] = [];
            }
            
            echo json_encode(['success' => true, 'loan' => $loan], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Loan details error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error fetching loan details'], JSON_UNESCAPED_UNICODE);
        }
        return;
    }
    
    if ($action === 'filters') {
        try {
            // Get semesters
            $semesterStmt = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id");
            $semesters = $semesterStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Get school years (only active ones)
            $syStmt = $pdo->query("SELECT sy_id, sy_code FROM tbl_csdl_school_years WHERE sy_status = 1 ORDER BY sy_id DESC");
            $schoolYears = $syStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Get application periods
            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods WHERE app_period_status = 1 ORDER BY app_period_id");
            $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC);

            $campusStmt = $pdo->query("SELECT campus_id, campus_name FROM tbl_csdl_campuses WHERE campus_status = 1 ORDER BY campus_name");
            $campuses = $campusStmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'semesters' => $semesters,
                'schoolYears' => $schoolYears,
                'periods' => $periods,
                'campuses' => $campuses
            ]);
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Error fetching filters']);
        }
        return;
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Read JSON input for POST requests if $_POST is empty
    $input = json_decode(file_get_contents('php://input'), true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    
    // Use the shared CSRF validator. Its CSRF_INVALID response lets ApiService
    // refresh an expired token and safely retry the request once.
    CSRFProtection::validateRequest();
    
    $action = $_POST['action'] ?? '';

    if ($action === 'archive' || $action === 'restore') {
        RBAC::requirePermission($employeeId, 'csdl.loans.approve', 'You do not have permission to manage archived loans');
        $rawIds = $_POST['loanIds'] ?? (isset($_POST['loanId']) ? [$_POST['loanId']] : []);
        if (!is_array($rawIds) || count($rawIds) < 1 || count($rawIds) > 100) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Select between 1 and 100 applications']);
            return;
        }
        $loanIds = array_values(array_unique(array_map('intval', $rawIds)));
        if (count($loanIds) !== count($rawIds) || in_array(0, $loanIds, true) || min($loanIds) < 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid application selection']);
            return;
        }
        try {
            $pdo->beginTransaction();
            $select = $pdo->prepare('SELECT loan_id, loan_application_no, loan_status_id, loan_payment_status_id, loan_amount_can_pay, loan_recorded_payment_amount, loan_archived_at FROM tbl_csdl_loans WHERE loan_id = ? FOR UPDATE');
            $update = $pdo->prepare($action === 'archive'
                ? 'UPDATE tbl_csdl_loans SET loan_archived_at = NOW(), loan_archived_by = ? WHERE loan_id = ? AND loan_archived_at IS NULL'
                : 'UPDATE tbl_csdl_loans SET loan_archived_at = NULL, loan_archived_by = NULL WHERE loan_id = ? AND loan_archived_at IS NOT NULL');
            foreach ($loanIds as $loanId) {
                $select->execute([$loanId]);
                $loan = $select->fetch(PDO::FETCH_ASSOC);
                if (!$loan) throw new RuntimeException("Application #{$loanId} was not found");
                $number = (string) ($loan['loan_application_no'] ?: "#{$loanId}");
                if ($action === 'archive') {
                    if ($loan['loan_archived_at'] !== null) throw new RuntimeException("{$number} is already archived");
                    $status = (int) $loan['loan_status_id'];
                    $paid = (float) ($loan['loan_recorded_payment_amount'] ?? 0);
                    $due = (float) ($loan['loan_amount_can_pay'] ?? 0);
                    $cancelledWithoutPayment = $status === 9 && (int) $loan['loan_payment_status_id'] === 1 && $paid <= 0;
                    $completedAndPaid = $status === 5 && (int) $loan['loan_payment_status_id'] === 3 && $due > 0 && $paid >= $due;
                    if (!$cancelledWithoutPayment && !$completedAndPaid) {
                        throw new RuntimeException("{$number} is still active or has an outstanding payment");
                    }
                    $update->execute([$employeeId, $loanId]);
                } else {
                    if ($loan['loan_archived_at'] === null) throw new RuntimeException("{$number} is not archived");
                    $update->execute([$loanId]);
                }
                if ($update->rowCount() !== 1) throw new RuntimeException("{$number} could not be updated");
            }
            $audit = $pdo->prepare('INSERT INTO tbl_csdl_audit_log (audit_log_employee_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent) VALUES (?, ?, ?, ?, ?, ?)');
            $audit->execute([$employeeId, $action === 'archive' ? 'archive_loans' : 'restore_loans', count($loanIds), json_encode(['loan_ids' => $loanIds]), $_SERVER['REMOTE_ADDR'] ?? null, $_SERVER['HTTP_USER_AGENT'] ?? null]);
            $pdo->commit();
            echo json_encode(['success' => true, 'updated' => count($loanIds), 'message' => count($loanIds) . ' application(s) ' . ($action === 'archive' ? 'archived' : 'restored')]);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('CSDL archive action: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to update archived applications']);
        }
        return;
    }
    
    if ($action === 'verifyDocument') {
        RBAC::requirePermission($employeeId, 'csdl.loans.approve', 'You do not have permission to verify loan documents');
        $loanId = intval($_POST['loanId'] ?? 0);
        $documentId = intval($_POST['documentId'] ?? 0);
        
        if ($loanId <= 0 || $documentId <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid loan ID or document ID']);
            return;
        }
        
        try {
            $pdo->beginTransaction();
            $checkStmt = $pdo->prepare("SELECT d.loan_document_id, r.review_status,
                                              l.loan_current_step_id, l.loan_status_id
                                       FROM tbl_csdl_loan_documents d
                                       JOIN tbl_csdl_loans l ON l.loan_id = d.loan_document_loan_id
                                       JOIN tbl_csdl_loan_document_reviews r ON r.review_document_id = d.loan_document_id
                                       WHERE d.loan_document_id = ? AND d.loan_document_loan_id = ? FOR UPDATE");
            $checkStmt->execute([$documentId, $loanId]);
            $document = $checkStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$document || $document['review_status'] !== 'pending'
                || (int) $document['loan_current_step_id'] !== 1 || (int) $document['loan_status_id'] !== 1) {
                throw new RuntimeException('This document is not pending CSDL review.');
            }
            $review = $pdo->prepare("UPDATE tbl_csdl_loan_document_reviews
                SET review_status = 'reviewed', review_employee_id = ?, review_completed_at = NOW()
                WHERE review_document_id = ? AND review_status = 'pending'");
            $review->execute([$employeeId, $documentId]);
            $tracking = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking
                (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by)
                VALUES (?, 1, 'Guardian ID Reviewed', 'CSDL staff inspected the submitted guardian ID. Issuer authenticity is not established by AI.', ?)");
            $tracking->execute([$loanId, $employeeId]);
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Guardian ID review recorded.']);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(500);
            error_log('CSDL guardian ID review error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Unable to record the review.']);
        }
        return;
    }
    
    // This workflow no longer supports Bukas endorsements. Keep an explicit
    // response so an old browser tab cannot accidentally invoke legacy code.
    if ($action === 'endorseToBukas') {
        http_response_code(410);
        echo json_encode(['success' => false, 'message' => 'Endorsement to Bukas is no longer available.']);
        return;

        RBAC::requirePermission($employeeId, 'csdl.loans.endorse', 'You do not have permission to endorse loans');
        $loanId = intval($_POST['loanId'] ?? 0);
        $reference = trim($_POST['reference'] ?? 'BUKAS-REF');
        $title = trim($_POST['title'] ?? 'EXTEND your tuition payment with a Bukas Tuition Plan!');
        $description = trim($_POST['description'] ?? 'Hi! Referred to Bukas for tuition installment assistance.');
        $learnMoreUrl = trim($_POST['learnMoreUrl'] ?? 'https://www.bukas.ph');
        $imagePath = trim($_POST['imagePath'] ?? 'uploads/images/June-2023-MK-Enrollment-1-1.jpg');
        $contactChannel = $_POST['contactChannel'] ?? 'Email'; // Default to Email
        $dateContacted = $_POST['dateContacted'] ?? date('Y-m-d H:i:s'); // Default to current date/time
        $remarks = trim($_POST['remarks'] ?? '');
        
        if ($loanId <= 0 || empty($remarks)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Missing required fields: Remarks are required']);
            return;
        }
        
        try {
            $pdo->beginTransaction();
            
            // Get current loan info with student name
            $loanStmt = $pdo->prepare("SELECT l.*, 
                                              s.student_school_id,
                                              s.student_email,
                                              s.student_personal_email,
                                              s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
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
            
            // If description is empty, create personalized description with student name
            if (empty($description)) {
                $studentName = trim($loan['student_name'] ?? '');
                $baseDescription = 'Referred to Bukas for tuition installment assistance.';
                $description = $studentName ? "Hi {$studentName}! {$baseDescription}" : "Hi! {$baseDescription}";
            }
            
            $userId = $_SESSION['user_id'] ?? 0;
            $userRoleId = $_SESSION['user_role_id'] ?? 0;
            $currentStepId = $loan['loan_current_step_id'];
            
            // Verify image path exists (use default if not found)
            $fullImagePath = __DIR__ . '/../../' . $imagePath;
            if (!file_exists($fullImagePath)) {
                $imagePath = 'uploads/images/June-2023-MK-Enrollment-1-1.jpg';
            }
            
            // Format date contacted
            $dateContactedFormatted = null;
            if (!empty($dateContacted)) {
                $timestamp = strtotime($dateContacted);
                if ($timestamp !== false) {
                    $dateContactedFormatted = date('Y-m-d H:i:s', $timestamp);
                }
            }
            
            // Update loan status and step
            $updateStmt = $pdo->prepare("UPDATE tbl_csdl_loans 
                                       SET loan_status_id = 4, 
                                           loan_current_step_id = 6,
                                           loan_updated_by = ?,
                                           loan_updated_at = NOW(),
                                           loan_due_date = COALESCE(loan_due_date, DATE_ADD(DATE(loan_application_date), INTERVAL 30 DAY), DATE_ADD(CURDATE(), INTERVAL 30 DAY))
                                       WHERE loan_id = ?");
            $updateStmt->execute([$userId, $loanId]);
            
            // Create or update approval record
            $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?");
            $checkApprovalStmt->execute([$loanId, $currentStepId, $userRoleId]);
            $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existingApproval) {
                $approvalSql = "UPDATE tbl_csdl_loan_approvals 
                               SET approval_step_id = 6,
                                   approval_amount_approved = NULL,
                                   approval_processed_by = ?,
                                   approval_date_processed = NOW(),
                                   approval_channel_used = ?,
                                   approval_date_contacted = ?,
                                   approval_remarks = ?,
                                   approval_status_id = 4,
                                   approval_approved_email = ?,
                                   approval_updated_at = NOW()
                               WHERE approval_id = ?";
                $approvedEmail = ($contactChannel === 'Email') ? 1 : 0;
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([
                    $userId,
                    $contactChannel ?: null,
                    $dateContactedFormatted,
                    $remarks,
                    $approvedEmail,
                    $existingApproval['approval_id']
                ]);
            } else {
                $approvalSql = "INSERT INTO tbl_csdl_loan_approvals 
                               (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, 
                                approval_processed_by, approval_date_processed, approval_channel_used, 
                                approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email, approval_created_at)
                               VALUES (?, 6, ?, NULL, ?, NOW(), ?, ?, ?, 4, ?, NOW())";
                $approvedEmail = ($contactChannel === 'Email') ? 1 : 0;
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([
                    $loanId,
                    $userRoleId,
                    $userId,
                    $contactChannel ?: null,
                    $dateContactedFormatted,
                    $remarks,
                    $approvedEmail
                ]);
            }
            
            // Create or update bukas endorsement record
            $checkBukasStmt = $pdo->prepare("SELECT bukas_id FROM tbl_csdl_bukas_endorsements WHERE bukas_loan_id = ?");
            $checkBukasStmt->execute([$loanId]);
            $existingBukas = $checkBukasStmt->fetch(PDO::FETCH_ASSOC);
            
            if ($existingBukas) {
                $bukasSql = "UPDATE tbl_csdl_bukas_endorsements 
                            SET bukas_reference = ?,
                                bukas_title = ?,
                                bukas_description = ?,
                                bukas_learn_more_url = ?,
                                bukas_image_path = ?,
                                bukas_endorsement_date = CURDATE(),
                                bukas_processed_by = ?,
                                bukas_updated_at = NOW()
                            WHERE bukas_id = ?";
                $bukasStmt = $pdo->prepare($bukasSql);
                $bukasStmt->execute([
                    $reference,
                    $title,
                    $description ?: null,
                    $learnMoreUrl ?: null,
                    $imagePath ?: null,
                    $userId,
                    $existingBukas['bukas_id']
                ]);
            } else {
                $bukasSql = "INSERT INTO tbl_csdl_bukas_endorsements 
                            (bukas_loan_id, bukas_reference, bukas_title, bukas_description, 
                             bukas_learn_more_url, bukas_image_path, bukas_endorsement_date, bukas_processed_by, bukas_created_at)
                            VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?, NOW())";
                $bukasStmt = $pdo->prepare($bukasSql);
                $bukasStmt->execute([
                    $loanId,
                    $reference,
                    $title,
                    $description ?: null,
                    $learnMoreUrl ?: null,
                    $imagePath ?: null,
                    $userId
                ]);
            }
            
            // Add tracking entry
            $trackingSql = "INSERT INTO tbl_csdl_loan_tracking 
                           (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by)
                           VALUES (?, 6, 'Endorsed to Bukas', ?, ?)";
            $trackStmt = $pdo->prepare($trackingSql);
            $trackStmt->execute([$loanId, $remarks, $loan['loan_student_id']]);

            // Create notification for student about Bukas endorsement
            $studentId = (int)$loan['loan_student_id'];
            $applicationNo = $loan['loan_application_no'] ?? '';
            $studentNotifTitle = 'Loan Endorsed to Bukas';
            $studentNotifMessage = "Loan {$applicationNo} endorsed to Bukas.";

            $studentNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                              (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                               notification_title, notification_message, notification_sent_at) 
                                              VALUES (?, ?, 6, ?, ?, NOW())");
            $studentNotifStmt->execute([$studentId, $loanId, $studentNotifTitle, $studentNotifMessage]);

            // Get notification ID for push notification
            $studentNotificationId = (int)$pdo->lastInsertId();

            // Send push notification to student
            sendPushNotification($pdo, $studentId, 'student', [
                'id' => $studentNotificationId,
                'title' => $studentNotifTitle,
                'message' => $studentNotifMessage,
                'loanId' => $loanId
            ]);
            
            // Send email and push notifications
            sendLoanNotifications($pdo, $loan, 'endorsed_to_bukas', $applicationNo, null, senderRole: 'csdl');
            
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Loan endorsed to Bukas successfully']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            http_response_code(500);
            error_log('Bukas endorsement error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error endorsing loan to Bukas']);
        }
        return;
    }
    
    // CSDL is the first reviewer for all campuses. A CSDL approval is allowed
    // only when the remaining-balance threshold is within CSDL authority.
    if ($action === 'process') {
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $processType = strtolower(trim((string) ($_POST['processType'] ?? '')));
        $remarks = trim((string) ($_POST['remarks'] ?? ''));
        $amountApproved = (float) ($_POST['amountApproved'] ?? 0);

        if ($processType === 'endorse') {
            $remarks = '';
        }

        if ($loanId <= 0 || !in_array($processType, ['approve', 'endorse', 'return'], true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid loan action.']);
            return;
        }

        $permissionByAction = [
            'approve' => 'csdl.loans.approve',
            'endorse' => 'csdl.loans.approve',
            'return' => 'csdl.loans.return',
        ];
        RBAC::requirePermission($employeeId, $permissionByAction[$processType], 'You do not have permission to perform this loan action');

        try {
            $pdo->beginTransaction();

            $loanStmt = $pdo->prepare("SELECT l.*, s.student_campus_id, s.student_email, s.student_personal_email, s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                                              b.balance_current_balance, b.balance_total_balance
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                       WHERE l.loan_id = ? FOR UPDATE");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            if (!$loan) {
                throw new RuntimeException('Loan not found.');
            }
            if ((int) $loan['loan_current_step_id'] !== 1 || (int) $loan['loan_status_id'] !== 1) {
                throw new RuntimeException('This loan is no longer waiting for CSDL review.');
            }
            if ($processType !== 'return') {
                $pendingReview = $pdo->prepare("SELECT 1 FROM tbl_csdl_loan_document_reviews r
                    JOIN tbl_csdl_loan_documents d ON d.loan_document_id = r.review_document_id
                    WHERE d.loan_document_loan_id = ? AND r.review_status = 'pending' LIMIT 1");
                $pendingReview->execute([$loanId]);
                if ($pendingReview->fetchColumn()) {
                    throw new RuntimeException('Review the guardian ID before approving or endorsing this application.');
                }
            }

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

            if ($processType === 'approve') {
                $approvalAmount = resolveLoanApprovedAmount($pdo, $loanId, $amountApproved, (float) ($loan['loan_amount_can_pay'] ?? 0));
                if ($approvalAmount <= 0) {
                    throw new InvalidArgumentException('Enter an approved amount greater than zero.');
                }
            }

            // CSDL authority is based on the balance left after the amount the
            // student committed to pay.
            $totalBalance = (float) ($loan['balance_total_balance'] ?? 0);
            $remainingBalance = max(0, $totalBalance - (float) ($loan['loan_amount_can_pay'] ?? 0));

            if ($processType === 'approve') {
                if ($remainingBalance > 3000) {
                    throw new InvalidArgumentException('Cannot approve: Remaining balance (₱' . number_format($remainingBalance, 2) . ') exceeds ₱3,000. Endorse this application to Assessment.');
                }
                $nextStepId = 2;
                $nextRoleId = 99;
                $loanStatusId = 2;
                $trackingAction = 'Loan Approved - Awaiting Payment Confirmation';
                $trackingRemarks = 'Approved amount: ₱' . number_format($approvalAmount, 2) . '. Routed to Cashier Office for payment confirmation.' . ($remarks !== '' ? ' ' . $remarks : '');
                $studentTitle = 'Loan Application Approved';
                $studentMessage = "Congratulations! Your loan application {$loan['loan_application_no']} has been approved for ₱" . number_format($approvalAmount, 2) . ". Please proceed to the Cashier's office for payment processing.";
                $emailType = 'approve';
            } elseif ($processType === 'endorse') {
                if ($remainingBalance <= 3000) {
                    throw new InvalidArgumentException('Only applications with a remaining balance above ₱3,000 can be endorsed to Assessment.');
                }
                $nextStepId = 11;
                $nextRoleId = 101;
                $loanStatusId = 1;
                $trackingAction = 'Endorsed to Assessment';
                $trackingRemarks = 'Remaining balance: ₱' . number_format($remainingBalance, 2) . '. Endorsed to Assessment for review.' . ($remarks !== '' ? ' ' . $remarks : '');
                $studentTitle = 'Loan Application Endorsed to Assessment';
                $studentMessage = "Your loan application {$loan['loan_application_no']} has been endorsed to Assessment for review.";
                $emailType = 'endorse';
            } else {
                $nextStepId = 8;
                $loanStatusId = 6;
                $approvalStatusId = 5;
                $trackingAction = 'Returned to Student';
                $trackingRemarks = $remarks !== '' ? $remarks : 'Returned to the student for revision.';
                $studentTitle = 'Loan Application Returned';
                $studentMessage = "Loan {$loan['loan_application_no']} was returned for revision. Please review the office remarks and resubmit.";
                $emailType = 'return';
            }

            $recipients = [];
            if ($nextRoleId > 0) {
                $recipientStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1');
                $recipientStmt->execute([$nextRoleId]);
                $recipients = array_map('intval', $recipientStmt->fetchAll(PDO::FETCH_COLUMN));
                error_log("[CSDL LOAN APPROVAL] Found " . count($recipients) . " active employees with role_id {$nextRoleId} for notifications");
                if ($recipients === []) {
                    throw new RuntimeException(($nextRoleId === 101 ? 'Assessment' : ($nextRoleId === 99 ? 'Cashier' : 'COO')) . ' does not have an active employee.');
                }
            }

            if ($processType === 'return') {
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 6, loan_current_step_id = 8, loan_returned_date = NOW(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$employeeId, $loanId]);
            } elseif ($loanStatusId === 2) {
                // Preserve an early SIS payment while routing the approved loan to Cashier.
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 2, loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 1 END, loan_current_step_id = ?, loan_approval_date = CURDATE(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$nextStepId, $employeeId, $loanId]);
            } else {
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 1, loan_current_step_id = ?, loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$nextStepId, $employeeId, $loanId]);
            }

            // An endorsement is a routing decision, not a CSDL approval. Keep its
            // audit trail in loan tracking and do not mark CSDL as an approver.
            if ($processType !== 'endorse') {
                $approvalCheck = $pdo->prepare('SELECT approval_id FROM tbl_csdl_loan_approvals WHERE approval_loan_id = ? AND approval_step_id = 1 AND approval_role_id = 100 ORDER BY approval_id DESC LIMIT 1');
                $approvalCheck->execute([$loanId]);
                $approvalId = (int) ($approvalCheck->fetchColumn() ?: 0);
                if ($approvalId > 0) {
                    $approvalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals SET approval_amount_approved = ?, approval_processed_by = ?, approval_date_processed = NOW(), approval_channel_used = 'Email', approval_date_contacted = NOW(), approval_remarks = ?, approval_status_id = ?, approval_approved_email = 1, approval_updated_at = NOW() WHERE approval_id = ?");
                    $approvalStmt->execute([$approvalAmount, $employeeId, $remarks, $approvalStatusId, $approvalId]);
                } else {
                    $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, approval_processed_by, approval_date_processed, approval_channel_used, approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email) VALUES (?, 1, 100, ?, ?, NOW(), 'Email', NOW(), ?, ?, 1)");
                    $approvalStmt->execute([$loanId, $approvalAmount, $employeeId, $remarks, $approvalStatusId]);
                }
            }

            // loan_tracking_updated_by is constrained to tbl_csdl_students.student_id.
            // Preserve the employee identity in the remark, and store the
            // application's student ID in the constrained tracking column.
            $trackingStmt = $pdo->prepare('INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, ?, ?, ?)');
            $trackingStmt->execute([$loanId, $nextStepId, $trackingAction, $trackingRemarks . " Processed by CSDL employee #{$employeeId}.", (int) $loan['loan_student_id']]);

            $notificationStmt = $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, ?, NOW())');
            $pushQueue = [];
            foreach ($recipients as $recipientId) {
                $officeTitle = $processType === 'endorse' ? 'Loan Endorsed to Assessment' : 'Loan Awaiting Payment';
                $officeMessage = $processType === 'endorse' ? "Loan {$loan['loan_application_no']} was endorsed by CSDL for Assessment review." : "Loan {$loan['loan_application_no']} was approved and is awaiting payment confirmation.";
                $notificationStmt->execute([$recipientId, null, $nextStepId, $loanId, $officeTitle, $officeMessage]);
                $notificationId = (int) $pdo->lastInsertId();
                error_log("[CSDL LOAN APPROVAL] Created notification ID {$notificationId} for employee {$recipientId}: {$officeTitle}");
                $pushQueue[] = [$recipientId, 'employee', $notificationId, $officeTitle, $officeMessage];
            }
            $notificationStmt->execute([null, (int) $loan['loan_student_id'], $nextStepId, $loanId, $studentTitle, $studentMessage]);
            $pushQueue[] = [(int) $loan['loan_student_id'], 'student', (int) $pdo->lastInsertId(), $studentTitle, $studentMessage];
            $pdo->commit();

            queueLoanNotifications(
                $pdo,
                $loan,
                $emailType,
                (string) $loan['loan_application_no'],
                $approvalAmount !== null ? '₱' . number_format($approvalAmount, 2) : null,
                null,
                $processType === 'endorse' ? 'Assessment Office' : null,
                senderRole: 'csdl'
            );
            foreach ($pushQueue as [$recipientId, $recipientType, $notificationId, $title, $message]) {
                sendPushNotification($pdo, $recipientId, $recipientType, ['id' => $notificationId, 'title' => $title, 'message' => $message, 'loanId' => $loanId]);
            }
            $successMessage = $processType === 'endorse'
                ? 'Loan endorsed to Assessment.'
                : ($processType === 'return'
                    ? 'Loan returned to the student.'
                    : 'Loan approved and sent to Cashier.');
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
            error_log('CSDL loan workflow: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to process this loan right now.']);
        }
        return;
    }

    if (false && $action === 'legacy_process') {
        $loanId = intval($_POST['loanId'] ?? 0);
        $processType = $_POST['processType'] ?? ''; // approve, decline, return, endorsed, endorsed_to_bukas
        $amountApproved = floatval($_POST['amountApproved'] ?? 0);
        $remarks = trim($_POST['remarks'] ?? '');
        $contactChannel = $_POST['contactChannel'] ?? 'Email'; // Default to Email
        $dateContacted = $_POST['dateContacted'] ?? date('Y-m-d H:i:s'); // Default to current date/time

        if ($processType === 'endorsed_to_bukas') {
            http_response_code(410);
            echo json_encode(['success' => false, 'message' => 'Endorsement to Bukas is no longer available.']);
            return;
        }

        if ($processType === 'approve') {
            RBAC::requirePermission($employeeId, 'csdl.loans.approve', 'You do not have permission to approve loans');
        } elseif ($processType === 'decline') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Decline is handled by the Assessment office only.']);
            return;
        } elseif ($processType === 'return') {
            RBAC::requirePermission($employeeId, 'csdl.loans.approve', 'You do not have permission to return loans');
        } elseif ($processType === 'endorsed' || $processType === 'endorsed_to_bukas') {
            RBAC::requirePermission($employeeId, 'csdl.loans.endorse', 'You do not have permission to endorse loans');
        }
        
        if ($loanId <= 0 || $processType === '' || $remarks === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Missing required fields']);
            return;
        }
        
        // Set amountApproved to NULL for decline and return actions
        // For endorsed, we might need the amount to calculate balance after payment
        if ($processType === 'decline' || $processType === 'return') {
            $amountApproved = null;
        }
        
        try {
            $pdo->beginTransaction();
            
            // Get current loan info with balance information and student details
            $loanStmt = $pdo->prepare("SELECT l.*, 
                                              s.student_school_id,
                                              s.student_email,
                                              s.student_personal_email,
                                              s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
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

            if ($processType === 'approve') {
                $amountApproved = resolveLoanApprovedAmount(
                    $pdo,
                    $loanId,
                    $amountApproved,
                    (float) ($loan['loan_amount_can_pay'] ?? 0)
                );
                if ($amountApproved <= 0) {
                    throw new Exception('Unable to determine the approved amount for this loan');
                }
            }
            
            $userId = $_SESSION['user_id'] ?? 0;
            $userRoleId = $_SESSION['user_role_id'] ?? 0;
            $currentStepId = $loan['loan_current_step_id'];
            $currentStatusId = $loan['loan_status_id'];
            
            // Get current balance (default to 0 if not found)
            $currentBalance = floatval($loan['balance_current_balance'] ?? 0);
            
            // Get existing partial payment total on this loan (may already be partially paid)
            $partialPaymentAmount = getRecordedPartialPaymentTotal($pdo, $loanId);
            
            // Determine new status and step based on process type
            $newStatusId = $currentStatusId;
            $newStepId = $currentStepId;
            $approvalStatusId = 1; // pending
            
            if ($processType === 'approve') {
                // Calculate balance after payment to validate approval eligibility
                $paymentAmount = floatval($amountApproved ?? 0);
                if ($paymentAmount <= 0) {
                    $paymentAmount = floatval($loan['loan_amount_can_pay'] ?? 0);
                }
                $balanceAfterPayment = $currentBalance - $paymentAmount - max(0, $partialPaymentAmount);
                
                // Validate approval based on current step and balance threshold
                // Step 1 (CSDL): Can only approve if balance after payment ≤ ₱3,000
                // Step 2 (Assessment): Can only approve if balance after payment ≤ ₱7,000
                // Step 4 (COO): Can approve any amount (final approval)
                if ($currentStepId == 1 && $balanceAfterPayment > 3000) {
                    throw new Exception('Cannot approve: Balance after payment (₱' . number_format($balanceAfterPayment, 2) . ') exceeds ₱3,000. Please endorse to Assessment Office instead.');
                } elseif ($currentStepId == 2 && $balanceAfterPayment > 7000) {
                    throw new Exception('Cannot approve: Balance after payment (₱' . number_format($balanceAfterPayment, 2) . ') exceeds ₱7,000. Please endorse to COO Office instead.');
                }
                
                $approvalStatusId = 2; // approved
                // When approved, always complete the loan
                $newStatusId = 2; // Approved
                $newStepId = 5; // Completed
            } elseif ($processType === 'decline') {
                $approvalStatusId = 3; // declined
                $newStatusId = 3; // Declined
                $newStepId = 7; // Declined step
            } elseif ($processType === 'return') {
                $approvalStatusId = 5; // returned
                $newStatusId = 6; // Returned
                $newStepId = 8; // Returned step
            } elseif ($processType === 'endorsed') {
                $approvalStatusId = 4; // endorsed
                $newStatusId = 7; // Endorsed (endorsed to another internal step)
                
                // Determine next step based on current step (always move forward when endorsed)
                // Step 1 (CSDL Office): Endorse to Step 2 (Assessment Office)
                // Step 2 (Assessment Office): Endorse to Step 4 (COO Office)
                // Step 3 (Branch Manager): Endorse to Step 4 (COO Office)
                if ($currentStepId == 1) {
                    // CSDL Office: Endorse to Assessment Office
                    $newStepId = 2; // Finance/Assessment Office Approval
                } elseif ($currentStepId == 2) {
                    // Assessment Office: Endorse to COO Office
                    $newStepId = 4; // COO Office Final Approval
                } elseif ($currentStepId == 3) {
                    // Branch Manager/Admin: Endorse to COO Office
                    $newStepId = 4; // COO Office Final Approval
                } else {
                    // For other steps, keep current step (shouldn't happen)
                    $newStepId = $currentStepId;
                }
            } elseif ($processType === 'endorsed_to_bukas') {
                $approvalStatusId = 4; // endorsed
                $newStatusId = 4; // Endorsed to Bukas
                $newStepId = 6; // Endorsed to BUKAS step
            }
            
            // Create or update approval record
            // Check if approval already exists for this loan/role combination (check by current step first, then by any step)
            $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?");
            $checkApprovalStmt->execute([$loanId, $currentStepId, $userRoleId]);
            $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
            
            // If not found with current step, check for any approval record for this loan/role (in case step was already updated)
            if (!$existingApproval) {
                $checkApprovalStmt2 = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                     WHERE approval_loan_id = ? AND approval_role_id = ?
                                                     ORDER BY approval_created_at DESC LIMIT 1");
                $checkApprovalStmt2->execute([$loanId, $userRoleId]);
                $existingApproval = $checkApprovalStmt2->fetch(PDO::FETCH_ASSOC);
            }
            
            // Use the CURRENT step ID for approval records to reflect which step processed the loan
            // This is important for reports - they need to know which office approved/declined/returned the loan
            $approvalStepId = $currentStepId;
            
            if ($existingApproval) {
                // Update existing approval record
                $approvalSql = "UPDATE tbl_csdl_loan_approvals 
                               SET approval_step_id = ?,
                                   approval_amount_approved = ?,
                                   approval_processed_by = ?,
                                   approval_date_processed = NOW(),
                                   approval_channel_used = ?,
                                   approval_date_contacted = ?,
                                   approval_remarks = ?,
                                   approval_status_id = ?,
                                   approval_approved_email = ?,
                                   approval_updated_at = NOW()
                               WHERE approval_id = ?";
                
                $approvedEmail = ($contactChannel === 'Email') ? 1 : 0;
                $dateContactedFormatted = date('Y-m-d H:i:s', strtotime($dateContacted));
                
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([
                    $approvalStepId,
                    $amountApproved,
                    $userId,
                    $contactChannel,
                    $dateContactedFormatted,
                    $remarks,
                    $approvalStatusId,
                    $approvedEmail,
                    $existingApproval['approval_id']
                ]);
            } else {
                // Insert new approval record
                $approvalSql = "INSERT INTO tbl_csdl_loan_approvals 
                               (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, 
                                approval_processed_by, approval_date_processed, approval_channel_used, 
                                approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email)
                               VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)";
                
                $approvedEmail = ($contactChannel === 'Email') ? 1 : 0;
                $dateContactedFormatted = date('Y-m-d H:i:s', strtotime($dateContacted));
                
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([
                    $loanId,
                    $approvalStepId,
                    $userRoleId,
                    $amountApproved,
                    $userId,
                    $contactChannel,
                    $dateContactedFormatted,
                    $remarks,
                    $approvalStatusId,
                    $approvedEmail
                ]);
            }
            
            // Update loan
            $updateSql = "UPDATE tbl_csdl_loans 
                         SET loan_status_id = ?, 
                             loan_current_step_id = ?,
                             loan_updated_by = ?,
                             loan_updated_at = NOW()";
            
            $updateParams = [$newStatusId, $newStepId, $userId];
            
            // Helper function to calculate due date
            $calculateDueDate = function() use ($loan) {
                if (!empty($loan['loan_due_date'])) {
                    return date('Y-m-d', strtotime((string) $loan['loan_due_date']));
                }
                $applicationDate = !empty($loan['loan_application_date'])
                    ? (string) $loan['loan_application_date']
                    : 'today';
                return date('Y-m-d', strtotime($applicationDate . ' +30 days'));
            };

            if ($processType === 'approve' && $newStatusId === 2) {
                $updateSql .= ", loan_approval_date = CURDATE()";
                // Set due date using calculated date
                $dueDate = $calculateDueDate();
                $updateSql .= ", loan_due_date = ?";
                $updateParams[] = $dueDate;
            } elseif ($processType === 'decline') {
                $updateSql .= ", loan_declined_date = NOW()";
            } elseif ($processType === 'return') {
                $updateSql .= ", loan_returned_date = NOW()";
                // Set due date for returned loans
                $dueDate = $calculateDueDate();
                $updateSql .= ", loan_due_date = ?";
                $updateParams[] = $dueDate;
            } elseif ($processType === 'endorsed' || $processType === 'endorsed_to_bukas') {
                // Set due date for endorsed loans
                $dueDate = $calculateDueDate();
                $updateSql .= ", loan_due_date = ?";
                $updateParams[] = $dueDate;
            }
            
            $updateSql .= " WHERE loan_id = ?";
            $updateParams[] = $loanId;
            
            $updateStmt = $pdo->prepare($updateSql);
            $updateStmt->execute($updateParams);
            
            
            // Add tracking entry
            $actionTextMap = [
                'approve' => 'Approved',
                'decline' => 'Declined',
                'return' => 'Returned',
                'endorsed' => 'Endorsed',
                'endorsed_to_bukas' => 'Endorsed to Bukas'
            ];
            $actionText = $actionTextMap[$processType] ?? ucfirst($processType);
            
            // Get student ID from loan for tracking (tracking table references students, not employees)
            $studentId = $loan['loan_student_id'];
            
            // Use new step ID for tracking to reflect the current step after the action
            // For endorsed loans, this should be the step the loan is moving TO (e.g., step 2 if endorsed from step 1)
            // For approved loans, this should be step 5 (Completed)
            // For declined loans, this should be step 7 (Declined)
            // For returned loans, this should be step 8 (Returned)
            // For endorsed to bukas, this should be step 6 (Endorsed to BUKAS)
            $trackingStepId = (int)$newStepId; // Explicitly cast to int to ensure correct type
            
            // Validate that tracking step ID is set correctly
            if ($trackingStepId <= 0) {
                error_log("Warning: Invalid tracking step ID for loan {$loanId}. newStepId: {$newStepId}, processType: {$processType}");
                // Fallback to current step ID if newStepId is invalid
                $trackingStepId = (int)$currentStepId;
            }
            
            $trackingSql = "INSERT INTO tbl_csdl_loan_tracking 
                           (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by)
                           VALUES (?, ?, ?, ?, ?)";
            $trackStmt = $pdo->prepare($trackingSql);
            $trackStmt->execute([
                $loanId,
                $trackingStepId,
                $actionText,
                $remarks,
                $studentId
            ]);

            // =========================
            // Create notifications
            // =========================

            // Prepare common data
            $applicationNo = $loan['loan_application_no'] ?? '';
            $studentName = trim($loan['student_name'] ?? '');
            $amountApprovedDisplay = null;
            if ($processType === 'approve') {
                $approvedAmountForDisplay = $amountApproved;
                if ($approvedAmountForDisplay === null || $approvedAmountForDisplay <= 0) {
                    $approvedAmountForDisplay = floatval($loan['loan_amount_can_pay'] ?? 0);
                }
                if ($approvedAmountForDisplay > 0) {
                    $amountApprovedDisplay = '₱' . number_format($approvedAmountForDisplay, 2);
                }
            }

            // Build title and message based on process type
            $studentNotifTitle = '';
            $studentNotifMessage = '';

            if ($processType === 'approve') {
                $studentNotifTitle = 'Loan Approved';
                $studentNotifMessage = "Loan {$applicationNo} approved"
                    . ($amountApprovedDisplay ? " for {$amountApprovedDisplay}" : '')
                    . ".";
            } elseif ($processType === 'decline') {
                $studentNotifTitle = 'Loan Declined';
                $studentNotifMessage = "Loan {$applicationNo} declined.";
            } elseif ($processType === 'return') {
                $studentNotifTitle = 'Loan Application Returned';
                $studentNotifMessage = "Loan {$applicationNo} returned for revision.";
            } elseif ($processType === 'endorsed') {
                $studentNotifTitle = 'Loan Endorsed to Assessment';
                $studentNotifMessage = "Loan {$applicationNo} endorsed to Assessment Office for review.";
            } elseif ($processType === 'endorsed_to_bukas') {
                $studentNotifTitle = 'Loan Endorsed to Bukas';
                $studentNotifMessage = "Loan {$applicationNo} endorsed to Bukas.";
            }

            if ($studentNotifTitle !== '' && $studentNotifMessage !== '') {
                // Insert notification for student
                $notifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                           (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                            notification_title, notification_message, notification_sent_at) 
                                           VALUES (?, ?, ?, ?, ?, NOW())");
                $notifStmt->execute([
                    $studentId,
                    $loanId,
                    $trackingStepId,
                    $studentNotifTitle,
                    $studentNotifMessage
                ]);

                // Get notification ID for push notification
                $notificationId = (int)$pdo->lastInsertId();

                // Store notification data for post-commit sending
                $postCommitStudentNotif = [
                    'userId' => $studentId,
                    'notificationId' => $notificationId,
                    'title' => $studentNotifTitle,
                    'message' => $studentNotifMessage,
                ];
            }

            // Create notifications for Assessment employees when loan is endorsed to Assessment (step 2)
            $postCommitAssessmentNotifs = [];
            if ($processType === 'endorsed' && isset($newStepId) && $newStepId == 2) {
                // Get all Assessment employees (Role 99)
                $assessmentEmployeesStmt = $pdo->prepare("SELECT employee_id FROM tbl_csdl_employees 
                                                       WHERE employee_role_id = 99 AND employee_status = 1");
                $assessmentEmployeesStmt->execute();
                $assessmentEmployees = $assessmentEmployeesStmt->fetchAll(PDO::FETCH_ASSOC);
                
                if (!empty($assessmentEmployees)) {
                    $assessmentNotifTitle = 'New Loan Application Endorsed to Assessment';
                    $loanAmount = floatval($loan['loan_amount_can_pay'] ?? 0);
                    $assessmentNotifMessage = "New loan: {$studentName} ({$applicationNo}), ₱" . number_format($loanAmount, 2) . ".";
                    
                    $assessmentNotifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                                       (notification_employee_id, notification_loan_id, notification_workflow_step_id,
                                                        notification_title, notification_message, notification_sent_at) 
                                                       VALUES (?, ?, 2, ?, ?, NOW())");
                    
                    foreach ($assessmentEmployees as $assessmentEmployee) {
                        $assessmentNotifStmt->execute([$assessmentEmployee['employee_id'], $loanId, $assessmentNotifTitle, $assessmentNotifMessage]);
                        $assessmentNotificationId = (int)$pdo->lastInsertId();
                        $postCommitAssessmentNotifs[] = [
                            'employeeId' => $assessmentEmployee['employee_id'],
                            'notificationId' => $assessmentNotificationId,
                            'title' => $assessmentNotifTitle,
                            'message' => $assessmentNotifMessage,
                        ];
                    }
                }
            }

            $pdo->commit();

            // Send push notifications and email after commit to avoid DDL implicit-commit issues
            if (isset($postCommitStudentNotif)) {
                sendPushNotification($pdo, $postCommitStudentNotif['userId'], 'student', [
                    'id' => $postCommitStudentNotif['notificationId'],
                    'title' => $postCommitStudentNotif['title'],
                    'message' => $postCommitStudentNotif['message'],
                    'loanId' => $loanId
                ]);
                queueLoanNotifications(
                    $pdo,
                    $loan,
                    $processType,
                    $applicationNo,
                    $amountApprovedDisplay,
                    null,
                    $processType === 'endorsed' ? 'Assessment Office' : null,
                    senderRole: 'csdl'
                );
            }
            foreach ($postCommitAssessmentNotifs as $fn) {
                sendPushNotification($pdo, $fn['employeeId'], 'employee', [
                    'id' => $fn['notificationId'],
                    'title' => $fn['title'],
                    'message' => $fn['message'],
                    'loanId' => $loanId
                ]);
            }
            
            echo json_encode([
                'success' => true,
                'message' => 'Loan processed successfully'
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Loan processing error: ' . $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine());
            http_response_code(500);
            echo json_encode([
                'success' => false, 
                'message' => 'Error processing loan'
            ]);
        }
        return;
    }
    
    // Keep the former CSDL endpoint closed; partial payment is handled by Assessment.
    if ($action === 'recordPartialPayment') {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Partial payment is handled by Assessment only.'
        ]);
        return;
    }
}

http_response_code(400);
echo json_encode(['success' => false, 'message' => 'Invalid request']);
