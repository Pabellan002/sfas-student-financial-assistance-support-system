<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-send-push-notification.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';
require_once __DIR__ . '/../includes/includes-loan-promised-amount.php';

header('Content-Type: application/json');

// Auth check
if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

// COO role check (role_id = 97)
$userRoleId = $_SESSION['user_role_id'] ?? 0;
if ($userRoleId != 97) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. COO role required.']);
    exit;
}

RBAC::init($pdo);
$employeeId = (int) ($_SESSION['user_id'] ?? 0);

queueOverdueLoanNotifications($pdo);

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';
    if ($action === 'details') {
        RBAC::requirePermission($employeeId, 'coo.loans.view', 'You do not have permission to view loan details');
    } else {
        RBAC::requirePermission($employeeId, 'coo.loans.view', 'You do not have permission to view loans');
    }
    
    if ($action === 'filters') {
        try {
            // Get statuses
            $statusStmt = $pdo->query("SELECT loan_status_id, loan_status_name FROM tbl_csdl_loan_statuses ORDER BY loan_status_id");
            $statuses = $statusStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Get application periods (only active ones)
            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods WHERE app_period_status = 1 ORDER BY app_period_id");
            $periods = $periodStmt->fetchAll(PDO::FETCH_ASSOC);

            $semesterStmt = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id");
            $semesters = $semesterStmt->fetchAll(PDO::FETCH_ASSOC);

            $schoolYearStmt = $pdo->query(
                "SELECT sy.sy_id, CONCAT(sy.sy_code, ' - ', sem.semester_name) AS sy_display
                 FROM tbl_csdl_school_years sy
                 LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
                 ORDER BY sy.sy_id DESC"
            );
            $schoolYears = $schoolYearStmt->fetchAll(PDO::FETCH_ASSOC);
            
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
            // Pending work: loans at COO step that are pending or endorsed to COO.
            $pending = (int) $pdo->query("SELECT COUNT(*) FROM tbl_csdl_loans l WHERE l.loan_current_step_id = 4 AND l.loan_status_id IN (1, 12)")->fetchColumn();
            
            // Overdue: Loans at COO step with past expiry timestamp
            $overdueStmt = $pdo->query("SELECT COUNT(*) FROM tbl_csdl_loans l
                                              WHERE l.loan_current_step_id = 4 AND l.loan_status_id IN (1, 12)
                                              AND l.loan_expiry_timestamp IS NOT NULL AND l.loan_expiry_timestamp < NOW()");
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
            echo json_encode(['success' => false, 'message' => 'Error fetching loan details'], JSON_UNESCAPED_UNICODE);
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
            $applicationDateFilter = trim($_GET['applicationDate'] ?? '');
            $search = trim($_GET['search'] ?? '');

            if ($applicationDateFilter !== '') {
                $dateParts = explode('-', $applicationDateFilter);
                $validDate = preg_match('/^\d{4}-\d{2}-\d{2}$/', $applicationDateFilter) === 1
                    && count($dateParts) === 3
                    && ctype_digit($dateParts[0])
                    && ctype_digit($dateParts[1])
                    && ctype_digit($dateParts[2])
                    && checkdate((int)$dateParts[1], (int)$dateParts[2], (int)$dateParts[0]);
                if (!$validDate) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid application date.']);
                    return;
                }
            }
            
            // COO view includes eligible loans from every campus.
            $where = ['l.loan_current_step_id = 4', 'l.loan_status_id IN (1, 12)'];
            $params = [];
            
            if ($statusFilter !== '') {
                if ($statusFilter === 'overdue') {
                    // Overdue: past expiry timestamp
                    array_pop($where);
                    $where[] = 'l.loan_status_id IN (1, 12)';
                    $where[] = 'l.loan_expiry_timestamp IS NOT NULL';
                    $where[] = 'l.loan_expiry_timestamp < NOW()';
                } elseif (in_array($statusFilter, ['1', '12'], true)) {
                    array_pop($where);
                    if ($statusFilter === '1') {
                        $where[] = 'l.loan_status_id IN (1, 12)';
                    } else {
                        $where[] = 'l.loan_status_id = ?';
                        $params[] = $statusFilter;
                    }
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

            if ($applicationDateFilter !== '') {
                $where[] = 'DATE(l.loan_application_date) = ?';
                $params[] = $applicationDateFilter;
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
                        COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                        COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status,
                        l.loan_current_step_id AS stepId,
                        ws.step_name AS stepName,
                        l.loan_application_date AS dateApplied,
                        l.loan_due_date AS dueDate,
                        l.loan_promised_payment_date AS paymentDate,
                        COALESCE(l.loan_updated_at, l.loan_application_date) AS dateUpdated,
                        l.loan_expiry_timestamp AS expiryTimestamp
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
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
            error_log('COO list loans error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error fetching loans']);
        }
        return;
    }
    
    // Default action (backward compatibility)
    try {
        $status = trim($_GET['status'] ?? '');
        $search = trim($_GET['search'] ?? '');
        $limit = min(300, max(20, intval($_GET['limit'] ?? 200)));

        // COO view: loans assigned to the COO step.  An application that was
        // endorsed here keeps its visible "Endorsed" status (12), but it is
        // still pending work for the COO.
        $params = [];
        $where = ['l.loan_current_step_id = 4'];
        if ($status !== '') {
            if ($status === '1') {
                $where[] = 'l.loan_status_id IN (1, 12)';
            } else {
                $where[] = 'l.loan_status_id = ?';
                $params[] = $status;
            }
        } else {
            $where[] = 'l.loan_status_id IN (1, 12)';
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
                    COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                    COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status,
                    l.loan_current_step_id AS stepId,
                    ws.step_name AS stepName,
                    l.loan_application_date AS dateApplied,
                    l.loan_due_date AS dueDate,
                    COALESCE(l.loan_updated_at, l.loan_application_date) AS dateUpdated,
                    l.loan_expiry_timestamp AS expiryTimestamp
                FROM tbl_csdl_loans l
                JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
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
    $action = $_POST['action'] ?? '';
    
    // COO decisions: approval or partial payment. CSDL owns returns.
    if ($action === 'process') {
        $loanId = (int) ($_POST['loanId'] ?? 0);
        $processType = strtolower(trim((string) ($_POST['processType'] ?? '')));
        $remarks = trim((string) ($_POST['remarks'] ?? ''));
        $amountApprovedInput = $_POST['amountApproved'] ?? null;
        $amountApproved = is_scalar($amountApprovedInput) ? (float) $amountApprovedInput : 0;
        $partialAmount = round((float) ($_POST['partialPaymentAmount'] ?? 0), 2);
        $permissionByAction = [
            'approve' => 'coo.loans.approve',
            'partial' => 'coo.loans.partial_payment',
        ];
        if ($loanId <= 0 || !isset($permissionByAction[$processType])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid loan action.']);
            exit;
        }

        RBAC::requirePermission($employeeId, $permissionByAction[$processType], 'You do not have permission to perform this loan action');

        try {
            $pdo->beginTransaction();
            
            // Get loan details
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
            
            // COO receives Assessment-endorsed loans from every campus.
            if ((int) $loan['loan_current_step_id'] !== 4 || (int) $loan['loan_status_id'] !== 12) {
                throw new RuntimeException('This loan is not waiting for COO review.');
            }

            $loanAmount = (float) ($loan['loan_amount_can_pay'] ?? 0);
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
            $newAmountCanPay = null;
            
            if ($processType === 'approve') {
                if (!is_scalar($amountApprovedInput) || !preg_match('/^\d+(?:\.\d{1,2})?$/D', trim((string) $amountApprovedInput)) || !is_finite($amountApproved)) {
                    throw new InvalidArgumentException('Enter a valid amount can pay with up to two decimal places.');
                }
                $approvalAmount = round($amountApproved, 2);
                if ($approvalAmount <= 0) {
                    throw new InvalidArgumentException('Enter an approved amount greater than zero.');
                }
                $balanceTotal = (float) ($loan['balance_total_balance'] ?? 0);
                if ($balanceTotal > 0 && $approvalAmount > $balanceTotal) {
                    throw new InvalidArgumentException('Amount can pay cannot exceed the total balance of ₱' . number_format($balanceTotal, 2) . '.');
                }
                $alreadyPaid = (float) ($loan['loan_recorded_payment_amount'] ?? 0);
                if ($approvalAmount < $alreadyPaid) {
                    throw new InvalidArgumentException('Amount can pay cannot be less than the payment already recorded (₱' . number_format($alreadyPaid, 2) . ').');
                }
                
                // Approve and route to Cashier
                $nextStepId = 2; // Cashier step
                $nextRoleId = 99; // Cashier role
                $loanStatusId = 2; // Approved
                $trackingAction = 'Loan Approved - Awaiting Payment Confirmation';
                $adjustmentRemark = abs($approvalAmount - $loanAmount) >= 0.01
                    ? ' Student amount can pay adjusted from ₱' . number_format($loanAmount, 2) . ' to ₱' . number_format($approvalAmount, 2) . '.'
                    : '';
                $trackingRemarks = 'Approved amount: ₱' . number_format($approvalAmount, 2) . '.' . $adjustmentRemark . ' Routed to Cashier for payment confirmation.' . ($remarks !== '' ? ' ' . $remarks : '');
                $studentTitle = 'Loan Application Approved';
                $studentMessage = "Congratulations! Your loan application {$loan['loan_application_no']} has been approved for ₱" . number_format($approvalAmount, 2) . ". Please proceed to the Cashier's office for payment processing.";
                $emailType = 'approve';
                
            } else {
                if ($partialAmount <= 0) {
                    throw new InvalidArgumentException('Enter a partial-payment amount greater than zero.');
                }
                if ($partialAmount > $remainingBalance) {
                    throw new InvalidArgumentException('The partial payment cannot be greater than the remaining balance (₱' . number_format($remainingBalance, 2) . ').');
                }
                $newAmountCanPay = round($loanAmount + $partialAmount, 2);
                $nextStepId = 2;
                $nextRoleId = 99;
                $loanStatusId = 2;
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
            }
            
            // Get recipients for next office
            $recipients = [];
            if ($nextRoleId > 0) {
                $recipientStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1');
                $recipientStmt->execute([$nextRoleId]);
                $recipients = array_map('intval', $recipientStmt->fetchAll(PDO::FETCH_COLUMN));
                if ($recipients === []) {
                    throw new RuntimeException('No active Cashier employee is available.');
                }
            }
            
            // Update loan
            if ($processType === 'partial') {
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 2, loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 2 END, loan_current_step_id = ?, loan_amount_can_pay = ?, loan_required_partial_amount = ?, loan_approval_date = CURDATE(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$nextStepId, $newAmountCanPay, $partialAmount, $employeeId, $loanId]);
            } else {
                $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 2, loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 1 END, loan_current_step_id = ?, loan_amount_can_pay = ?, loan_approval_date = CURDATE(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                $updateStmt->execute([$nextStepId, $approvalAmount, $employeeId, $loanId]);
            }
            
            // Add the COO approval record for approval and conditional approval.
            {
                $approvalCheck = $pdo->prepare('SELECT approval_id FROM tbl_csdl_loan_approvals WHERE approval_loan_id = ? AND approval_step_id = 4 AND approval_role_id = 97 ORDER BY approval_id DESC LIMIT 1');
                $approvalCheck->execute([$loanId]);
                $approvalId = (int) ($approvalCheck->fetchColumn() ?: 0);
                if ($approvalId > 0) {
                    $approvalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals SET approval_amount_approved = ?, approval_processed_by = ?, approval_date_processed = NOW(), approval_channel_used = 'Email', approval_date_contacted = NOW(), approval_remarks = ?, approval_status_id = ?, approval_approved_email = 1, approval_updated_at = NOW() WHERE approval_id = ?");
                    $approvalStmt->execute([$approvalAmount, $employeeId, $remarks, $approvalStatusId, $approvalId]);
                } else {
                    $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, approval_processed_by, approval_date_processed, approval_channel_used, approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email) VALUES (?, 4, 97, ?, ?, NOW(), 'Email', NOW(), ?, ?, 1)");
                    $approvalStmt->execute([$loanId, $approvalAmount, $employeeId, $remarks, $approvalStatusId]);
                }
            }
            
            // Add tracking entry
            $targetStepId = $nextStepId;
            $trackStmt = $pdo->prepare('INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, ?, ?, ?)');
            // The legacy tracking column is constrained to student IDs. Keep the
            // staff member in the readable audit remark and store the loan owner
            // here so the foreign-key requirement is satisfied.
            $trackStmt->execute([$loanId, $targetStepId, $trackingAction, $trackingRemarks . " Processed by COO employee #{$employeeId}.", (int) $loan['loan_student_id']]);
            
            // Send notifications
            $notifyStmt = $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, ?, NOW())');
            $pushQueue = [];
            foreach ($recipients as $recipientId) {
                $officeTitle = 'Loan Assigned for Review';
                $officeMessage = "Loan {$loan['loan_application_no']} is now assigned to your office.";
                $notifyStmt->execute([$recipientId, null, $nextStepId, $loanId, $officeTitle, $officeMessage]);
                $pushQueue[] = [$recipientId, 'employee', (int) $pdo->lastInsertId(), $officeTitle, $officeMessage];
            }
            $notifyStmt->execute([null, (int) $loan['loan_student_id'], $targetStepId, $loanId, $studentTitle, $studentMessage]);
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
                null,
                $processType === 'partial' ? '₱' . number_format((float) $newAmountCanPay, 2) : null,
                senderRole: 'coo'
            );
            foreach ($pushQueue as [$recipientId, $recipientType, $notificationId, $title, $message]) {
                sendPushNotification($pdo, $recipientId, $recipientType, ['id' => $notificationId, 'title' => $title, 'message' => $message, 'loanId' => $loanId]);
            }
            
            $successMessage = $processType === 'partial'
                ? 'Additional partial amount saved. New Amount Can Pay: ₱' . number_format((float) $newAmountCanPay, 2) . '. Sent to Cashier.'
                : 'Loan approved and sent to Cashier.';
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
            error_log('COO loan workflow: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to process this loan right now.']);
        }
        exit;
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
            exit;
        }
        $pnTagging = trim($_POST['pnTagging'] ?? '');

        if ($processType === 'approve') {
            RBAC::requirePermission($employeeId, 'coo.loans.approve', 'You do not have permission to approve loans');
        } elseif ($processType === 'decline' || $processType === 'return') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Decline and return are handled by the Assessment office only.']);
            exit;
        } elseif ($processType === 'endorsed_to_bukas' || $processType === 'endorsed') {
            RBAC::requirePermission($employeeId, 'coo.loans.endorse_bukas', 'You do not have permission to endorse loans to Bukas');
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
            
            // COO can only process loans at Step 4 (COO Office Final Approval)
            if ($loan['loan_current_step_id'] != 4) {
                throw new Exception('This loan is not at the COO Office step. Only loans at Step 4 can be processed by COO.');
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
                // COO final approval: no ₱7,000 balance-after-payment cap (Finance enforces that before endorsing to COO)
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
                throw new Exception('Internal endorsement is not available at COO. Use Approve, Decline, Return, or Endorse to Bukas.');
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
            // Use current step (4) for approval record, not the new step
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
                $amountDisplay = $amountApproved ? '₱' . number_format($amountApproved, 2) : null;
                queueLoanNotifications($pdo, $loan, $processType, $loan['loan_application_no'], $amountDisplay, senderRole: 'coo');
            }

            echo json_encode(['success' => true, 'message' => 'Loan processed successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('COO loan process error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error processing loan']);
        }
        exit;
    }
    
    // This workflow no longer supports Bukas endorsements. Keep an explicit
    // response so an old browser tab cannot accidentally invoke legacy code.
    if ($action === 'endorseToBukas') {
        http_response_code(410);
        echo json_encode(['success' => false, 'message' => 'Endorsement to Bukas is no longer available.']);
        exit;

        RBAC::requirePermission($employeeId, 'coo.loans.endorse_bukas', 'You do not have permission to endorse loans to Bukas');
        $loanId = intval($_POST['loanId'] ?? 0);
        $reference = $_POST['reference'] ?? 'BUKAS-REF';
        $title = $_POST['title'] ?? 'EXTEND your tuition payment with a Bukas Tuition Plan!';
        $description = $_POST['description'] ?? 'Hi! Referred to Bukas for tuition installment assistance.';
        $learnMoreUrl = $_POST['learnMoreUrl'] ?? 'https://www.bukas.ph';
        $imagePath = $_POST['imagePath'] ?? 'uploads/images/June-2023-MK-Enrollment-1-1.jpg';
        $contactChannel = trim($_POST['contactChannel'] ?? '');
        if (empty($contactChannel)) {
            $contactChannel = 'Email';
        }
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
            $loanStmt = $pdo->prepare("SELECT l.*, 
                                              s.student_id, 
                                              s.student_email,
                                              s.student_personal_email,
                                              s.student_contact_number,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name
                                       FROM tbl_csdl_loans l 
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id 
                                       WHERE l.loan_id = ?");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                throw new Exception('Loan not found');
            }
            
            // COO can only endorse to Bukas from Step 4
            if ($loan['loan_current_step_id'] != 4) {
                throw new Exception('This loan is not at the COO Office step.');
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
            
            // Create or update approval at COO step 4 (same as JSON process endorsed_to_bukas).
            // Legacy Bukas modal rows used approval_step_id = 6; normalize to 4 on update.
            $checkApprovalStmt2 = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                 WHERE approval_loan_id = ? AND approval_step_id = 4 AND approval_role_id = ?");
            $checkApprovalStmt2->execute([$loanId, $userRoleId]);
            $existingApproval = $checkApprovalStmt2->fetch(PDO::FETCH_ASSOC);

            if (!$existingApproval) {
                $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                    WHERE approval_loan_id = ? AND approval_step_id = 6 AND approval_role_id = ?
                                                    AND approval_status_id = 4");
                $checkApprovalStmt->execute([$loanId, $userRoleId]);
                $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
            }

            if ($existingApproval) {
                $approvalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals 
                                               SET approval_step_id = 4,
                                                   approval_processed_by = ?, 
                                                   approval_date_processed = NOW(), 
                                                   approval_channel_used = ?, 
                                                   approval_date_contacted = ?, 
                                                   approval_remarks = ?, 
                                                   approval_status_id = 4,
                                                   approval_updated_at = NOW()
                                               WHERE approval_id = ?");
                $approvalStmt->execute([$userId, $contactChannel, $dateContactedFormatted, $remarks, $existingApproval['approval_id']]);
            } else {
                $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals 
                                               (approval_loan_id, approval_step_id, approval_role_id, 
                                                approval_processed_by, approval_date_processed, approval_channel_used, 
                                                approval_date_contacted, approval_remarks, approval_status_id) 
                                               VALUES (?, 4, ?, ?, NOW(), ?, ?, ?, 4)");
                $approvalStmt->execute([$loanId, $userRoleId, $userId, $contactChannel, $dateContactedFormatted, $remarks]);
            }
            
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

            if ($notifTitle && $notifMessage) {
                queueLoanNotifications($pdo, $loan, 'endorsed_to_bukas', $loan['loan_application_no'], null, senderRole: 'coo');
            }

            echo json_encode(['success' => true, 'message' => 'Loan endorsed to Bukas successfully']);
        } catch (Throwable $e) {
            $pdo->rollBack();
            http_response_code(500);
            error_log('COO Bukas endorsement error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error endorsing loan to Bukas']);
        }
        exit;
    }
}
?>
