<?php
/**
 * Assessment dashboard — shared Assessment queue across all campuses.
 */
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-loan-pn-routing.php';

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

const ASSESSMENT_STEP = 11;
const TAGGED_PN_STATUS = 2;

function assessmentPnOwnerWhere(): string {
    return '(' . loanPnTaggingOfficeSql() . ") = 'assessment'";
}

function assessmentPnTaggedWhere(): string {
    return '(l.loan_pn_status_id = ' . TAGGED_PN_STATUS . ' OR l.loan_pn_tagged_date IS NOT NULL) AND ' . assessmentPnOwnerWhere();
}

try {
    $action = $_GET['action'] ?? '';
    $view = $_GET['view'] ?? '';
    $detail = $_GET['detail'] ?? '';

    // Handle recent activity request (optional semester / school year / period / search — same rules as assessment loan list)
    if ($action === 'recent_activity') {
        try {
            $semester   = trim((string) ($_GET['semester']   ?? ''));
            $schoolYear = trim((string) ($_GET['schoolYear'] ?? ''));
            $period     = trim((string) ($_GET['period']     ?? ''));
            $search     = trim((string) ($_GET['search']     ?? ''));
            $perPage    = max(1, min(100, (int) ($_GET['limit'] ?? 25)));
            $page       = max(1, (int) ($_GET['page'] ?? 1));
            $offset     = ($page - 1) * $perPage;

            // PN tagging now has its own status/date on the loan record.  Keep the
            // legacy approval check as a fallback for records tagged before this
            // change was introduced.
            $where  = ['(l.loan_pn_status_id = ' . TAGGED_PN_STATUS . ' OR l.loan_pn_tagged_date IS NOT NULL OR EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals legacy_la WHERE legacy_la.approval_loan_id = l.loan_id AND legacy_la.approval_pn_tagging IN ("Tagged", "PN Tagged")))'];
            $where[] = assessmentPnOwnerWhere();
            $params = [];

            if ($semester !== '') {
                $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = ?)';
                $params[] = $semester;
            }
            if ($schoolYear !== '') {
                $where[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = ?)';
                $params[] = $schoolYear;
            }
            if ($period !== '') {
                $where[] = 'l.loan_app_period_id = ?';
                $params[] = $period;
            }
            if ($search !== '') {
                $where[] = '(l.loan_application_no LIKE ? OR s.student_school_id LIKE ? OR CONCAT(s.student_last_name, ", ", s.student_first_name) LIKE ?)';
                $sp = '%' . $search . '%';
                $params[] = $sp;
                $params[] = $sp;
                $params[] = $sp;
            }

            $whereSql = implode(' AND ', $where);

            // Count total for pagination
            $countSql = 'SELECT COUNT(*) FROM tbl_csdl_loans l
                         INNER JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                         WHERE ' . $whereSql;
            $countStmt = $pdo->prepare($countSql);
            $countStmt->execute($params);
            $total      = (int) $countStmt->fetchColumn();
            $totalPages = $perPage > 0 ? (int) ceil($total / $perPage) : 1;

            $sql = 'SELECT l.loan_id,
                           l.loan_application_no,
                           CONCAT(s.student_last_name, \', \', s.student_first_name) AS student_name,
                           l.loan_amount_can_pay,
                           l.loan_status_id,
                           COALESCE(ls.loan_status_name, "Unknown") AS loan_status_name,
                           l.loan_payment_status_id AS payment_status,
                           l.loan_pn_status_id AS pn_status,
                           COALESCE(l.loan_pn_tagged_date, l.loan_updated_at, l.loan_application_date) AS date_tagged
                    FROM tbl_csdl_loans l
                    INNER JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    WHERE ' . $whereSql . '
                    ORDER BY date_tagged DESC
                    LIMIT ' . $perPage . ' OFFSET ' . $offset;

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $data = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'data' => $data, 'total' => $total, 'totalPages' => $totalPages]);
            exit;
        } catch (Throwable $e) {
            error_log('Assessment Dashboard recent_activity error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Failed to load recent activity: ' . $e->getMessage(), 'data' => [], 'total' => 0, 'totalPages' => 1]);
            exit;
        }
    }

    // Handle modal loans request (paginated)
    if ($action === 'modal_loans') {
        try {
            $modalView = $_GET['view'] ?? '';
            $page = max(1, (int) ($_GET['page'] ?? 1));
            $perPage = max(1, min(100, (int) ($_GET['perPage'] ?? 25)));
            $offset = ($page - 1) * $perPage;

            $rows = [];
            $total = 0;

            if ($modalView === 'allApplications') {
                // Show only completed loans (status ID 5)
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE l.loan_status_id = 5 AND ' . assessmentPnOwnerWhere() . '');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               l.loan_status_id AS statusId,
                                               COALESCE(ls.loan_status_name, "Unknown") AS statusName,
                                               l.loan_payment_status_id AS paymentStatus,
                                               l.loan_pn_status_id AS pnStatus,
                                               l.loan_application_date AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                        WHERE l.loan_status_id = 5 AND ' . assessmentPnOwnerWhere() . '
                                        ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'approved') {
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE l.loan_status_id = 2
                      AND EXISTS (
                          SELECT 1 FROM tbl_csdl_loan_approvals la
                          WHERE la.approval_loan_id = l.loan_id
                            AND la.approval_role_id = 101
                            AND la.approval_status_id = 2
                      )');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               l.loan_status_id AS statusId,
                                               COALESCE(ls.loan_status_name, "Approved") AS statusName,
                                               l.loan_payment_status_id AS paymentStatus,
                                               l.loan_pn_status_id AS pnStatus,
                                               COALESCE(l.loan_approval_date, l.loan_application_date) AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                        WHERE l.loan_status_id = 2
                                          AND EXISTS (
                                              SELECT 1 FROM tbl_csdl_loan_approvals la
                                              WHERE la.approval_loan_id = l.loan_id
                                                AND la.approval_role_id = 101
                                                AND la.approval_status_id = 2
                                          )
                                        ORDER BY COALESCE(l.loan_approval_date, l.loan_application_date) DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'endorsed') {
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE l.loan_status_id = 12
                      AND EXISTS (
                          SELECT 1 FROM tbl_csdl_loan_tracking lt
                          WHERE lt.loan_tracking_loan_id = l.loan_id
                            AND lt.loan_tracking_action IN ("Endorsed to Branch Admin", "Endorsed to COO")
                            AND lt.loan_tracking_remarks LIKE "%Processed by Assessment employee%"
                      )');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               l.loan_status_id AS statusId,
                                               COALESCE(ls.loan_status_name, "Endorsed") AS statusName,
                                               l.loan_payment_status_id AS paymentStatus,
                                               l.loan_pn_status_id AS pnStatus,
                                               l.loan_application_date AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                        WHERE l.loan_status_id = 12
                                          AND EXISTS (
                                              SELECT 1 FROM tbl_csdl_loan_tracking lt
                                              WHERE lt.loan_tracking_loan_id = l.loan_id
                                                AND lt.loan_tracking_action IN ("Endorsed to Branch Admin", "Endorsed to COO")
                                                AND lt.loan_tracking_remarks LIKE "%Processed by Assessment employee%"
                                          )
                                        ORDER BY l.loan_application_date DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'pnTagged') {
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE ' . assessmentPnTaggedWhere() . '');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               l.loan_status_id AS statusId,
                                               COALESCE(ls.loan_status_name, "Unknown") AS statusName,
                                               l.loan_payment_status_id AS paymentStatus,
                                               ' . TAGGED_PN_STATUS . ' AS pnStatus,
                                               COALESCE(l.loan_pn_tagged_date, l.loan_updated_at, l.loan_application_date) AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                        WHERE ' . assessmentPnTaggedWhere() . '
                                        ORDER BY date DESC, l.loan_id DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'pendingApproval') {
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE l.loan_status_id = 1
                    AND l.loan_current_step_id = ?
                    AND NOT EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL)');
                $cnt->execute([ASSESSMENT_STEP]);
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               "Not Set" AS pnStatus,
                                               l.loan_application_date AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        WHERE l.loan_status_id = 1
                                        AND l.loan_current_step_id = ?
                                        AND NOT EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL)
                                        ORDER BY l.loan_application_date DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, ASSESSMENT_STEP, PDO::PARAM_INT);
                $stmt->bindValue(2, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(3, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'pendingPnTagging') {
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE l.loan_status_id IN (1, 2, 11)
                    AND l.loan_current_step_id = ?
                    AND (
                        NOT EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL)
                        OR EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging = "Partial Payment")
                    )');
                $cnt->execute([ASSESSMENT_STEP]);
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               COALESCE((SELECT approval_pn_tagging FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL ORDER BY approval_pn_date_processed DESC LIMIT 1), "Not Set") AS pnStatus,
                                               l.loan_application_date AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        WHERE l.loan_status_id IN (1, 2, 11)
                                        AND l.loan_current_step_id = ?
                                        AND (
                                            NOT EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL)
                                            OR EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging = "Partial Payment")
                                        )
                                        ORDER BY l.loan_application_date DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, ASSESSMENT_STEP, PDO::PARAM_INT);
                $stmt->bindValue(2, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(3, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'pendingToTag') {
                $cnt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE l.loan_status_id = 1
                    AND NOT EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL)');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               "Not Set" AS pnStatus,
                                               l.loan_application_date AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        WHERE l.loan_status_id = 1
                                        AND NOT EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL)
                                        ORDER BY l.loan_application_date DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'totalTagged') {
                $cnt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    WHERE ' . assessmentPnTaggedWhere() . '');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               l.loan_status_id AS statusId,
                                               COALESCE(ls.loan_status_name, "Unknown") AS statusName,
                                               l.loan_payment_status_id AS paymentStatus,
                                               ' . TAGGED_PN_STATUS . ' AS pnStatus,
                                               COALESCE(l.loan_pn_tagged_date, l.loan_updated_at, l.loan_application_date) AS `date`
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                        WHERE ' . assessmentPnTaggedWhere() . '
                                        ORDER BY COALESCE(l.loan_pn_tagged_date, l.loan_updated_at, l.loan_application_date) DESC, l.loan_id DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'paid') {
                $cnt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id AND la.approval_pn_tagging = "Paid"');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               la.approval_pn_tagging AS pnStatus,
                                               la.approval_pn_date_processed AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id AND la.approval_pn_tagging = "Paid"
                                        ORDER BY la.approval_pn_date_processed DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } elseif ($modalView === 'partialPayment') {
                $cnt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                    JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id AND la.approval_pn_tagging = "Partial Payment"');
                $cnt->execute();
                $total = (int) $cnt->fetchColumn();

                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               la.approval_pn_tagging AS pnStatus,
                                               la.approval_pn_date_processed AS date
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id AND la.approval_pn_tagging = "Partial Payment"
                                        ORDER BY la.approval_pn_date_processed DESC
                                        LIMIT ? OFFSET ?');
                $stmt->bindValue(1, $perPage, PDO::PARAM_INT);
                $stmt->bindValue(2, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            }

            $totalPages = $total > 0 ? (int) ceil($total / $perPage) : 0;

            echo json_encode([
                'success' => true,
                'rows' => $rows,
                'total' => $total,
                'page' => $page,
                'perPage' => $perPage,
                'totalPages' => $totalPages,
            ]);
            exit;
        } catch (Throwable $e) {
            echo json_encode(['success' => false, 'message' => 'Failed to load modal data', 'rows' => [], 'total' => 0, 'totalPages' => 0]);
            exit;
        }
    }

    if ($detail) {
        try {
            if ($detail === 'pendingList') {
                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               COALESCE(b.balance_current_balance, 0) AS balance,
                                               l.loan_application_date AS dateApplied
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                        WHERE l.loan_status_id = 1
                                        ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                        LIMIT 100');
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'taggedList') {
                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               COALESCE(b.balance_current_balance, 0) AS balance,
                                               l.loan_application_date AS dateApplied
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                        WHERE ' . assessmentPnTaggedWhere() . '
                                        ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                        LIMIT 100');
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'approvedList') {
                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               l.loan_application_date AS dateApplied,
                                               la.approval_date_processed AS dateApproved
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id
                                            AND la.approval_step_id = ' . ASSESSMENT_STEP . ' AND la.approval_status_id = 2 AND la.approval_role_id = 101
                                        ORDER BY COALESCE(la.approval_date_processed, l.loan_application_date) DESC, l.loan_id DESC
                                        LIMIT 100');
                $stmt->execute();
                echo json_encode(['success' => true, 'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                return;
            }
            if ($detail === 'totalList') {
                $stmt = $pdo->prepare('SELECT l.loan_application_no AS applicationNo,
                                               s.student_school_id AS schoolId,
                                               CONCAT(s.student_last_name, \', \', s.student_first_name) AS name,
                                               l.loan_amount_can_pay AS amount,
                                               ls.loan_status_name AS status,
                                               COALESCE(la.approval_date_processed, l.loan_application_date) AS dateProcessed
                                        FROM tbl_csdl_loans l
                                        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                        LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                        LEFT JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id
                                            AND la.approval_step_id = ' . ASSESSMENT_STEP . ' AND la.approval_role_id = 101
                                        WHERE l.loan_current_step_id = ' . ASSESSMENT_STEP . '
                                        ORDER BY COALESCE(la.approval_date_processed, l.loan_application_date) DESC, l.loan_id DESC
                                        LIMIT 100');
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

            if (in_array($view, ['appsWeekly', 'appsMonthly', 'appsYearly'], true)) {
                if ($view === 'appsWeekly') {
                    $today = new DateTime();
                    $dayOfWeek = (int) $today->format('N');
                    $daysToMonday = $dayOfWeek - 1;
                    $monday = clone $today;
                    $monday->modify("-{$daysToMonday} days");
                    $monday->setTime(0, 0, 0);
                    $sunday = clone $monday;
                    $sunday->modify('+6 days');
                    $sunday->setTime(23, 59, 59);
                    $mondayStr = $monday->format('Y-m-d');
                    $sundayStr = $sunday->format('Y-m-d');

                    $q = $pdo->prepare('SELECT DATE(l.loan_application_date) AS d, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE DATE(l.loan_application_date) >= ? AND DATE(l.loan_application_date) <= ?
                                       
                                       GROUP BY DATE(l.loan_application_date)
                                       ORDER BY d ASC');
                    $q->execute([$mondayStr, $sundayStr]);
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
                    $q = $pdo->prepare('SELECT DATE_FORMAT(l.loan_application_date, \'%Y-%m\') AS ym, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
                                       
                                       GROUP BY YEAR(l.loan_application_date), MONTH(l.loan_application_date)
                                       ORDER BY YEAR(l.loan_application_date), MONTH(l.loan_application_date) ASC');
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
                    $q = $pdo->prepare('SELECT DATE_FORMAT(l.loan_application_date, \'%Y\') AS y, COUNT(*) AS c
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_application_date >= DATE_SUB(CURDATE(), INTERVAL 4 YEAR)
                                       
                                       GROUP BY YEAR(l.loan_application_date)
                                       ORDER BY YEAR(l.loan_application_date) ASC');
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
            } elseif ($view === 'statusBreakdown') {
                $q = $pdo->prepare('SELECT label, SUM(value) AS value FROM (
                                  SELECT "Approved" AS label, COUNT(*) AS value
                                  FROM tbl_csdl_loans l
                                  JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                  WHERE l.loan_status_id = 2
                                    AND EXISTS (
                                        SELECT 1 FROM tbl_csdl_loan_approvals la
                                        WHERE la.approval_loan_id = l.loan_id
                                          AND la.approval_role_id = 101
                                          AND la.approval_status_id = 2
                                    )
                                  UNION ALL
                                  SELECT "Tagged" AS label, COUNT(*) AS value
                                  FROM tbl_csdl_loans l
                                  JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                  WHERE ' . assessmentPnTaggedWhere() . '
                              ) AS status_counts
                              GROUP BY label
                              ORDER BY value DESC');
                $q->execute();
                foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $labels[] = $r['label'];
                    $values[] = (int) $r['value'];
                }
            }

            echo json_encode(['success' => true, 'labels' => $labels, 'values' => $values]);
            return;
        } catch (Throwable $e) {
            echo json_encode(['success' => true, 'labels' => [], 'values' => []]);
            return;
        }
    }

    // All Applications: completed loans only (status ID 5)
    $stmt = $pdo->prepare('SELECT COUNT(*) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
        WHERE l.loan_status_id = 5 AND ' . assessmentPnOwnerWhere() . '');
    $stmt->execute();
    $allApplications = (int) $stmt->fetchColumn();

    // These cards represent Assessment activity across the shared queue.
    // Approved: Assessment recorded the approval decision for the loan.
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
        WHERE l.loan_status_id = 2
          AND EXISTS (
              SELECT 1 FROM tbl_csdl_loan_approvals la
              WHERE la.approval_loan_id = l.loan_id
                AND la.approval_role_id = 101
                AND la.approval_status_id = 2
          )');
    $stmt->execute();
    $approved = (int) $stmt->fetchColumn();

    // Endorsed: Assessment sent the loan to Branch Admin or COO.
    $stmt = $pdo->prepare('SELECT COUNT(*) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
        WHERE l.loan_status_id = 12
          AND EXISTS (
              SELECT 1 FROM tbl_csdl_loan_tracking lt
              WHERE lt.loan_tracking_loan_id = l.loan_id
                AND lt.loan_tracking_action IN ("Endorsed to Branch Admin", "Endorsed to COO")
                AND lt.loan_tracking_remarks LIKE "%Processed by Assessment employee%"
          )');
    $stmt->execute();
    $endorsed = (int) $stmt->fetchColumn();

    // PN Tagged: Assessment completed PN tagging.
    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT l.loan_id) c FROM tbl_csdl_loans l
        JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
        WHERE ' . assessmentPnTaggedWhere() . '');
    $stmt->execute();
    $pnTagged = (int) $stmt->fetchColumn();

    echo json_encode(['success' => true, 'stats' => [
        'allApplications' => $allApplications,
        'approved' => $approved,
        'endorsed' => $endorsed,
        'pnTagged' => $pnTagged,
    ], 'charts' => [
        'statusDistribution' => [
            'approved' => $approved,
            'tagged' => $pnTagged
        ]
    ]]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to load dashboard']);
}
