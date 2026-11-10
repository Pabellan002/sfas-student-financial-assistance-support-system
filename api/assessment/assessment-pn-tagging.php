<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-assessment-pn-tagging.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';
require_once __DIR__ . '/../includes/includes-send-push-notification.php';


if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$userRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
if ($userRoleId !== 101) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Assessment access is required.']);
    exit;
}

RBAC::init($pdo);
$employeeId = (int) ($_SESSION['user_id'] ?? 0);

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $action = $_GET['action'] ?? $_POST['action'] ?? '';
    $isExport = ($method === 'GET' && $action === 'export');
    if ($method === 'POST' && $action === 'tag_pn') {
        header('Content-Type: application/json');
        CSRFProtection::validateRequest();
        RBAC::requirePermission($employeeId, 'assessment.loans.tag_pn', 'You do not have permission to tag promissory notes.');
        $loanId = (int) ($_POST['loanId'] ?? 0);
        if ($loanId <= 0 || ($_POST['pnStatus'] ?? '') !== 'Tagged') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid PN tagging request.']);
            exit;
        }
        try {
            completeAssessmentPnTagging($pdo, $employeeId, $loanId, trim((string) ($_POST['remarks'] ?? '')));
            echo json_encode(['success' => true, 'message' => 'PN tagged successfully. Loan has been completed and student notified.']);
        } catch (PDOException $e) {
            error_log('PN tagging database error: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Unable to tag the PN right now.']);
        } catch (RuntimeException $e) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        }
        exit;
    }
    if ($method !== 'GET') {
        http_response_code(405);
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
        exit;
    }
    if ($isExport) {
        RBAC::requirePermission($employeeId, 'assessment.pntagging.export', 'You do not have permission to export PN tagging data');
    } else {
        RBAC::requirePermission($employeeId, 'assessment.pntagging.view', 'You do not have permission to view PN tagging data');
    }

    if ($method === 'GET' && $action === 'export') {
        $period = $_GET['period'] ?? '';
        $semester = $_GET['semester'] ?? '';
        $schoolYear = $_GET['schoolYear'] ?? '';
        $search = trim($_GET['search'] ?? '');
        $format = $_GET['format'] ?? 'csv';

        $whereConditions = [assessmentPnTaggingScopeSql()];
        $params = [];

        if ($period !== '') {
            $whereConditions[] = 'l.loan_app_period_id = :period';
            $params[':period'] = $period;
        }
        if ($semester !== '') {
            $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = :semester)';
            $params[':semester'] = $semester;
        }
        if ($schoolYear !== '') {
            $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = :schoolYear)';
            $params[':schoolYear'] = $schoolYear;
        }
        if ($search !== '') {
            $whereConditions[] = '(l.loan_application_no LIKE :search OR s.student_school_id LIKE :search2 OR CONCAT(s.student_first_name, \' \', s.student_last_name) LIKE :search3)';
            $params[':search'] = '%' . $search . '%';
            $params[':search2'] = '%' . $search . '%';
            $params[':search3'] = '%' . $search . '%';
        }

        $whereClause = 'WHERE ' . implode(' AND ', $whereConditions);

        $exportStmt = $pdo->prepare("SELECT l.loan_application_no AS 'Application No.', s.student_school_id AS 'Student ID', CONCAT(s.student_last_name, ', ', s.student_first_name, ' ', COALESCE(s.student_middle_name, '')) AS 'Student Name', FORMAT(l.loan_amount_can_pay, 2) AS 'Amount', COALESCE(ps.payment_status_name, 'Not Paid') AS 'Payment Status', ap.app_period_name AS 'Period', COALESCE(DATE_FORMAT(l.loan_paid_date, '%Y-%m-%d %h:%i:%s %p'), (SELECT DATE_FORMAT(lt.loan_tracking_created_at, '%Y-%m-%d %h:%i:%s %p') FROM tbl_csdl_loan_tracking lt WHERE lt.loan_tracking_loan_id = l.loan_id AND lt.loan_tracking_action = 'Payment Confirmed' ORDER BY lt.loan_tracking_created_at DESC LIMIT 1)) AS 'Paid Date', COALESCE(DATE_FORMAT(l.loan_pn_tagged_date, '%Y-%m-%d %h:%i:%s %p'), (SELECT DATE_FORMAT(la.approval_pn_date_processed, '%Y-%m-%d %h:%i:%s %p') FROM tbl_csdl_loan_approvals la WHERE la.approval_loan_id = l.loan_id AND la.approval_pn_tagging IN ('Paid', 'Tagged', 'PN Tagged') ORDER BY la.approval_pn_date_processed DESC LIMIT 1)) AS 'Tagged Date' FROM tbl_csdl_loans l LEFT JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id $whereClause ORDER BY l.loan_application_date DESC, l.loan_id DESC");
        foreach ($params as $k => $v) {
            $exportStmt->bindValue($k, $v);
        }
        $exportStmt->execute();
        $data = $exportStmt->fetchAll(PDO::FETCH_ASSOC);

        $filename = 'assessment_tagged_loans_' . date('Y-m-d_His');

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
                fputcsv($output, ['Application No.', 'Student ID', 'Student Name', 'Amount', 'Payment Status', 'Period', 'Paid Date', 'Tagged Date']);
            }
            fclose($output);
        } elseif ($format === 'pdf') {
            header('Content-Type: application/pdf');
            header('Content-Disposition: attachment; filename="' . $filename . '.pdf"');
            
            $html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
                body { font-family: Arial, sans-serif; font-size: 10px; }
                h1 { text-align: center; color: #03600f; font-size: 16px; margin-bottom: 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
                th { background-color: #03600f; color: white; font-weight: bold; }
                tr:nth-child(even) { background-color: #f9f9f9; }
            </style></head><body>';
            $html .= '<h1>' . htmlspecialchars('Assessment') . ' - PN Tagged Loans Report</h1>';
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
                $html .= '<th>Application No.</th><th>Student ID</th><th>Student Name</th><th>Amount</th><th>Payment Status</th><th>Period</th><th>Paid Date</th><th>Tagged Date</th></tr></thead><tbody>';
                $html .= '<tr><td colspan="8" style="text-align:center;">No data available</td></tr>';
            }
            
            $html .= '</tbody></table></body></html>';
            echo $html;
        } elseif ($format === 'word') {
            header('Content-Type: application/vnd.ms-word');
            header('Content-Disposition: attachment; filename="' . $filename . '.doc"');
            
            $html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">';
            $html .= '<head><meta charset="UTF-8"><style>
                body { font-family: Arial, sans-serif; font-size: 11pt; }
                h1 { text-align: center; color: #03600f; margin-bottom: 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #000; padding: 8px; text-align: left; }
                th { background-color: #03600f; color: white; font-weight: bold; }
            </style></head><body>';
            $html .= '<h1>' . htmlspecialchars('Assessment') . ' - PN Tagged Loans Report</h1>';
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
                $html .= '<th>Application No.</th><th>Student ID</th><th>Student Name</th><th>Amount</th><th>Payment Status</th><th>Period</th><th>Paid Date</th><th>Tagged Date</th></tr></thead><tbody>';
                $html .= '<tr><td colspan="8" style="text-align:center;">No data available</td></tr>';
            }
            
            $html .= '</tbody></table></body></html>';
            echo $html;
        }
        exit;
    }

    header('Content-Type: application/json');

    if ($action === 'filters') {
        $periodsStmt = $pdo->query("SELECT app_period_id, app_period_name FROM tbl_csdl_application_periods ORDER BY app_period_name");
        $periods = $periodsStmt->fetchAll(PDO::FETCH_ASSOC);
        
        $semestersStmt = $pdo->query("SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id");
        $semesters = $semestersStmt->fetchAll(PDO::FETCH_ASSOC);
        
        $schoolYearsStmt = $pdo->query("SELECT sy_id, sy_code, CONCAT(sy_code, ' - ', sem.semester_name) AS sy_name FROM tbl_csdl_school_years sy LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id ORDER BY sy_start_date DESC");
        $schoolYears = $schoolYearsStmt->fetchAll(PDO::FETCH_ASSOC);
        
        echo json_encode(['success' => true, 'periods' => $periods, 'semesters' => $semesters, 'schoolYears' => $schoolYears]);
        exit;
    }

    if ($action === 'stats') {
        $period = $_GET['period'] ?? '';
        $semester = $_GET['semester'] ?? '';
        $schoolYear = $_GET['schoolYear'] ?? '';
        $search = trim($_GET['search'] ?? '');

        $whereConditions = [assessmentPnTaggingScopeSql()];
        $params = [];
        if ($period !== '') {
            $whereConditions[] = 'l.loan_app_period_id = :period';
            $params[':period'] = $period;
        }
        if ($semester !== '') {
            $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = :semester)';
            $params[':semester'] = $semester;
        }
        if ($schoolYear !== '') {
            $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = :schoolYear)';
            $params[':schoolYear'] = $schoolYear;
        }
        if ($search !== '') {
            $whereConditions[] = '(l.loan_application_no LIKE :search OR s.student_school_id LIKE :search2 OR CONCAT(s.student_first_name, \' \', s.student_last_name) LIKE :search3)';
            $params[':search'] = '%' . $search . '%';
            $params[':search2'] = '%' . $search . '%';
            $params[':search3'] = '%' . $search . '%';
        }
        $whereClause = 'WHERE ' . implode(' AND ', $whereConditions);

        $pendingApplicationsSql = "SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l LEFT JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id $whereClause
            AND l.loan_status_id = 2
            AND l.loan_current_step_id = 11
            AND l.loan_pn_status_id <> 2
            AND l.loan_pn_tagged_date IS NULL";
        $pendingApplicationsStmt = $pdo->prepare($pendingApplicationsSql);
        $taggedApplicationsSql = "SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l LEFT JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id $whereClause
            AND (l.loan_pn_status_id = 2 OR l.loan_pn_tagged_date IS NOT NULL)";
        $taggedApplicationsStmt = $pdo->prepare($taggedApplicationsSql);
        
        foreach ($params as $k => $v) {
            $pendingApplicationsStmt->bindValue($k, $v);
            $taggedApplicationsStmt->bindValue($k, $v);
        }
        
        $pendingApplicationsStmt->execute();
        $taggedApplicationsStmt->execute();
        
        $pendingApplications = (int) $pendingApplicationsStmt->fetchColumn();
        $taggedApplications = (int) $taggedApplicationsStmt->fetchColumn();
        echo json_encode([
            'success' => true,
            'stats' => ['pending' => $pendingApplications, 'tagged' => $taggedApplications]
        ]);
        exit;
    }

    if ($action === 'chart') {
        $view = $_GET['view'] ?? 'allPeriods';
        $period = $_GET['period'] ?? '';

        $whereConditions = [assessmentPnTaggingScopeSql()];
        $params = [];

        if ($period !== '') {
            $whereConditions[] = 'l.loan_app_period_id = :period';
            $params[':period'] = $period;
        }

        $whereClause = 'WHERE ' . implode(' AND ', $whereConditions);

        if ($view === 'loanStatus') {
            // The secondary chart shows workflow status, not the old PN tagging values.
            $approvedSql = "SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l $whereClause AND l.loan_status_id = 2";
            $partialSql = "SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l $whereClause AND l.loan_status_id = 11";

            $approvedStmt = $pdo->prepare($approvedSql);
            $partialStmt = $pdo->prepare($partialSql);
            foreach ($params as $k => $v) {
                $approvedStmt->bindValue($k, $v);
                $partialStmt->bindValue($k, $v);
            }
            $approvedStmt->execute();
            $partialStmt->execute();
            $approved = (int) $approvedStmt->fetchColumn();
            $partial = (int) $partialStmt->fetchColumn();

            echo json_encode([
                'success' => true,
                'chart' => ['labels' => ['Approved', 'Partial Payment'], 'values' => [$approved, $partial]]
            ]);
        } else {
            // allPeriods view
            $periodChartStmt = $pdo->prepare("SELECT ap.app_period_name AS label, COUNT(DISTINCT l.loan_id) AS value FROM tbl_csdl_loans l INNER JOIN tbl_csdl_loan_approvals la ON la.approval_loan_id = l.loan_id AND la.approval_pn_tagging IS NOT NULL LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id $whereClause GROUP BY ap.app_period_id, ap.app_period_name ORDER BY ap.app_period_name LIMIT 20");
            foreach ($params as $k => $v) {
                $periodChartStmt->bindValue($k, $v);
            }
            $periodChartStmt->execute();
            $periodRows = $periodChartStmt->fetchAll(PDO::FETCH_ASSOC);
            $periodLabels = array_column($periodRows, 'label');
            $periodValues = array_map('intval', array_column($periodRows, 'value'));

            echo json_encode([
                'success' => true,
                'chart' => ['labels' => $periodLabels, 'values' => $periodValues]
            ]);
        }
        exit;
    }

    if ($action === 'list') {
        $period = $_GET['period'] ?? '';
        $semester = $_GET['semester'] ?? '';
        $schoolYear = $_GET['schoolYear'] ?? '';
        $search = trim($_GET['search'] ?? '');
        $paymentStatus = strtolower(trim($_GET['paymentStatus'] ?? ''));
        $pnStatus = $_GET['pnStatus'] ?? '';
        $tagged = isset($_GET['tagged']) && $_GET['tagged'] === '1';
        $overdue = isset($_GET['overdue']) && $_GET['overdue'] === '1';
        $page = max(1, (int) ($_GET['page'] ?? 1));
        $perPage = max(1, min(100, (int) ($_GET['perPage'] ?? 25)));
        $offset = ($page - 1) * $perPage;

        $whereConditions = [assessmentPnTaggingScopeSql()];
        $params = [];

        if ($period !== '') {
            $whereConditions[] = 'l.loan_app_period_id = :period';
            $params[':period'] = $period;
        }
        
        if ($semester !== '') {
            $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal JOIN tbl_csdl_school_years sy ON sy.sy_id = bal.balance_sy_id WHERE bal.balance_id = l.loan_balance_id AND sy.sy_semester_id = :semester)';
            $params[':semester'] = $semester;
        }
        
        if ($schoolYear !== '') {
            $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_balances bal WHERE bal.balance_id = l.loan_balance_id AND bal.balance_sy_id = :schoolYear)';
            $params[':schoolYear'] = $schoolYear;
        }
        
        if ($search !== '') {
            $whereConditions[] = '(l.loan_application_no LIKE :search OR s.student_school_id LIKE :search2 OR CONCAT(s.student_first_name, \' \', s.student_last_name) LIKE :search3)';
            $params[':search'] = '%' . $search . '%';
            $params[':search2'] = '%' . $search . '%';
            $params[':search3'] = '%' . $search . '%';
        }
        if ($paymentStatus === 'pending') {
            $whereConditions[] = 'l.loan_payment_status_id IN (1, 2)';
        } elseif ($paymentStatus === 'paid') {
            $whereConditions[] = 'l.loan_payment_status_id = 3';
        }
        if ($overdue) {
            $whereConditions[] = 'l.loan_due_date IS NOT NULL AND l.loan_due_date < CURDATE()';
        }
        if ($pnStatus !== '') {
            // Support multiple PN statuses separated by comma
            $statuses = array_map('trim', explode(',', $pnStatus));
            if (count($statuses) > 1) {
                $placeholders = [];
                foreach ($statuses as $i => $status) {
                    $key = ':pnStatus' . $i;
                    $placeholders[] = $key;
                    $params[$key] = $status;
                }
                $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IN (' . implode(',', $placeholders) . '))';
            } else {
                $whereConditions[] = 'EXISTS (SELECT 1 FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging = :pnStatus)';
                $params[':pnStatus'] = $pnStatus;
            }
        }
        if ($tagged) {
            $whereConditions[] = '(l.loan_pn_status_id = 2 OR l.loan_pn_tagged_date IS NOT NULL)';
        }
        if (($_GET['pending'] ?? '') === '1') {
            $whereConditions[] = 'l.loan_status_id = 2 AND l.loan_current_step_id = ' . 11
                . ' AND l.loan_pn_status_id <> 2 AND l.loan_pn_tagged_date IS NULL';
        }
        // Filter by loan status ID (e.g., 3=Declined, 6=Returned)
        $loanStatus = $_GET['loanStatus'] ?? '';
        if ($loanStatus !== '') {
            $loanStatusIds = array_map('intval', array_map('trim', explode(',', $loanStatus)));
            if (count($loanStatusIds) > 1) {
                $placeholders = [];
                foreach ($loanStatusIds as $i => $sid) {
                    $key = ':loanStatus' . $i;
                    $placeholders[] = $key;
                    $params[$key] = $sid;
                }
                $whereConditions[] = 'l.loan_status_id IN (' . implode(',', $placeholders) . ')';
            } else {
                $whereConditions[] = 'l.loan_status_id = :loanStatus';
                $params[':loanStatus'] = $loanStatusIds[0];
            }
        }

        $whereClause = 'WHERE ' . implode(' AND ', $whereConditions);

        $countStmt = $pdo->prepare("SELECT COUNT(DISTINCT l.loan_id) FROM tbl_csdl_loans l LEFT JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id $whereClause");
        foreach ($params as $k => $v) {
            $countStmt->bindValue($k, $v);
        }
        $countStmt->execute();
        $total = (int) $countStmt->fetchColumn();

        $dataStmt = $pdo->prepare("SELECT l.loan_id, l.loan_current_step_id, l.loan_pn_status_id, l.loan_application_no, s.student_school_id AS student_school_id, CONCAT(s.student_last_name, ', ', s.student_first_name, ' ', COALESCE(s.student_middle_name, '')) AS student_name, l.loan_amount_can_pay, l.loan_status_id, ls.loan_status_name, COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status, ap.app_period_name, (SELECT approval_pn_tagging FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL ORDER BY approval_pn_date_processed DESC LIMIT 1) AS pn_status, COALESCE(l.loan_paid_date, (SELECT lt.loan_tracking_created_at FROM tbl_csdl_loan_tracking lt WHERE lt.loan_tracking_loan_id = l.loan_id AND lt.loan_tracking_action = 'Payment Confirmed' ORDER BY lt.loan_tracking_created_at DESC LIMIT 1)) AS paid_date, COALESCE(l.loan_pn_tagged_date, (SELECT la.approval_pn_date_processed FROM tbl_csdl_loan_approvals la WHERE la.approval_loan_id = l.loan_id AND la.approval_pn_tagging IN ('Paid', 'Tagged', 'PN Tagged') ORDER BY la.approval_pn_date_processed DESC LIMIT 1)) AS tagged_date FROM tbl_csdl_loans l LEFT JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id $whereClause ORDER BY l.loan_application_date DESC, l.loan_id DESC LIMIT :limit OFFSET :offset");
        foreach ($params as $k => $v) {
            $dataStmt->bindValue($k, $v);
        }
        $dataStmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
        $dataStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $dataStmt->execute();
        $data = $dataStmt->fetchAll(PDO::FETCH_ASSOC);

        $totalPages = $total > 0 ? (int) ceil($total / $perPage) : 0;

        echo json_encode(['success' => true, 'data' => $data, 'total' => $total, 'totalPages' => $totalPages, 'page' => $page, 'perPage' => $perPage]);
        exit;
    }

    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
} catch (Throwable $e) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Failed to process request']);
}
?>
