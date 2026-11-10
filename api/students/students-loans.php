<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-loan-promised-amount.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';

header('Content-Type: application/json');

if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$studentId = (int) $_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $action = $_GET['action'] ?? 'list';

    switch ($action) {
        case 'filters':
            handleFilters($pdo, $studentId);
            break;
        case 'current':
            handleCurrentLoan($pdo, $studentId);
            break;
        case 'details':
            handleDetails($pdo, $studentId);
            break;
        case 'list':
        default:
            handleList($pdo, $studentId);
            break;
    }
    exit;
}

if ($method === 'POST') {
    // Read and parse JSON input BEFORE CSRF validation
    $rawInput = file_get_contents('php://input');
    $input = json_decode($rawInput, true);
    if (empty($_POST) && $input !== null) {
        $_POST = $input;
    }
    
    // NOW validate CSRF with parsed POST data
    CSRFProtection::validateRequest();
    
    $action = $_POST['action'] ?? '';
    
    if ($action === 'reapply') {
        handleReapply($pdo, $studentId);
        exit;
    } elseif ($action === 'cancel') {
        handleCancel($pdo, $studentId);
        exit;
    }
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
exit;

function handleFilters(PDO $pdo, int $studentId): void
{
    try {
        $semestersStmt = $pdo->prepare("SELECT DISTINCT sem.semester_id, sem.semester_name
                                        FROM tbl_csdl_loans l
                                        INNER JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                        INNER JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                                        INNER JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
                                        WHERE l.loan_student_id = :studentId
                                        ORDER BY sem.semester_id ASC");
        $semestersStmt->execute([':studentId' => $studentId]);
        $periodsStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_id DESC");

        echo json_encode([
            'success' => true,
            'semesters' => $semestersStmt->fetchAll(PDO::FETCH_ASSOC),
            'applicationPeriods' => $periodsStmt->fetchAll(PDO::FETCH_ASSOC)
        ]);
    } catch (Throwable $e) {
        error_log('students-loans filters error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to load filters']);
    }
}

/**
 * Scan overdue application timers and send their one-time alerts. No loan is
 * modified: it remains processable in its current workflow step.
 */
function syncOverdueLoanNotifications(PDO $pdo): void
{
    queueOverdueLoanNotifications($pdo);
}

function handleStats(PDO $pdo, int $studentId): void
{
    try {
        $stmt = $pdo->prepare("SELECT loan_status_id, COUNT(*) as total
                               FROM tbl_csdl_loans
                               WHERE loan_student_id = :studentId
                               GROUP BY loan_status_id");
        $stmt->execute([':studentId' => $studentId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $stats = [
            'total' => 0,
            'pending' => 0,
            'underReview' => 0,
            'approved' => 0,
            'declined' => 0,
            'others' => 0
        ];

        foreach ($rows as $row) {
            $count = (int) ($row['total'] ?? 0);
            $stats['total'] += $count;
            switch ((int) $row['loan_status_id']) {
                case 1:
                    $stats['pending'] = $count;
                    break;
                case 2:
                    $stats['underReview'] = $count;
                    break;
                case 3:
                    $stats['approved'] = $count;
                    break;
                case 4:
                    $stats['declined'] = $count;
                    break;
                default:
                    $stats['others'] += $count;
            }
        }

        echo json_encode(['success' => true, 'stats' => $stats]);
    } catch (Throwable $e) {
        error_log('students-loans stats error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to load stats']);
    }
}

function handleCurrentLoan(PDO $pdo, int $studentId): void
{
    try {
        syncOverdueLoanNotifications($pdo);

        $sql = "SELECT l.*,
                       ls.loan_status_name,
                       ws.step_name AS current_step_name,
                       ap.app_period_name,
                       b.balance_total_balance,
                       COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                       COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status
                FROM tbl_csdl_loans l
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                WHERE l.loan_student_id = :studentId
                ORDER BY l.loan_application_date DESC, l.loan_id DESC
                LIMIT 1";

        $stmt = $pdo->prepare($sql);
        $stmt->execute([':studentId' => $studentId]);
        $loan = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$loan) {
            echo json_encode([
                'success' => true,
                'loan' => null
            ]);
            return;
        }

        echo json_encode([
            'success' => true,
            'loan' => $loan
        ]);
    } catch (Throwable $e) {
        error_log('students-loans current error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to load current loan']);
    }
}

function handleList(PDO $pdo, int $studentId): void
{
    $page = max(1, (int) ($_GET['page'] ?? 1));
    $perPage = (int) ($_GET['perPage'] ?? 10);
    $perPage = max(5, min(50, $perPage));
    $offset = ($page - 1) * $perPage;
    $semesterId = (int) ($_GET['semesterId'] ?? 0);
    $periodId = (int) ($_GET['periodId'] ?? 0);
    $search = trim((string) ($_GET['search'] ?? ''));

    try {
        syncOverdueLoanNotifications($pdo);
        
        $where = ["l.loan_student_id = :studentId"];
        $params = [':studentId' => $studentId];
        
        if ($semesterId > 0) {
            $where[] = "sy.sy_semester_id = :semesterId";
            $params[':semesterId'] = $semesterId;
        }
        
        if ($periodId > 0) {
            $where[] = "l.loan_app_period_id = :periodId";
            $params[':periodId'] = $periodId;
        }
        
        if ($search !== '') {
            $searchLike = '%' . $search . '%';
            $where[] = "(l.loan_application_no LIKE :searchAppNo OR COALESCE(ap.app_period_name, '') LIKE :searchPeriod OR COALESCE(ls.loan_status_name, '') LIKE :searchStatus)";
            $params[':searchAppNo'] = $searchLike;
            $params[':searchPeriod'] = $searchLike;
            $params[':searchStatus'] = $searchLike;
        }
        
        $whereSql = 'WHERE ' . implode(' AND ', $where);
        
        $countSql = "SELECT COUNT(*) 
                     FROM tbl_csdl_loans l
                     LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                     LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                     LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                     LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                     $whereSql";
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) {
            $countStmt->bindValue($k, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $countStmt->execute();
        $total = (int) $countStmt->fetchColumn();

        $sql = "SELECT l.*,
                       ls.loan_status_name,
                       ws.step_name AS current_step_name,
                       ap.app_period_name,
                       b.balance_total_balance,
                       COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                       COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status
                FROM tbl_csdl_loans l
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                $whereSql
                ORDER BY l.loan_application_date DESC, l.loan_id DESC
                LIMIT :limit OFFSET :offset";

        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $stmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $loans = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($loans as &$loan) {
            attachLoanPromisedAmountFields($pdo, (int) $loan['loan_id'], $loan);
        }
        unset($loan);

        echo json_encode([
            'success' => true,
            'loans' => $loans,
            'pagination' => [
                'page' => $page,
                'perPage' => $perPage,
                'total' => $total,
                'totalPages' => max(1, (int) ceil($total / $perPage))
            ]
        ]);
    } catch (Throwable $e) {
        error_log('students-loans list error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to load loans']);
    }
}

function handleDetails(PDO $pdo, int $studentId): void
{
    $loanId = (int) ($_GET['loanId'] ?? 0);
    if ($loanId <= 0) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid loan ID']);
        return;
    }

    try {
        syncOverdueLoanNotifications($pdo);

        $checkStmt = $pdo->prepare("SELECT loan_id FROM tbl_csdl_loans WHERE loan_id = ? AND loan_student_id = ?");
        $checkStmt->execute([$loanId, $studentId]);
        if (!$checkStmt->fetch()) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Access denied']);
            return;
        }

        $sql = "SELECT l.*,
                       s.student_school_id,
                       CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                       s.student_email,
                       s.student_contact_number,
                       p.program_name,
                       yl.year_level_name,
                       ls.loan_status_name,
                       ws.step_name AS current_step_name,
                       ap.app_period_name,
                       g.guardian_name,
                       rel.relationship_name AS guardian_relationship,
                       g.guardian_contact,
                       b.balance_total_balance,
                       b.balance_current_balance,
                       COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                       COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status
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
                LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                WHERE l.loan_id = :loanId AND l.loan_student_id = :studentId";

        $stmt = $pdo->prepare($sql);
        $stmt->execute([':loanId' => $loanId, ':studentId' => $studentId]);
        $loan = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$loan) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Loan not found']);
            return;
        }

        $docStmt = $pdo->prepare("SELECT ld.*, dt.doc_type_name
                                  FROM tbl_csdl_loan_documents ld
                                  LEFT JOIN tbl_csdl_document_types dt ON dt.doc_type_id = ld.loan_document_doc_type_id
                                  WHERE ld.loan_document_loan_id = :loanId");
        $docStmt->execute([':loanId' => $loanId]);
        $loan['documents'] = $docStmt->fetchAll(PDO::FETCH_ASSOC);

        $trackStmt = $pdo->prepare("SELECT lt.*, ws.step_name,
                                           COALESCE(
                                               NULLIF(TRIM(CONCAT_WS(' ', tracking_employee.employee_first_name, tracking_employee.employee_middle_name, tracking_employee.employee_last_name)), ''),
                                           (
                                               SELECT NULLIF(TRIM(CONCAT_WS(' ', e.employee_first_name, e.employee_middle_name, e.employee_last_name)), '')
                                               FROM tbl_csdl_loan_approvals a
                                               INNER JOIN tbl_csdl_employees e ON e.employee_id = a.approval_processed_by
                                               WHERE a.approval_loan_id = lt.loan_tracking_loan_id
                                                 AND a.approval_processed_by IS NOT NULL
                                                 AND ABS(TIMESTAMPDIFF(SECOND,
                                                     COALESCE(a.approval_pn_date_processed, a.approval_date_processed, a.approval_created_at),
                                                     lt.loan_tracking_created_at
                                                 )) <= 120
                                               ORDER BY ABS(TIMESTAMPDIFF(SECOND,
                                                   COALESCE(a.approval_pn_date_processed, a.approval_date_processed, a.approval_created_at),
                                                   lt.loan_tracking_created_at
                                               )), a.approval_id DESC
                                               LIMIT 1
                                           )) AS approver_name
                                    FROM tbl_csdl_loan_tracking lt
                                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = lt.loan_tracking_step_id
                                    LEFT JOIN tbl_csdl_employees tracking_employee
                                      ON lt.loan_tracking_remarks LIKE CONCAT('%employee #', tracking_employee.employee_id, '.%')
                                    WHERE lt.loan_tracking_loan_id = :loanId
                                    ORDER BY lt.loan_tracking_created_at DESC");
        $trackStmt->execute([':loanId' => $loanId]);
        $loan['tracking'] = $trackStmt->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode(['success' => true, 'loan' => $loan]);
    } catch (Throwable $e) {
        error_log('students-loans details error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to load loan details']);
    }
}

function handleReapply(PDO $pdo, int $studentId): void
{
    $loanId = (int) ($_POST['loanId'] ?? 0);
    if ($loanId <= 0) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid loan ID']);
        return;
    }

    try {
        // Check if loan exists and belongs to student
        $checkStmt = $pdo->prepare("SELECT l.loan_id, l.loan_status_id, l.loan_returned_date, l.loan_application_no,
                                           l.loan_student_id, s.student_email, s.student_personal_email,
                                           s.student_contact_number,
                                           CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
                                    FROM tbl_csdl_loans l
                                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                    WHERE l.loan_id = ? AND l.loan_student_id = ?");
        $checkStmt->execute([$loanId, $studentId]);
        $loan = $checkStmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$loan) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Access denied']);
            return;
        }
        
        // Check if loan is returned (status_id = 6)
        if ($loan['loan_status_id'] != 6) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Only returned loans can be reapplied']);
            return;
        }
        
        $pdo->beginTransaction();
        
        // Returned applications return to their first campus reviewer.
        $campusStmt = $pdo->prepare("SELECT s.student_campus_id, c.campus_code
                                     FROM tbl_csdl_loans l
                                     JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                     LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
                                     WHERE l.loan_id = ?");
        $campusStmt->execute([$loanId]);
        $campus = $campusStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $firstStepId = strtolower(trim((string) ($campus['campus_code'] ?? ''))) === 'carmen' ? 1 : 3;
        $firstRoleId = $firstStepId === 1 ? 100 : 98;

        // Update loan status back to pending and reset to the campus reviewer.
        $updateStmt = $pdo->prepare("UPDATE tbl_csdl_loans 
                                     SET loan_status_id = 1,
                                         loan_current_step_id = ?,
                                         loan_returned_date = NULL,
                                         loan_due_date = DATE_ADD(CURDATE(), INTERVAL 30 DAY),
                                         loan_updated_by = ?,
                                         loan_updated_at = NOW()
                                     WHERE loan_id = ?");
        $updateStmt->execute([$firstStepId, $studentId, $loanId]);
        
        // Update or create approval record back to pending
        $approvalCheckStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                             WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?");
        $approvalCheckStmt->execute([$loanId, $firstStepId, $firstRoleId]);
        $existingApproval = $approvalCheckStmt->fetch(PDO::FETCH_ASSOC);
        
        if ($existingApproval) {
            // Update existing approval to pending
            $approvalUpdateStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals 
                                                 SET approval_status_id = 1,
                                                     approval_amount_approved = NULL,
                                                     approval_processed_by = NULL,
                                                     approval_date_processed = NULL,
                                                     approval_channel_used = NULL,
                                                     approval_date_contacted = NULL,
                                                     approval_remarks = NULL,
                                                     approval_approved_email = 0,
                                                     approval_pn_tagging = NULL,
                                                     approval_pn_date_processed = NULL,
                                                     approval_updated_at = NOW()
                                                 WHERE approval_id = ?");
            $approvalUpdateStmt->execute([$existingApproval['approval_id']]);
        } else {
            // Create new approval record
            $approvalInsertStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals 
                                                 (approval_loan_id, approval_step_id, approval_role_id, approval_status_id) 
                                                 VALUES (?, ?, ?, 1)");
            $approvalInsertStmt->execute([$loanId, $firstStepId, $firstRoleId]);
        }
        
        // Add tracking entry
        $trackingStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking 
                                       (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action,
                                        loan_tracking_remarks, loan_tracking_updated_by) 
                                       VALUES (?, ?, 'Application Resubmitted', 'Loan application resubmitted by student and routed to the campus review queue', ?)");
        $trackingStmt->execute([$loanId, $firstStepId, $studentId]);
        
        $pdo->commit();

        queueLoanNotifications(
            $pdo,
            $loan,
            'resubmitted',
            (string) $loan['loan_application_no'],
            senderRole: 'system'
        );
        
        echo json_encode([
            'success' => true,
            'message' => 'Loan application resubmitted successfully'
        ]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('students-loans reapply error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to resubmit loan application']);
    }
}

function handleCancel(PDO $pdo, int $studentId): void
{
    $loanId = (int) ($_POST['loanId'] ?? 0);
    if ($loanId <= 0) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid loan ID']);
        return;
    }

    try {
        $pdo->beginTransaction();

        // Lock and validate loan
        $stmt = $pdo->prepare("SELECT l.loan_id, l.loan_status_id, l.loan_current_step_id, l.loan_app_period_id,
                                      l.loan_application_no, l.loan_student_id, s.student_email,
                                      s.student_personal_email, s.student_contact_number,
                                      CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
                               FROM tbl_csdl_loans l
                               JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                               WHERE l.loan_id = ? AND l.loan_student_id = ? FOR UPDATE");
        $stmt->execute([$loanId, $studentId]);
        $loan = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$loan) {
            $pdo->rollBack();
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Access denied']);
            return;
        }

        // Allow cancel only if still pending
        if ((int)$loan['loan_status_id'] !== 1) {
            $pdo->rollBack();
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Only pending applications can be cancelled']);
            return;
        }

        // A student may cancel at most two applications in the same period.
        // This is checked here as well as at application submission so the
        // rule cannot be bypassed by repeated cancel requests.
        $cancellationCountStmt = $pdo->prepare("SELECT COUNT(*)
                                                FROM tbl_csdl_loans
                                                WHERE loan_student_id = ?
                                                  AND loan_app_period_id = ?
                                                  AND loan_status_id = 9");
        $cancellationCountStmt->execute([$studentId, $loan['loan_app_period_id']]);
        if ((int) $cancellationCountStmt->fetchColumn() >= 2) {
            $pdo->rollBack();
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'You have reached the limit of two cancellations for this application period. Please contact CSDL for assistance.']);
            return;
        }

        // Update loan status to Cancelled (id = 9) and move to Cancelled workflow step (id = 10)
        $updateLoan = $pdo->prepare("UPDATE tbl_csdl_loans 
                                     SET loan_status_id = 9, loan_current_step_id = 10, loan_updated_at = CURRENT_TIMESTAMP 
                                     WHERE loan_id = ?");
        $updateLoan->execute([$loanId]);

        // Insert tracking entry
        $insertTrack = $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking 
            (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) 
            VALUES (?, ?, ?, ?, ?)");
        $insertTrack->execute([
            $loanId,
            10,
            'Cancelled',
            'Cancelled by student',
            $studentId
        ]);

        // Update any pending approval record to cancelled as well
        // approval_status_id: 1 = pending, 6 = cancelled (see tbl_csdl_approval_statuses)
        $updateApproval = $pdo->prepare("UPDATE tbl_csdl_loan_approvals
                                         SET approval_status_id = 6,
                                             approval_step_id = 10,
                                             approval_updated_at = CURRENT_TIMESTAMP
                                         WHERE approval_loan_id = ?
                                           AND approval_status_id = 1");
        $updateApproval->execute([$loanId]);

        $pdo->commit();

        queueLoanNotifications(
            $pdo,
            $loan,
            'cancelled',
            (string) $loan['loan_application_no'],
            senderRole: 'system'
        );

        echo json_encode(['success' => true, 'message' => 'Loan application cancelled']);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('students-loans cancel error: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Failed to cancel loan application']);
    }
}

function validateDate(string $value): ?string
{
    if ($value === '') {
        return null;
    }
    $date = DateTime::createFromFormat('Y-m-d', $value);
    if ($date && $date->format('Y-m-d') === $value) {
        return $date->format('Y-m-d');
    }
    return null;
}
