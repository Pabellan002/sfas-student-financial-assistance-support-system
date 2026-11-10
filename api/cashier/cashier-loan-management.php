<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-send-push-notification.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';
require_once __DIR__ . '/../includes/includes-loan-promised-amount.php';
require_once __DIR__ . '/../includes/includes-loan-pn-routing.php';

header('Content-Type: application/json');

// Auth check
if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// Cashier role check (role_id = 99)
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 99) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Cashier role required.']);
    exit;
}

// Initialize RBAC
RBAC::init($pdo);
$employeeId = (int) ($_SESSION['user_id'] ?? 0);
$employeeCampusStmt = $pdo->prepare('SELECT employee_campus_id FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1');
$employeeCampusStmt->execute([$employeeId]);
$employeeCampusId = (int) ($employeeCampusStmt->fetchColumn() ?: 0);

queueOverdueLoanNotifications($pdo);

// Payment Tagging is part of Cashier loan management.  Keeping these actions
// here avoids a separate PN Tagging endpoint after the page was removed.
$cashierPaymentAction = $_GET['action'] ?? ($_POST['action'] ?? '');
if (in_array($cashierPaymentAction, ['payment_tagging_list', 'payment_tagging_stats', 'payment_tagging_filters', 'payment_tagging_mark_paid', 'payment_tagging_mark_partial', 'payment_tagging_mark_paid_pending'], true)) {
    if (in_array($cashierPaymentAction, ['payment_tagging_mark_paid', 'payment_tagging_mark_partial', 'payment_tagging_mark_paid_pending'], true)) {
        CSRFProtection::validateRequest();
    }
    serveCashierPaymentTagging($pdo, $employeeId, $employeeCampusId, $cashierPaymentAction);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';
    if ($action === 'details') {
        RBAC::requireAnyPermission(
            $employeeId,
            ['cashier.loans.view'],
            'You do not have permission to view loan details'
        );
    } else {
        RBAC::requirePermission($employeeId, 'cashier.loans.view', 'You do not have permission to view loans');
    }
    
    if ($action === 'filters') {
        try {
            // Get statuses
            $statusStmt = $pdo->query("SELECT loan_status_id, loan_status_name FROM tbl_csdl_loan_statuses ORDER BY loan_status_id");
            $statuses = $statusStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Get application periods (only active ones)
            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods WHERE app_period_status = 1 ORDER BY app_period_id");
            $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC);

            // Reference lists for filters (Finance role cannot call masterfiles APIs — those require masterfile read)
            $semesterStmt = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id");
            $semesters = $semesterStmt->fetchAll(PDO::FETCH_ASSOC);

            $syStmt = $pdo->query(
                "SELECT sy.sy_id AS id, sy.sy_code AS code
                 FROM tbl_csdl_school_years sy
                 ORDER BY sy.sy_code ASC"
            );
            $schoolYears = $syStmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'statuses' => $statuses,
                'periods' => $periods,
                'semesters' => $semesters,
                'schoolYears' => $schoolYears
            ]);
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Error fetching filters']);
        }
        return;
    }
    
    if ($action === 'stats') {
        // Prevent caching
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('Pragma: no-cache');
        header('Expires: 0');
        
        try {
            // Pending: Loans at Finance step (step 2) with Pending status
            $pendingStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE l.loan_current_step_id = 2 AND l.loan_status_id = 1 AND s.student_campus_id = ?");
            $pendingStmt->execute([$employeeCampusId]);
            $pending = (int) $pendingStmt->fetchColumn();
            
            // Overdue: Loans at Finance step with expiry timestamp in the past
            $overdueStmt = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                              WHERE l.loan_current_step_id = 2 AND l.loan_status_id = 1
                                              AND l.loan_expiry_timestamp IS NOT NULL AND l.loan_expiry_timestamp < NOW()
                                              AND s.student_campus_id = ?");
            $overdueStmt->execute([$employeeCampusId]);
            $overdue = (int) $overdueStmt->fetchColumn();
            
            echo json_encode([
                'success' => true,
                'stats' => [
                    'pending' => $pending,
                    'overdue' => $overdue
                ]
            ]);
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Error fetching stats']);
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
            $docStmt = $pdo->prepare("SELECT ld.*, dt.doc_type_name 
                                      FROM tbl_csdl_loan_documents ld
                                      LEFT JOIN tbl_csdl_document_types dt ON dt.doc_type_id = ld.loan_document_doc_type_id
                                      WHERE ld.loan_document_loan_id = ?");
            if ($docStmt) {
                $docStmt->execute([$loanId]);
                $loan['documents'] = $docStmt->fetchAll(PDO::FETCH_ASSOC);
            } else {
                $loan['documents'] = [];
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
            echo json_encode(['success' => false, 'message' => 'Error fetching loan details. Please try again.'], JSON_UNESCAPED_UNICODE);
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
            $search = trim($_GET['search'] ?? '');
            
            // Finance view: show loans at step 2 with Pending status.
            $where = ['s.student_campus_id = ?'];
            $params = [$employeeCampusId];
            
            // Base condition: step 2 and status 1
            $where[] = 'l.loan_current_step_id = 2';
            $where[] = 'l.loan_status_id = 1';
            
            // Build the WHERE clause
            if ($statusFilter === 'overdue') {
                // Overdue: past expiry timestamp
                $where[] = 'l.loan_expiry_timestamp IS NOT NULL';
                $where[] = 'l.loan_expiry_timestamp < NOW()';
            } elseif ($statusFilter !== '') {
                // Override the status filter to only allow pending.
                if (in_array($statusFilter, ['1'], true)) {
                    // Remove the IN clause and add specific status
                    array_pop($where); // Remove the IN clause
                    $where[] = 'l.loan_status_id = ?';
                    $params[] = $statusFilter;
                }
            }
            
            if ($periodFilter !== '') {
                $where[] = 'l.loan_app_period_id = ?';
                $params[] = $periodFilter;
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
            
            if ($search !== '') {
                $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_last_name, ", ", s.student_first_name) LIKE ?)';
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
            $sql = "SELECT 
                        l.loan_id,
                        l.loan_application_no AS applicationNo,
                        s.student_school_id AS schoolId,
                        CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                        l.loan_amount_can_pay AS amount,
                        l.loan_amount_can_pay AS amountCanPay,
                        b.balance_total_balance,
                        b.balance_advice_to_pay,
                        COALESCE(b.balance_current_balance, 0) AS balance,
                        l.loan_status_id AS statusId,
                        ls.loan_status_name AS statusName,
                        l.loan_current_step_id AS stepId,
                        ws.step_name AS stepName,
                        l.loan_application_date AS dateApplied,
                        l.loan_due_date AS dueDate,
                        l.loan_promised_payment_date AS paymentDate,
                        COALESCE(l.loan_updated_at, l.loan_application_date) AS dateUpdated,
                        l.loan_expiry_timestamp AS expiryTimestamp,
                        (SELECT approval_pn_tagging FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL ORDER BY approval_pn_date_processed DESC LIMIT 1) as pnStatus
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                    WHERE {$whereClause}
                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                    LIMIT ? OFFSET ?";
            
            $params[] = $perPage;
            $params[] = $offset;
            
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
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
            error_log('Finance loan list error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching loans. Please try again.']);
        }
        return;
    }
    
    // Default action (backward compatibility)
    try {
        $status = trim($_GET['status'] ?? '');
        $search = trim($_GET['search'] ?? '');
        $limit = min(300, max(20, intval($_GET['limit'] ?? 200)));

        // Finance view: default to loans endorsed to Finance (step 2, status 8); allow optional status filter
        $params = [$employeeCampusId];
        $where = ['l.loan_current_step_id = 2', 's.student_campus_id = ?'];
        $statusFilter = ($status !== '') ? $status : '8';
        if ($statusFilter !== '') {
            $where[] = 'l.loan_status_id = ?';
            $params[] = $statusFilter;
        }

        if ($search !== '') {
            $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_last_name, ", ", s.student_first_name) LIKE ?)';
            $searchParam = '%' . $search . '%';
            $params[] = $searchParam;
            $params[] = $searchParam;
            $params[] = $searchParam;
        }

        $whereSql = implode(' AND ', $where);

        $sql = "SELECT 
                    l.loan_id,
                    l.loan_application_no AS applicationNo,
                    s.student_school_id AS schoolId,
                    CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                    l.loan_amount_can_pay AS amount,
                    l.loan_amount_can_pay AS amountCanPay,
                    b.balance_total_balance,
                    b.balance_advice_to_pay,
                    COALESCE(b.balance_current_balance, 0) AS balance,
                    l.loan_status_id AS statusId,
                    ls.loan_status_name AS statusName,
                    l.loan_current_step_id AS stepId,
                    ws.step_name AS stepName,
                    l.loan_application_date AS dateApplied,
                    l.loan_due_date AS dueDate,
                    COALESCE(l.loan_updated_at, l.loan_application_date) AS dateUpdated,
                    l.loan_expiry_timestamp AS expiryTimestamp,
                    (SELECT approval_pn_tagging FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL ORDER BY approval_pn_date_processed DESC LIMIT 1) as pnStatus
                FROM tbl_csdl_loans l
                JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                WHERE {$whereSql}
                ORDER BY l.loan_application_date DESC, l.loan_id DESC
                LIMIT ?";

        $params[] = $limit;
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode(['success' => true, 'data' => $rows]);
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Error fetching loans']);
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    CSRFProtection::validateRequest();
    // Read JSON input
    $input = file_get_contents('php://input');
    $data = json_decode($input, true);
    
    // Fallback to $_POST if JSON decode fails
    if (json_last_error() !== JSON_ERROR_NONE) {
        $data = $_POST;
    }
    
    $action = $data['action'] ?? '';
    
    // New workflow: Cashier decides at step 2, then sends the application to
    // Assessment for PN tagging and payment confirmation.
    if ($action === 'process') {
        // Role 99 is Cashier; its current database grant retains this key.
        RBAC::requirePermission($employeeId, 'cashier.loans.approve', 'You do not have permission to process loans');
        $loanId = (int) ($data['loanId'] ?? 0);
        $processType = strtolower(trim((string) ($data['processType'] ?? '')));
        $remarks = trim((string) ($data['remarks'] ?? ''));
        $amountApproved = (float) ($data['amountApproved'] ?? 0);
        $partialAmount = (float) ($data['partialPaymentAmount'] ?? 0);
        $partialDueDate = trim((string) ($data['partialPaymentDueDate'] ?? ''));
        if ($loanId <= 0 || !in_array($processType, ['approve', 'partial'], true)) {
            http_response_code(400); echo json_encode(['success' => false, 'message' => 'Invalid loan action.']); exit;
        }

        try {
            $pdo->beginTransaction();
            $campusStmt = $pdo->prepare('SELECT employee_campus_id, CONCAT_WS(" ", employee_first_name, employee_middle_name, employee_last_name) AS employee_name FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1');
            $campusStmt->execute([$employeeId]);
            $empData = $campusStmt->fetch(PDO::FETCH_ASSOC);
            $campusId = (int) ($empData['employee_campus_id'] ?? 0);
            $employeeName = trim($empData['employee_name'] ?? 'Unknown Employee');
            if ($campusId <= 0) throw new RuntimeException('Your employee account does not have an active campus assignment.');

            $loanStmt = $pdo->prepare("SELECT l.*, s.student_campus_id, s.student_email, s.student_personal_email, s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                                              b.balance_current_balance
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                       WHERE l.loan_id = ? FOR UPDATE");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            if (!$loan) throw new RuntimeException('Loan application not found.');
            if ((int) $loan['loan_current_step_id'] !== 2 || (int) $loan['loan_status_id'] !== 1) throw new RuntimeException('This loan is no longer waiting for Cashier review.');

            $assessmentStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = 101 AND employee_status = 1');
            $assessmentStmt->execute();
            $assessmentRecipients = array_map('intval', $assessmentStmt->fetchAll(PDO::FETCH_COLUMN));
            if ($assessmentRecipients === []) throw new RuntimeException('Assessment does not have an active employee.');

            $approvalStatusId = 2;
            $approvalAmount = null;
            $loanStatusId = 1;
            $trackingAction = 'Approved and Routed';
            $trackingRemarks = '';
            $studentTitle = 'Loan Application Approved';
            $studentMessage = "Congratulations! Your loan application {$loan['loan_application_no']} has been reviewed and approved. It is now waiting for PN tagging. We will notify you once the next step is completed.";
            $emailType = 'approve';
            if ($processType === 'approve') {
                $approvalAmount = resolveLoanApprovedAmount($pdo, $loanId, $amountApproved, (float) ($loan['loan_amount_can_pay'] ?? 0));
                if ($approvalAmount <= 0) throw new InvalidArgumentException('Enter an approved amount greater than zero.');
                $trackingRemarks = 'Approved amount: ₱' . number_format($approvalAmount, 2) . '. Routed to Assessment Office.' . ($remarks !== '' ? ' ' . $remarks : '');
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 2, loan_payment_status_id = 3, loan_current_step_id = 11, loan_approval_date = CURDATE(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$employeeId, $loanId]);
            } else {
                if ($partialAmount <= 0) throw new InvalidArgumentException('Enter a partial-payment amount greater than zero.');
                $partialDueDate = !empty($loan['loan_due_date'])
                    ? date('Y-m-d', strtotime((string) $loan['loan_due_date']))
                    : date('Y-m-d', strtotime((string) ($loan['loan_application_date'] ?? 'today') . ' +30 days'));
                if ((float) ($loan['balance_current_balance'] ?? 0) > 0 && $partialAmount > (float) $loan['balance_current_balance']) throw new InvalidArgumentException('The partial payment cannot be greater than the current balance.');
                $approvalAmount = $partialAmount; $loanStatusId = 11; $trackingAction = 'Partial Payment Required';
                $trackingRemarks = 'Student declared ₱' . number_format((float) ($loan['loan_amount_can_pay'] ?? 0), 2) . '. Required partial payment: ₱' . number_format($partialAmount, 2) . ". Due: {$partialDueDate}." . ($remarks !== '' ? ' ' . $remarks : '');
                $studentTitle = 'Partial Payment Required';
                $studentMessage = "Loan {$loan['loan_application_no']} requires a partial payment of ₱" . number_format($partialAmount, 2) . " on or before {$partialDueDate}.";
                $emailType = 'partial_payment';
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 11, loan_current_step_id = 11, loan_amount_can_pay = ?, loan_due_date = ?, loan_promised_payment_date = ?, loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$partialAmount, $partialDueDate, $partialDueDate, $employeeId, $loanId]);
            }

            $approvalCheck = $pdo->prepare('SELECT approval_id FROM tbl_csdl_loan_approvals WHERE approval_loan_id = ? AND approval_step_id = 2 AND approval_role_id = 99 ORDER BY approval_id DESC LIMIT 1');
            $approvalCheck->execute([$loanId]); $approvalId = (int) ($approvalCheck->fetchColumn() ?: 0);
            if ($approvalId > 0) {
                $approvalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals SET approval_amount_approved = ?, approval_processed_by = ?, approval_date_processed = NOW(), approval_channel_used = 'Email', approval_date_contacted = NOW(), approval_remarks = ?, approval_status_id = 2, approval_approved_email = 1, approval_updated_at = NOW() WHERE approval_id = ?");
                $approvalStmt->execute([$approvalAmount, $employeeId, $remarks, $approvalId]);
            } else {
                $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, approval_processed_by, approval_date_processed, approval_channel_used, approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email) VALUES (?, 2, 99, ?, ?, NOW(), 'Email', NOW(), ?, 2, 1)");
                $approvalStmt->execute([$loanId, $approvalAmount, $employeeId, $remarks]);
            }
            $trackStmt = $pdo->prepare('INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, 11, ?, ?, ?)');
            $trackStmt->execute([$loanId, $trackingAction, $trackingRemarks . " Processed by {$employeeName}.", (int) $loan['loan_student_id']]);

            $notifyStmt = $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, 11, ?, ?, ?, NOW())');
            $pushQueue = [];
            foreach ($assessmentRecipients as $recipientId) {
                $officeTitle = $processType === 'partial' ? 'Loan Awaiting PN Tagging' : 'Loan Ready for PN Tagging';
                $officeMessage = "Loan {$loan['loan_application_no']} is ready for Assessment.";
                $notifyStmt->execute([$recipientId, null, $loanId, $officeTitle, $officeMessage]);
                $pushQueue[] = [$recipientId, 'employee', (int) $pdo->lastInsertId(), $officeTitle, $officeMessage];
            }
            $notifyStmt->execute([null, (int) $loan['loan_student_id'], $loanId, $studentTitle, $studentMessage]);
            $pushQueue[] = [(int) $loan['loan_student_id'], 'student', (int) $pdo->lastInsertId(), $studentTitle, $studentMessage];
            $pdo->commit();
            queueLoanNotifications($pdo, $loan, $emailType, (string) $loan['loan_application_no'], '₱' . number_format($approvalAmount, 2), $processType === 'partial' ? date('F j, Y', strtotime($partialDueDate)) : null, senderRole: 'cashier');
            foreach ($pushQueue as [$recipientId, $recipientType, $notificationId, $title, $message]) sendPushNotification($pdo, $recipientId, $recipientType, ['id' => $notificationId, 'title' => $title, 'message' => $message, 'loanId' => $loanId]);
            echo json_encode(['success' => true, 'message' => $processType === 'partial' ? 'Partial payment requirement sent to Assessment.' : 'Loan approved and routed to Assessment.']);
        } catch (InvalidArgumentException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); http_response_code(400); echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); http_response_code(409); echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); error_log('Cashier loan workflow: ' . $e->getMessage()); http_response_code(500); echo json_encode(['success' => false, 'message' => 'Unable to process this loan right now.']);
        }
        exit;
    }

    if (false && $action === 'legacy_process') {
        $loanId = intval($data['loanId'] ?? 0);
        $processType = $data['processType'] ?? ''; // approve, decline, return, endorsed, endorsed_to_bukas
        $amountApproved = floatval($data['amountApproved'] ?? 0);
        $remarks = trim($data['remarks'] ?? '');
        $contactChannel = $data['contactChannel'] ?? 'Email'; // Default to Email
        $dateContacted = $data['dateContacted'] ?? date('Y-m-d H:i:s'); // Default to current date/time
        $pnTagging = trim($data['pnTagging'] ?? '');

        if ($processType === 'endorsed_to_bukas') {
            http_response_code(410);
            echo json_encode(['success' => false, 'message' => 'Endorsement to Bukas is no longer available.']);
            exit;
        }
        
        // Check RBAC permissions based on action
        $employeeId = (int) $_SESSION['user_id'];
        if ($processType === 'approve') {
            RBAC::requirePermission($employeeId, 'cashier.loans.approve', 'You do not have permission to approve loans');
        } elseif ($processType === 'decline' || $processType === 'return') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Decline and return are handled by the Assessment office only.']);
            exit;
        } elseif ($processType === 'endorsed' || $processType === 'endorsed_to_bukas') {
            RBAC::requirePermission($employeeId, 'cashier.loans.approve', 'You do not have permission to endorse loans');
        }
        
        if ($loanId <= 0 || $processType === '' || $remarks === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Missing required fields']);
            exit;
        }
        
        // Set amountApproved to NULL for decline and return actions
        if ($processType === 'decline' || $processType === 'return') {
            $amountApproved = null;
        }
        
        try {
            $pdo->beginTransaction();
            
            // Get current loan info with balance information and student details
            $loanStmt = $pdo->prepare("SELECT l.*, 
                                              s.student_school_id, 
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
                                              s.student_email,
                                              s.student_personal_email,
                                              s.student_contact_number,
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
            
            // Finance can only process loans at Step 2 (Finance/Assessment Office)
            if ($loan['loan_current_step_id'] != 2) {
                throw new Exception('This loan is not at the Finance/Assessment Office step. Only loans at Step 2 can be processed by Finance.');
            }
            
            $userId = $_SESSION['user_id'] ?? 0;
            $userRoleId = $_SESSION['user_role_id'] ?? 0;
            $currentStepId = $loan['loan_current_step_id'];
            $currentStatusId = $loan['loan_status_id'];
            
            // Get current balance (default to 0 if not found)
            $currentBalance = floatval($loan['balance_current_balance'] ?? 0);
            
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
                $balanceAfterPayment = $currentBalance - $paymentAmount;
                
                // Step 2 (Finance/Assessment): Can only approve if balance after payment ≤ ₱7,000
                if ($balanceAfterPayment > 7000) {
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
                
                // Step 2 (Finance/Assessment Office): Endorse to Step 4 (COO Office)
                $newStepId = 4; // COO Office Final Approval
            } elseif ($processType === 'endorsed_to_bukas') {
                $approvalStatusId = 4; // endorsed
                $newStatusId = 4; // Endorsed to Bukas
                $newStepId = 6; // Endorsed to BUKAS step
            }
            
            // Create or update approval record
            $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?");
            $checkApprovalStmt->execute([$loanId, $currentStepId, $userRoleId]);
            $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$existingApproval) {
                $checkApprovalStmt2 = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                     WHERE approval_loan_id = ? AND approval_role_id = ?
                                                     ORDER BY approval_created_at DESC LIMIT 1");
                $checkApprovalStmt2->execute([$loanId, $userRoleId]);
                $existingApproval = $checkApprovalStmt2->fetch(PDO::FETCH_ASSOC);
            }
            
            $dateContactedFormatted = null;
            if (!empty($dateContacted)) {
                $timestamp = strtotime($dateContacted);
                if ($timestamp !== false) {
                    $dateContactedFormatted = date('Y-m-d H:i:s', $timestamp);
                }
            }
            $pnDateProcessed = !empty($pnTagging) ? date('Y-m-d H:i:s') : null;
            $approvedEmail = ($contactChannel === 'Email') ? 1 : 0;
            // Use current step (2) for approval record, not the new step
            $approvalStepId = $currentStepId;
            
            if ($existingApproval) {
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
                                   approval_pn_tagging = ?,
                                   approval_pn_date_processed = ?,
                                   approval_updated_at = NOW()
                               WHERE approval_id = ?";
                
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([
                    $approvalStepId,
                    $amountApproved,
                    $userId,
                    $contactChannel ?: null,
                    $dateContactedFormatted,
                    $remarks,
                    $approvalStatusId,
                    $approvedEmail,
                    $pnTagging ?: null,
                    $pnDateProcessed,
                    $existingApproval['approval_id']
                ]);
            } else {
                $approvalSql = "INSERT INTO tbl_csdl_loan_approvals 
                               (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, 
                                approval_processed_by, approval_date_processed, approval_channel_used, 
                                approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email, approval_pn_tagging, approval_pn_date_processed)
                               VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?)";
                
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([
                    $loanId,
                    $approvalStepId,
                    $userRoleId,
                    $amountApproved,
                    $userId,
                    $contactChannel ?: null,
                    $dateContactedFormatted,
                    $remarks,
                    $approvalStatusId,
                    $approvedEmail,
                    $pnTagging ?: null,
                    $pnDateProcessed
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
                $dueDate = $calculateDueDate();
                $updateSql .= ", loan_due_date = ?";
                $updateParams[] = $dueDate;
            } elseif ($processType === 'decline') {
                $updateSql .= ", loan_declined_date = NOW()";
            } elseif ($processType === 'return') {
                $updateSql .= ", loan_returned_date = NOW()";
                $dueDate = $calculateDueDate();
                $updateSql .= ", loan_due_date = ?";
                $updateParams[] = $dueDate;
            } elseif ($processType === 'endorsed' || $processType === 'endorsed_to_bukas') {
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
            $studentId = $loan['loan_student_id'];
            $trackingStepId = (int)$newStepId;
            
            if ($trackingStepId <= 0) {
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
            
            // Create notification for student
            $notificationTitle = '';
            $notificationMessage = '';
            
            if ($processType === 'approve') {
                $notificationTitle = 'Loan Application Approved';
                $notificationMessage = "Loan {$loan['loan_application_no']} approved for ₱" . number_format($amountApproved, 2) . ".";
            } elseif ($processType === 'decline') {
                $notificationTitle = 'Loan Application Declined';
                $notificationMessage = "Loan {$loan['loan_application_no']} declined.";
            } elseif ($processType === 'return') {
                $notificationTitle = 'Loan Application Returned';
                $notificationMessage = "Loan {$loan['loan_application_no']} returned for revision.";
            } elseif ($processType === 'endorsed') {
                $notificationTitle = 'Loan Application Endorsed';
                $notificationMessage = "Loan {$loan['loan_application_no']} endorsed to COO.";
            } elseif ($processType === 'endorsed_to_bukas') {
                $notificationTitle = 'Loan Application Endorsed to Bukas';
                $notificationMessage = "Loan {$loan['loan_application_no']} endorsed to Bukas.";
            }
            
            if ($notificationTitle && $notificationMessage) {
                $notifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                           (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                            notification_title, notification_message, notification_sent_at) 
                                           VALUES (?, ?, ?, ?, ?, NOW())");
                $notifStmt->execute([
                    $studentId,
                    $loanId,
                    $trackingStepId,
                    $notificationTitle,
                    $notificationMessage
                ]);
                
                // Get notification ID for push notification
                $notificationId = (int)$pdo->lastInsertId();
                
                // Send push notification
                sendPushNotification($pdo, $studentId, 'student', [
                    'id' => $notificationId,
                    'title' => $notificationTitle,
                    'message' => $notificationMessage,
                    'loanId' => $loanId
                ]);
            }
            
            $pdo->commit();

            if ($notificationTitle && $notificationMessage) {
                require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';
                $amountDisplay = $amountApproved ? '₱' . number_format($amountApproved, 2) : null;
                queueLoanNotifications(
                    $pdo,
                    $loan,
                    $processType,
                    $loan['loan_application_no'],
                    $amountDisplay,
                    null,
                    $processType === 'endorsed' ? 'COO Office' : ($processType === 'endorsed_to_bukas' ? 'Bukas' : null),
                    senderRole: 'cashier'
                );
            }

            echo json_encode(['success' => true, 'message' => 'Loan processed successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('Finance loan process error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Unable to process loan at the moment. Please try again.']);
        }
        exit;
    }
    
    // This workflow no longer supports Bukas endorsements. Keep an explicit
    // response so an old browser tab cannot accidentally invoke legacy code.
    if ($action === 'endorseToBukas') {
        http_response_code(410);
        echo json_encode(['success' => false, 'message' => 'Endorsement to Bukas is no longer available.']);
        exit;

        RBAC::requirePermission($employeeId, 'cashier.loans.approve', 'You do not have permission to endorse loans to Bukas');
        $loanId = intval($_POST['loanId'] ?? 0);
        $reference = $_POST['reference'] ?? 'BUKAS-REF';
        $title = $_POST['title'] ?? 'EXTEND your tuition payment with a Bukas Tuition Plan!';
        $description = $_POST['description'] ?? 'Hi! Referred to Bukas for tuition installment assistance.';
        $learnMoreUrl = $_POST['learnMoreUrl'] ?? 'https://www.bukas.ph';
        $imagePath = $_POST['imagePath'] ?? 'uploads/images/June-2023-MK-Enrollment-1-1.jpg';
        $contactChannel = $_POST['contactChannel'] ?? 'System';
        $dateContacted = $_POST['dateContacted'] ?? date('Y-m-d H:i:s');
        $remarks = trim($_POST['remarks'] ?? '');
        
        if ($loanId <= 0 || !$remarks) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Missing required fields']);
            exit;
        }
        
        try {
            $pdo->beginTransaction();
            
            // Get loan info
            $loanStmt = $pdo->prepare("SELECT l.*, s.student_id, s.student_email, s.student_personal_email FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE l.loan_id = ?");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                throw new Exception('Loan not found');
            }
            
            // Finance can only process loans at Step 2
            if ($loan['loan_current_step_id'] != 2) {
                throw new Exception('This loan is not at the Finance/Assessment Office step.');
            }
            
            $userId = $_SESSION['user_id'] ?? 0;
            $userRoleId = $_SESSION['user_role_id'] ?? 0;
            
            // Process as endorsed_to_bukas
            $dateContactedFormatted = date('Y-m-d H:i:s', strtotime($dateContacted));
            
            // Update loan status
            $updateStmt = $pdo->prepare("UPDATE tbl_csdl_loans SET loan_status_id = 4, loan_current_step_id = 6, loan_updated_by = ?, loan_updated_at = NOW(), loan_due_date = ? WHERE loan_id = ?");
            $dueDate = !empty($loan['loan_due_date'])
                ? date('Y-m-d', strtotime((string) $loan['loan_due_date']))
                : date('Y-m-d', strtotime((string) ($loan['loan_application_date'] ?? 'today') . ' +30 days'));
            $updateStmt->execute([$userId, $dueDate, $loanId]);
            
            // Create approval record
            $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_processed_by, approval_date_processed, approval_channel_used, approval_date_contacted, approval_remarks, approval_status_id) VALUES (?, 6, ?, ?, NOW(), ?, ?, ?, 4)");
            $approvalStmt->execute([$loanId, $userRoleId, $userId, $contactChannel, $dateContactedFormatted, $remarks]);
            
            // Insert Bukas endorsement record
            $bukasStmt = $pdo->prepare("INSERT INTO tbl_csdl_bukas_endorsements 
                                       (bukas_loan_id, bukas_reference, bukas_title, bukas_description, 
                                        bukas_image_path, bukas_learn_more_url, bukas_endorsement_date, bukas_processed_by) 
                                       VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?)");
            $bukasStmt->execute([
                $loanId,
                $reference,
                $title,
                $description,
                $imagePath,
                $learnMoreUrl,
                $userId
            ]);
            
            // Add tracking
            $trackStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, 6, 'Endorsed to Bukas', ?, ?)");
            $trackStmt->execute([$loanId, $remarks, $loan['student_id']]);
            
            // Create Bukas notification
            $notifTitle = 'Endorsed to Bukas';
            $notifMessage = "Loan {$loan['loan_application_no']} endorsed to Bukas. {$title}";
            
            $notifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                       (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                        notification_title, notification_message, notification_sent_at) 
                                       VALUES (?, ?, 6, ?, ?, NOW())");
            $notifStmt->execute([
                $loan['student_id'],
                $loanId,
                $notifTitle,
                $notifMessage
            ]);
            
            // Get notification ID for push notification
            $notificationId = (int)$pdo->lastInsertId();
            
            // Send push notification with Bukas details
            $pushMessage = "{$title}\n\n{$description}\n\nLearn more: {$learnMoreUrl}";
            sendPushNotification($pdo, $loan['student_id'], 'student', [
                'id' => $notificationId,
                'title' => $notifTitle,
                'message' => $pushMessage,
                'loanId' => $loanId
            ]);
            
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Loan endorsed to Bukas successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('Finance Bukas endorsement error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Unable to endorse loan to Bukas at the moment. Please try again.']);
        }
        exit;
    }
    
    // Partial-payment requirements are now created through action=process.
    if ($action === 'recordPartialPayment') {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Use the Mark as Partial Paid action for loans awaiting payment at Cashier.'
        ]);
        exit;
    }
}

function serveCashierPaymentTagging(PDO $pdo, int $employeeId, int $campusId, string $action): void
{
    if ($action === 'payment_tagging_mark_partial') {
        RBAC::requirePermission($employeeId, 'cashier.loans.partial_payment', 'You do not have permission to mark partial payments.');
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $paymentAmount = round((float) ($_POST['paymentAmount'] ?? 0), 2);
        if ($loanId <= 0 || $paymentAmount <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Enter a valid partial paid amount greater than zero.']);
            return;
        }

        try {
            $pdo->beginTransaction();
            $empStmt = $pdo->prepare('SELECT CONCAT_WS(" ", employee_first_name, employee_middle_name, employee_last_name) FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1');
            $empStmt->execute([$employeeId]);
            $employeeName = trim((string) ($empStmt->fetchColumn() ?: 'Cashier'));

            $loanStmt = $pdo->prepare('SELECT l.*, s.student_email, s.student_personal_email, s.student_contact_number,
                                              CONCAT_WS(" ", s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_id = ? FOR UPDATE');
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            if (!$loan) throw new RuntimeException('Loan application not found.');
            if ((int) $loan['loan_current_step_id'] !== 2 || (int) $loan['loan_status_id'] !== 2) {
                throw new RuntimeException('This loan is not awaiting payment at Cashier.');
            }
            if (in_array((int) $loan['loan_payment_status_id'], [3, 4], true)) {
                throw new RuntimeException('This loan cannot be marked as Partial Paid in its current payment status.');
            }

            $amountCanPay = round((float) ($loan['loan_amount_can_pay'] ?? 0), 2);
            $amountAlreadyPaid = round((float) ($loan['loan_recorded_payment_amount'] ?? 0), 2);
            $remainingAmount = max(0, round($amountCanPay - $amountAlreadyPaid, 2));
            if ($amountCanPay <= 0 || $remainingAmount <= 0) {
                throw new RuntimeException('This loan has no remaining payment amount.');
            }
            if ($paymentAmount >= $remainingAmount) {
                throw new InvalidArgumentException('The partial paid amount must be less than the remaining amount of ₱' . number_format($remainingAmount, 2) . '. Use Mark as Paid for the full remaining amount.');
            }

            $totalPaid = round($amountAlreadyPaid + $paymentAmount, 2);
            $newRemainingAmount = max(0, round($amountCanPay - $totalPaid, 2));
            $pdo->prepare('UPDATE tbl_csdl_loans SET loan_payment_status_id = 5, loan_recorded_payment_amount = ?, loan_payment_recorded_at = NOW(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?')
                ->execute([$totalPaid, $employeeId, $loanId]);

            $trackingRemarks = 'Partial paid amount of ₱' . number_format($paymentAmount, 2) . " recorded by {$employeeName}. Total paid: ₱" . number_format($totalPaid, 2) . '. Remaining: ₱' . number_format($newRemainingAmount, 2) . '.';
            $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, 2, 'Paid Partial', ?, ?)")
                ->execute([$loanId, $trackingRemarks, (int) $loan['loan_student_id']]);

            $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, 2, ?, ?, ?, NOW())')
                ->execute([(int) $loan['loan_student_id'], $loanId, 'Payment Marked as Paid Partial', 'Your partial paid amount of ₱' . number_format($paymentAmount, 2) . " for loan {$loan['loan_application_no']} was recorded. Remaining payment: ₱" . number_format($newRemainingAmount, 2) . '.']);

            $pdo->commit();
            queueLoanNotifications(
                $pdo,
                $loan,
                'paid_partial',
                (string) $loan['loan_application_no'],
                '₱' . number_format($paymentAmount, 2),
                senderRole: 'cashier'
            );
            echo json_encode(['success' => true, 'message' => 'Marked as Paid Partial. Remaining payment: ₱' . number_format($newRemainingAmount, 2) . '.']);
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
            error_log('Cashier partial paid recording: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to mark the payment as Partial Paid right now.']);
        }
        return;
    }

    if ($action === 'payment_tagging_mark_paid_pending') {
        RBAC::requirePermission($employeeId, 'cashier.loans.mark_paid_pending', 'You do not have permission to mark payments as pending loan approval.');
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $paymentAmount = round((float) ($_POST['paymentAmount'] ?? 0), 2);
        if ($loanId <= 0 || $paymentAmount <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Enter a valid payment amount greater than zero.']);
            return;
        }
        try {
            $pdo->beginTransaction();
            $empStmt = $pdo->prepare('SELECT CONCAT_WS(" ", employee_first_name, employee_middle_name, employee_last_name) FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1');
            $empStmt->execute([$employeeId]);
            $employeeName = trim((string) ($empStmt->fetchColumn() ?: 'Cashier'));

            $loanStmt = $pdo->prepare('SELECT l.*, s.student_email, s.student_personal_email, s.student_contact_number,
                                              CONCAT_WS(" ", s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_id = ? FOR UPDATE');
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            if (!$loan) throw new RuntimeException('Loan application not found.');
            if (in_array((int) $loan['loan_status_id'], [5, 9], true)) throw new RuntimeException('A completed or cancelled loan cannot be marked as pending loan approval.');
            if ((int) $loan['loan_payment_status_id'] === 3) throw new RuntimeException('This payment has already been marked as paid.');
            if ((int) $loan['loan_payment_status_id'] === 4) throw new RuntimeException('This payment is already marked as pending loan approval.');

            $pdo->prepare('UPDATE tbl_csdl_loans SET loan_payment_status_id = 4, loan_recorded_payment_amount = ?, loan_payment_recorded_at = NOW(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?')
                ->execute([$paymentAmount, $employeeId, $loanId]);

            $trackingRemarks = 'Early SIS payment of ₱' . number_format($paymentAmount, 2) . " recorded by {$employeeName}. Loan remains in its current approval step.";
            $trackingStep = max(1, (int) ($loan['loan_current_step_id'] ?? 1));
            $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, 'Paid Pending', ?, ?)")
                ->execute([$loanId, $trackingStep, $trackingRemarks, (int) $loan['loan_student_id']]);

            $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, NOW())')
                ->execute([(int) $loan['loan_student_id'], $trackingStep, $loanId, 'Payment Recorded as Pending', "Your payment of ₱" . number_format($paymentAmount, 2) . " for loan {$loan['loan_application_no']} was recorded. Your loan will continue through the remaining approval steps."]);

            $pdo->commit();
            queueLoanNotifications(
                $pdo,
                $loan,
                'paid_pending',
                (string) $loan['loan_application_no'],
                '₱' . number_format($paymentAmount, 2),
                senderRole: 'cashier'
            );
            echo json_encode(['success' => true, 'message' => 'Payment recorded and marked as pending loan approval. The loan remains in its current approval step.']);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('Cashier paid-pending recording: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to record the pending payment right now.']);
        }
        return;
    }

    if ($action === 'payment_tagging_mark_paid') {
        RBAC::requirePermission($employeeId, 'cashier.loans.mark_paid', 'You do not have permission to mark payments as paid.');
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $paymentAmount = round((float) ($_POST['paymentAmount'] ?? 0), 2);
        if ($loanId <= 0 || $paymentAmount <= 0) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Enter a valid payment amount greater than zero.']);
            return;
        }
        try {
            $pdo->beginTransaction();
            
            // Get employee name for tracking
            $empStmt = $pdo->prepare('SELECT CONCAT_WS(" ", employee_first_name, employee_middle_name, employee_last_name) AS employee_name FROM tbl_csdl_employees WHERE employee_id = ?');
            $empStmt->execute([$employeeId]);
            $employeeName = trim($empStmt->fetchColumn() ?: 'Unknown Employee');
            
            $loanStmt = $pdo->prepare('SELECT l.*, s.student_campus_id, s.student_email, s.student_personal_email,
                                              s.student_contact_number,
                                              CONCAT_WS(" ", s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_id = ? FOR UPDATE');
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            if (!$loan) throw new RuntimeException('Loan application not found.');
            
            // NEW WORKFLOW: Check for loans at Cashier step (step 2) with Approved status (status 2)
            if ((int) $loan['loan_current_step_id'] !== 2 || (int) $loan['loan_status_id'] !== 2) {
                throw new RuntimeException('This loan is not awaiting payment confirmation at Cashier.');
            }

            // Check if already marked paid
            if ((int) $loan['loan_payment_status_id'] === 3) {
                throw new RuntimeException('This payment has already been marked as paid.');
            }

            $amountCanPay = round((float) ($loan['loan_amount_can_pay'] ?? 0), 2);
            $amountAlreadyPaid = round((float) ($loan['loan_recorded_payment_amount'] ?? 0), 2);
            $paymentStatusId = (int) ($loan['loan_payment_status_id'] ?? 1);
            if ($paymentStatusId === 4) {
                // Paid Pending already represents money received before final
                // approval. Confirm the stored amount without adding it again.
                $totalPaid = $amountAlreadyPaid > 0 ? $amountAlreadyPaid : $paymentAmount;
            } else {
                $remainingAmount = max(0, round($amountCanPay - $amountAlreadyPaid, 2));
                if ($amountCanPay <= 0) {
                    throw new RuntimeException('This loan has no valid payment amount.');
                }
                if ($remainingAmount > 0 && $paymentAmount > $remainingAmount) {
                    throw new InvalidArgumentException('Payment cannot be greater than the remaining amount of ₱' . number_format($remainingAmount, 2) . '.');
                }
                $totalPaid = $remainingAmount <= 0
                    ? $amountAlreadyPaid
                    : round($amountAlreadyPaid + $paymentAmount, 2);
                if ($totalPaid < $amountCanPay) {
                    throw new InvalidArgumentException('The remaining amount is ₱' . number_format($amountCanPay - $totalPaid, 2) . '. Use Mark as Partial Paid first.');
                }
            }

            // Return directly CSDL-approved loans to CSDL; other approval routes use Assessment.
            $pnOffice = resolveLoanPnTaggingOffice($pdo, $loanId);
            $pdo->prepare('UPDATE tbl_csdl_loans SET loan_payment_status_id = 3, loan_recorded_payment_amount = ?, loan_payment_recorded_at = COALESCE(loan_payment_recorded_at, NOW()), loan_paid_date = NOW(), loan_current_step_id = ?, loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?')->execute([$totalPaid, $pnOffice['step'], $employeeId, $loanId]);
            
            // The tracking field is constrained to tbl_csdl_students.student_id;
            // retain the Cashier identity in the text and save the student ID.
            $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, 'Payment Confirmed', ?, ?)")
                ->execute([$loanId, $pnOffice['step'], 'Total payment of ₱' . number_format($totalPaid, 2) . " confirmed by {$employeeName}. Sent to {$pnOffice['name']} for PN tagging.", (int) $loan['loan_student_id']]);

            $officeStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1');
            $officeStmt->execute([$pnOffice['role']]);
            $notify = $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, NOW())');
            foreach ($officeStmt->fetchAll(PDO::FETCH_COLUMN) as $recipientId) {
                $notify->execute([(int) $recipientId, $pnOffice['step'], $loanId, 'Loan Ready for PN Tagging', "Cashier confirmed payment for loan {$loan['loan_application_no']}. It is ready for PN tagging at {$pnOffice['name']}."]);
            }
            $pdo->commit();
            queueLoanNotifications(
                $pdo,
                $loan,
                'payment_confirmed',
                (string) $loan['loan_application_no'],
                '₱' . number_format($totalPaid, 2),
                destinationOffice: $pnOffice['name'],
                senderRole: 'cashier'
            );
            echo json_encode(['success' => true, 'message' => "Payment confirmed and sent to {$pnOffice['name']} for PN tagging."]);
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
            error_log('Cashier payment confirmation: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to confirm payment right now.']);
        }
        return;
    }

    RBAC::requirePermission($employeeId, 'cashier.loans.view', 'You do not have permission to access payment tagging.');
    if ($action === 'payment_tagging_filters') {
        $semesters = $pdo->query('SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id')->fetchAll(PDO::FETCH_ASSOC);
        $schoolYears = $pdo->query("SELECT sy.sy_id AS id, sy.sy_code AS code FROM tbl_csdl_school_years sy ORDER BY sy.sy_start_date DESC")->fetchAll(PDO::FETCH_ASSOC);
        $periods = $pdo->query('SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_name')->fetchAll(PDO::FETCH_ASSOC);
        $campuses = $pdo->query('SELECT campus_id, campus_name FROM tbl_csdl_campuses WHERE campus_status = 1 ORDER BY campus_name')->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['success' => true, 'semesters' => $semesters, 'schoolYears' => $schoolYears, 'periods' => $periods, 'campuses' => $campuses]);
        return;
    }

    // Cashier can view every loan across all campuses. Filters narrow the shared list.
    $filters = ['semester' => trim((string) ($_GET['semester'] ?? '')), 'schoolYear' => trim((string) ($_GET['schoolYear'] ?? '')), 'period' => trim((string) ($_GET['period'] ?? '')), 'campus' => (int) ($_GET['campus'] ?? 0), 'search' => trim((string) ($_GET['search'] ?? ''))];
    $params = [];
    $where = ['l.loan_status_id <> 9'];
    if ($filters['campus'] > 0) { $where[] = 's.student_campus_id = ?'; $params[] = $filters['campus']; }
    if ($filters['semester'] !== '') { $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = ?)'; $params[] = $filters['semester']; }
    if ($filters['schoolYear'] !== '') { $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = ?)'; $params[] = $filters['schoolYear']; }
    if ($filters['period'] !== '') { $where[] = 'l.loan_app_period_id = ?'; $params[] = $filters['period']; }
    if ($filters['search'] !== '') { $where[] = "(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_last_name, ', ', s.student_first_name, ' ', COALESCE(s.student_middle_name, '')) LIKE ?)"; $like = '%' . $filters['search'] . '%'; array_push($params, $like, $like, $like); }
    $view = trim((string) ($_GET['view'] ?? ''));
    if ($view === 'ready') $where[] = 'l.loan_current_step_id = 2 AND l.loan_status_id = 2 AND l.loan_payment_status_id IN (1, 2, 4, 5)';
    if ($view === 'paid_pending') $where[] = 'l.loan_payment_status_id = 4';
    $eligibleWhere = implode(' AND ', $where);

    if ($action === 'payment_tagging_stats') {
        $ready = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$eligibleWhere} AND l.loan_current_step_id = 2 AND l.loan_status_id = 2 AND l.loan_payment_status_id IN (1, 2, 4, 5)");
        $ready->execute($params);
        $paidPending = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$eligibleWhere} AND l.loan_payment_status_id = 4");
        $paidPending->execute($params);
        echo json_encode(['success' => true, 'stats' => ['readyForPayment' => (int) $ready->fetchColumn(), 'paidPending' => (int) $paidPending->fetchColumn()]]);
        return;
    }

    $page = max(1, (int) ($_GET['page'] ?? 1));
    $perPage = min(10000, max(10, (int) ($_GET['perPage'] ?? 25)));
    $count = $pdo->prepare("SELECT COUNT(*) FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE {$eligibleWhere}");
    $count->execute($params);
    $total = (int) $count->fetchColumn();
    $rows = cashierPaymentTaggingRows($pdo, $eligibleWhere, $params, $perPage, ($page - 1) * $perPage);
    echo json_encode(['success' => true, 'rows' => $rows, 'data' => $rows, 'total' => $total, 'page' => $page, 'perPage' => $perPage]);
}

function cashierPaymentTaggingRows(PDO $pdo, string $where, array $params, int $limit, int $offset): array
{
    $sql = "SELECT l.loan_id AS loanId, l.loan_application_no AS applicationNo, s.student_school_id AS studentId,
                   CONCAT(s.student_last_name, ', ', s.student_first_name, CASE WHEN COALESCE(s.student_middle_name, '') = '' THEN '' ELSE CONCAT(' ', s.student_middle_name) END) AS studentName,
                   COALESCE(l.loan_amount_can_pay, 0) AS amountCanPay,
                   l.loan_recorded_payment_amount AS recordedPaymentAmount,
                   l.loan_payment_recorded_at AS paymentRecordedAt,
                   UNIX_TIMESTAMP(l.loan_payment_recorded_at) AS paymentRecordedAtEpoch,
                   l.loan_status_id AS statusId,
                   l.loan_payment_status_id AS paymentStatusId,
                   l.loan_current_step_id AS stepId,
                   COALESCE(ls.loan_status_name, 'Pending') AS statusName,
                   COALESCE(ps.payment_status_name, 'Not Paid') AS paymentStatus,
                   COALESCE(pns.pn_status_name, 'Not Tagged') AS pnStatus,
                    COALESCE(ws.step_name, '-') AS currentStepName,
                    c.campus_name AS campusName,
                    l.loan_application_date AS dateApplied,
                    l.loan_due_date AS dueDate, l.loan_expiry_timestamp AS expiryTimestamp
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
            LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
            LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
            LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
            LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
            WHERE {$where} ORDER BY l.loan_updated_at DESC, l.loan_id DESC LIMIT ? OFFSET ?";
    $stmt = $pdo->prepare($sql);
    $params[] = $limit;
    $params[] = $offset;
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}
?>
