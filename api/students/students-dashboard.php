<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

// Check if user is a student
if (!isset($_SESSION['user_id']) || !isset($_SESSION['user_type']) || $_SESSION['user_type'] !== 'student') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$studentId = $_SESSION['user_id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';
    
    if ($action === 'profile') {
        try {
            $stmt = $pdo->prepare("SELECT 
                s.student_id,
                s.student_school_id,
                s.student_first_name,
                s.student_middle_name,
                s.student_last_name,
                s.student_date_of_birth,
                s.student_gender,
                s.student_contact_number,
                s.student_email,
                s.student_fb_account,
                s.student_profile_image,
                p.program_name,
                yl.year_level_name,
                c.campus_name,
                sch.scholarship_name
            FROM tbl_csdl_students s
            LEFT JOIN tbl_csdl_programs p ON p.program_id = s.student_program_id
            LEFT JOIN tbl_csdl_year_levels yl ON yl.year_level_id = s.student_year_level_id
            LEFT JOIN tbl_csdl_campuses c ON c.campus_id = s.student_campus_id
            LEFT JOIN tbl_csdl_scholarships sch ON sch.scholarship_id = s.student_scholarship_id
            WHERE s.student_id = ?");
            $stmt->execute([$studentId]);
            $profile = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$profile) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Profile not found']);
                return;
            }
            
            echo json_encode(['success' => true, 'profile' => $profile]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Profile error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching profile']);
        }
        return;
    }
    
    if ($action === 'stats') {
        try {
            $stats = [];
            
            // Pending
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 1");
            $stmt->execute([$studentId]);
            $stats['pending'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Under Review
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 2");
            $stmt->execute([$studentId]);
            $stats['underReview'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Approved
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 2");
            $stmt->execute([$studentId]);
            $stats['approved'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Declined
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 3");
            $stmt->execute([$studentId]);
            $stats['declined'] = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            echo json_encode(['success' => true, 'stats' => $stats]);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => 'Error fetching stats']);
        }
        return;
    }
    
    if ($action === 'form-settings') {
        try {
            $stmt = $pdo->prepare("SELECT setting_key, setting_value FROM tbl_csdl_settings WHERE setting_key IN ('form_title', 'form_description', 'form_instructions')");
            $stmt->execute();
            $settings = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            $formSettings = [
                'form_title' => 'PHINMA COC Student Financial Assistance Application Form',
                'form_description' => 'This form is intended for PHINMA COC Students only. Students can apply for an interest-free loan to ensure the examination permit is secured on time or request a forward balance during enrollment.',
                'form_instructions' => "Application is open one week before every periodic examination within office hours: Monday - Friday: 7:30 AM - 5:00 PM; Saturday: 8:00 AM - 12:00 NN.\nStudents must attach/submit one (1) valid ID of parent/guardian with signature.\nThe maximum amount per student is Php 3,000.00. Loans above Php 3,000.00 require the approval of the Controller or COO.\nWait 1-2 days for the verification process. Status will be sent to your PHINMAEd email or via call/text from CSDL/Finance/COO Office.\nApproved loan amount shall be paid on or before the due date (within 30 days)."
            ];
            
            foreach ($settings as $setting) {
                $formSettings[$setting['setting_key']] = $setting['setting_value'];
            }
            
            echo json_encode(['success' => true, 'settings' => $formSettings]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Student form settings error: ' . $e->getMessage() . ' | Trace: ' . $e->getTraceAsString());
            echo json_encode(['success' => false, 'message' => 'Error fetching form settings']);
        }
        return;
    }
    
    if ($action === 'loan-summary') {
        try {
            // Total loans
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ?");
            $stmt->execute([$studentId]);
            $totalLoans = (int)$stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Paid loans (completed/paid status - status_id 5 = Completed)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 5");
            $stmt->execute([$studentId]);
            $paidLoans = (int)$stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Active loans (approved status - status_id = 2)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 2");
            $stmt->execute([$studentId]);
            $activeLoans = (int)$stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            // Pending loans (status_id = 1)
            $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM tbl_csdl_loans WHERE loan_student_id = ? AND loan_status_id = 1");
            $stmt->execute([$studentId]);
            $pendingLoans = (int)$stmt->fetch(PDO::FETCH_ASSOC)['count'];
            
            echo json_encode([
                'success' => true,
                'summary' => [
                    'total' => $totalLoans,
                    'paid' => $paidLoans,
                    'active' => $activeLoans,
                    'pending' => $pendingLoans
                ]
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Loan summary error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching loan summary']);
        }
        return;
    }
    
    if ($action === 'balance') {
        try {
            // Get the latest balance for the student
            $stmt = $pdo->prepare("SELECT b.*, sy.sy_code 
                                   FROM tbl_csdl_balances b
                                   LEFT JOIN tbl_csdl_school_years sy ON sy.sy_id = b.balance_sy_id
                                   WHERE b.balance_student_id = ?
                                   ORDER BY b.balance_as_of_date DESC, b.balance_created_at DESC
                                   LIMIT 1");
            $stmt->execute([$studentId]);
            $balance = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$balance) {
                echo json_encode([
                    'success' => true,
                    'balance' => null
                ]);
                return;
            }
            
            echo json_encode([
                'success' => true,
                'balance' => [
                    'total_balance' => $balance['balance_total_balance'] ?? '0.00',
                    'previous_balance' => $balance['balance_previous_balance'] ?? '0.00',
                    'current_balance' => $balance['balance_current_balance'] ?? '0.00',
                    'advice_to_pay' => $balance['balance_advice_to_pay'] ?? '0.00',
                    'school_year' => $balance['sy_code'] ?? null,
                    'as_of_date' => $balance['balance_as_of_date'] ?? null
                ]
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Balance API error: ' . $e->getMessage());
            error_log('Stack trace: ' . $e->getTraceAsString());
            echo json_encode([
                'success' => false, 
                'message' => 'Error fetching balance'
            ]);
        }
        return;
    }
    
    if ($action === 'recent') {
        try {
            $page = max(1, intval($_GET['page'] ?? 1));
            $limit = max(1, min(intval($_GET['limit'] ?? 5), 50)); // Between 1 and 50
            $offset = ($page - 1) * $limit;
            
            // Get total count
            $countStmt = $pdo->prepare("SELECT COUNT(*) as total FROM tbl_csdl_loans WHERE loan_student_id = ?");
            $countStmt->execute([$studentId]);
            $total = $countStmt->fetch(PDO::FETCH_ASSOC)['total'];
            
            // Get loans with pagination
            $stmt = $pdo->prepare("SELECT l.loan_id,
                                          l.loan_application_no,
                                          l.loan_amount_can_pay,
                                          b.balance_advice_to_pay,
                                          l.loan_status_id,
                                          ls.loan_status_name,
                                          l.loan_current_step_id,
                                          ws.step_name as current_step_name,
                                          l.loan_application_date,
                                          l.loan_updated_at,
                                          l.loan_due_date,
                                          l.loan_promised_payment_date,
                                          l.loan_expiry_timestamp,
                                          ap.app_period_name,
                                          COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                                          COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status
                                   FROM tbl_csdl_loans l
                                   LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                                   LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                                   LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                                   LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                                   LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                                   LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                                   WHERE l.loan_student_id = ?
                                   ORDER BY l.loan_application_date DESC, l.loan_id DESC
                                   LIMIT ? OFFSET ?");
            $stmt->execute([$studentId, $limit, $offset]);
            $loans = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode([
                'success' => true,
                'loans' => $loans,
                'total' => (int)$total,
                'page' => $page,
                'limit' => $limit,
                'totalPages' => ceil($total / $limit)
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Recent loans error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching recent loans']);
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
            // Verify loan belongs to this student
            $checkStmt = $pdo->prepare("SELECT loan_id FROM tbl_csdl_loans WHERE loan_id = ? AND loan_student_id = ?");
            $checkStmt->execute([$loanId, $studentId]);
            if (!$checkStmt->fetch()) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Access denied']);
                return;
            }
            
            $sql = "SELECT l.*,
                           s.student_school_id,
                           CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) as student_name,
                           s.student_email,
                           s.student_contact_number,
                           p.program_name,
                           yl.year_level_name,
                           ls.loan_status_name,
                           ws.step_name as current_step_name,
                           ap.app_period_name,
                           g.guardian_name,
                           g.guardian_id,
                           g.guardian_relationship_id,
                           rel.relationship_name as guardian_relationship,
                           g.guardian_contact,
                           b.balance_total_balance,
                           b.balance_current_balance,
                           b.balance_advice_to_pay,
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
                    WHERE l.loan_id = ? AND l.loan_student_id = ?";
            
            $stmt = $pdo->prepare($sql);
            $stmt->execute([$loanId, $studentId]);
            $loan = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Loan not found']);
                return;
            }
            
            // Get documents
            $docStmt = $pdo->prepare("SELECT ld.*, dt.doc_type_name 
                                      FROM tbl_csdl_loan_documents ld
                                      LEFT JOIN tbl_csdl_document_types dt ON dt.doc_type_id = ld.loan_document_doc_type_id
                                      WHERE ld.loan_document_loan_id = ?");
            $docStmt->execute([$loanId]);
            $loan['documents'] = $docStmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Get tracking history
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
                                        WHERE lt.loan_tracking_loan_id = ?
                                        ORDER BY lt.loan_tracking_created_at DESC");
            $trackStmt->execute([$loanId]);
            $loan['tracking'] = $trackStmt->fetchAll(PDO::FETCH_ASSOC);
            
            echo json_encode(['success' => true, 'loan' => $loan]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Loan details error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching loan details']);
        }
        return;
    }

    if ($action === 'calendar') {
        try {
            $year = max(1970, min(2100, (int) ($_GET['year'] ?? date('Y'))));
            $month = max(1, min(12, (int) ($_GET['month'] ?? date('n'))));
            $monthStart = sprintf('%04d-%02d-01', $year, $month);
            $monthEnd = date('Y-m-t', strtotime($monthStart));

            $dueDates = [];
            $dueStmt = $pdo->prepare("SELECT
                    l.loan_id,
                    l.loan_application_no,
                    l.loan_amount_can_pay,
                    l.loan_status_id,
                    ls.loan_status_name,
                    DATE(l.loan_due_date) AS event_date,
                    ap.app_period_name,
                    COALESCE(ps.payment_status_name, 'Not Paid') AS payment_status,
                    COALESCE(pns.pn_status_name, 'Not Tagged') AS pn_status
                FROM tbl_csdl_loans l
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                LEFT JOIN tbl_csdl_application_periods ap ON ap.app_period_id = l.loan_app_period_id
                LEFT JOIN tbl_csdl_payment_statuses ps ON ps.payment_status_id = l.loan_payment_status_id
                LEFT JOIN tbl_csdl_pn_statuses pns ON pns.pn_status_id = l.loan_pn_status_id
                WHERE l.loan_student_id = ?
                  AND l.loan_due_date IS NOT NULL
                  AND l.loan_status_id NOT IN (3, 8, 9)
                  AND DATE(l.loan_due_date) BETWEEN ? AND ?
                ORDER BY l.loan_application_date DESC, l.loan_due_date ASC, l.loan_id DESC");
            $dueStmt->execute([$studentId, $monthStart, $monthEnd]);
            $dueByDate = [];
            foreach ($dueStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                if (empty($row['event_date'])) {
                    continue;
                }
                $dateKey = $row['event_date'];
                if (!isset($dueByDate[$dateKey])) {
                    $dueByDate[$dateKey] = [];
                }
                $dueByDate[$dateKey][] = [
                    'loan_id' => (int) $row['loan_id'],
                    'application_no' => $row['loan_application_no'],
                    'amount' => $row['loan_amount_can_pay'] !== null
                        ? number_format((float) $row['loan_amount_can_pay'], 2, '.', '')
                        : '0.00',
                    'period_name' => $row['app_period_name'],
                    'status_id' => (int) ($row['loan_status_id'] ?? 0),
                    'status_name' => $row['loan_status_name'] ?? '',
                    'payment_status' => $row['payment_status'] ?? 'Not Paid',
                    'pn_status' => $row['pn_status'] ?? ''
                ];
            }
            foreach ($dueByDate as $date => $loans) {
                $dueDates[] = [
                    'date' => $date,
                    'loans' => $loans
                ];
            }

            $examDates = [];
            try {
                $examStmt = $pdo->prepare("SELECT 
                        es.exam_start_date,
                        es.exam_end_date,
                        ap.app_period_name,
                        sy.sy_code
                    FROM tbl_csdl_exam_schedules es
                    INNER JOIN tbl_csdl_application_periods ap ON ap.app_period_id = es.exam_period_id
                    INNER JOIN tbl_csdl_school_years sy ON sy.sy_id = es.exam_sy_id
                    WHERE es.exam_status = 1
                      AND es.exam_start_date <= ?
                      AND COALESCE(es.exam_end_date, es.exam_start_date) >= ?");
                $examStmt->execute([$monthEnd, $monthStart]);
                $schedules = $examStmt->fetchAll(PDO::FETCH_ASSOC);

                $examMap = [];
                foreach ($schedules as $schedule) {
                    $start = $schedule['exam_start_date'];
                    $end = $schedule['exam_end_date'] ?: $start;
                    $cursor = strtotime($start);
                    $endTs = strtotime($end);
                    if ($cursor === false || $endTs === false) {
                        continue;
                    }
                    while ($cursor <= $endTs) {
                        $dateKey = date('Y-m-d', $cursor);
                        if ($dateKey >= $monthStart && $dateKey <= $monthEnd) {
                            if (!isset($examMap[$dateKey])) {
                                $examMap[$dateKey] = [];
                            }
                            $examMap[$dateKey][] = [
                                'period_name' => $schedule['app_period_name'],
                                'sy_code' => $schedule['sy_code'],
                                'exam_start_date' => $schedule['exam_start_date'],
                                'exam_end_date' => $schedule['exam_end_date'] ?: $schedule['exam_start_date']
                            ];
                        }
                        $cursor = strtotime('+1 day', $cursor);
                    }
                }

                foreach ($examMap as $date => $items) {
                    $examDates[] = [
                        'date' => $date,
                        'items' => $items
                    ];
                }
            } catch (PDOException $e) {
                if (strpos($e->getMessage(), 'tbl_csdl_exam_schedules') === false) {
                    throw $e;
                }
            }

            echo json_encode([
                'success' => true,
                'due_dates' => $dueDates,
                'exam_dates' => $examDates
            ]);
        } catch (Throwable $e) {
            http_response_code(500);
            error_log('Student calendar error: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Error fetching calendar events']);
        }
        return;
    }
    
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid action']);
    return;
}

http_response_code(405);
echo json_encode(['success' => false, 'message' => 'Method not allowed']);
?>
