<?php
/**
 * Branch Admin loans management (Active Loans) — workflow step 3, role 98, campus scoped.
 */
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';
require_once __DIR__ . '/../includes/includes-loan-promised-amount.php';
require_once __DIR__ . '/../includes/includes-send-push-notification.php';
require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';

header('Content-Type: application/json');

// Auth check
if (!isset($_SESSION['user_id']) || ($_SESSION['user_type'] ?? '') !== 'employee') {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$userRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
if ($userRoleId !== 98) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Access denied. Branch Admin role required.']);
    exit;
}

$employeeCampusStmt = $pdo->prepare('SELECT employee_campus_id FROM tbl_csdl_employees WHERE employee_id = ? AND employee_role_id = 98 AND employee_status = 1');
$employeeCampusStmt->execute([(int) $_SESSION['user_id']]);
$campusId = (int) ($employeeCampusStmt->fetchColumn() ?: 0);
if ($campusId <= 0) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'No campus assigned to your account.']);
    exit;
}

RBAC::init($pdo);
$employeeId = (int) $_SESSION['user_id'];

queueOverdueLoanNotifications($pdo);

const BRANCH_STEP = 3;

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        CSRFProtection::validateRequest();
        // Read JSON input
        $input = json_decode(file_get_contents('php://input'), true);
        if (!$input) {
            $input = $_POST;
        }
        
        $action = $input['action'] ?? '';
        
        // New workflow: Branch Admin receives endorsed loans from Assessment (₱7,501-₱9,999)
        if ($action === 'process') {
            $loanId = (int) ($input['loanId'] ?? 0);
            $processType = strtolower(trim((string) ($input['processType'] ?? '')));
            $remarks = trim((string) ($input['remarks'] ?? ''));
            $amountApprovedInput = $input['amountApproved'] ?? null;
            $amountApproved = is_scalar($amountApprovedInput) ? (float) $amountApprovedInput : 0;
            $partialAmount = round((float) ($input['partialPaymentAmount'] ?? 0), 2);
            $employeeId = (int) $_SESSION['user_id'];
            
            if ($loanId <= 0 || !in_array($processType, ['approve', 'partial'], true)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid loan action.']);
                exit;
            }

            $permissionByAction = [
                'approve' => 'branch_admin.loans.approve',
                'partial' => 'branch_admin.loans.partial_payment',
            ];
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
                
                if (!$loan || (int) $loan['student_campus_id'] !== $campusId) {
                    throw new RuntimeException('This loan is not assigned to your campus.');
                }
                
                // Branch Admin receives Assessment-endorsed loans for its own campus.
                if ((int) $loan['loan_current_step_id'] !== 3 || (int) $loan['loan_status_id'] !== 12) {
                    throw new RuntimeException('This loan is not waiting for Branch Admin review.');
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
                    $remainingBalance = max(0, $balanceTotal - $approvalAmount);
                    
                    // NEW WORKFLOW: Branch Admin handles loans ₱7,501-₱9,999, routes to Cashier
                    if ($remainingBalance <= 7500) {
                        throw new InvalidArgumentException('Branch Admin handles loans above ₱7,500 only.');
                    }
                    if ($remainingBalance > 10000) {
                        throw new InvalidArgumentException('Branch Admin handles loans below ₱10,000 only. This loan should be endorsed to COO.');
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
                    
                } elseif ($processType === 'partial') {
                    if ($partialAmount <= 0) {
                        throw new InvalidArgumentException('Enter a partial-payment amount greater than zero.');
                    }
                    // Use the workflow threshold's remaining balance rather than the
                    // balance record's current balance for partial-payment validation.
                    $remainingBalance = max(0, (float) ($loan['balance_total_balance'] ?? 0)
                        - (float) ($loan['loan_amount_can_pay'] ?? 0));
                    if ($partialAmount > $remainingBalance) {
                        throw new InvalidArgumentException(
                            'The partial payment cannot be greater than the remaining balance (₱'
                            . number_format($remainingBalance, 2) . ').'
                        );
                    }
                    $newAmountCanPay = round($loanAmount + $partialAmount, 2);
                    
                    // NEW WORKFLOW: Partial payment routes to Cashier after student pays
                    $nextStepId = 2; // Cashier step
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
                
                // Get recipients for next office
                $recipients = [];
                if ($nextRoleId > 0) {
                    $recipientStmt = $pdo->prepare('SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = ? AND employee_status = 1');
                    $recipientStmt->execute([$nextRoleId]);
                    $recipients = array_map('intval', $recipientStmt->fetchAll(PDO::FETCH_COLUMN));
                    if ($recipients === []) {
                        throw new RuntimeException('Cashier does not have an active employee at this campus.');
                    }
                }
                
                // Update loan
                if ($processType === 'partial') {
                    // Add the partial amount to the existing Amount Can Pay and
                    // retain the additional amount separately for audit/Cashier use.
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
                } else { // approve
                    $updateStmt = $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 2, loan_payment_status_id = CASE WHEN loan_payment_status_id = 4 THEN 4 ELSE 1 END, loan_current_step_id = ?, loan_amount_can_pay = ?, loan_approval_date = CURDATE(), loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?');
                    $updateStmt->execute([$nextStepId, $approvalAmount, $employeeId, $loanId]);
                }
                
                // Add approval record (not for return)
                if ($processType !== 'return') {
                    $approvalCheck = $pdo->prepare('SELECT approval_id FROM tbl_csdl_loan_approvals WHERE approval_loan_id = ? AND approval_step_id = 3 AND approval_role_id = 98 ORDER BY approval_id DESC LIMIT 1');
                    $approvalCheck->execute([$loanId]);
                    $approvalId = (int) ($approvalCheck->fetchColumn() ?: 0);
                    if ($approvalId > 0) {
                        $approvalStmt = $pdo->prepare("UPDATE tbl_csdl_loan_approvals SET approval_amount_approved = ?, approval_processed_by = ?, approval_date_processed = NOW(), approval_channel_used = 'Email', approval_date_contacted = NOW(), approval_remarks = ?, approval_status_id = ?, approval_approved_email = 1, approval_updated_at = NOW() WHERE approval_id = ?");
                        $approvalStmt->execute([$approvalAmount, $employeeId, $remarks, $approvalStatusId, $approvalId]);
                    } else {
                        $approvalStmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_approvals (approval_loan_id, approval_step_id, approval_role_id, approval_amount_approved, approval_processed_by, approval_date_processed, approval_channel_used, approval_date_contacted, approval_remarks, approval_status_id, approval_approved_email) VALUES (?, 3, 98, ?, ?, NOW(), 'Email', NOW(), ?, ?, 1)");
                        $approvalStmt->execute([$loanId, $approvalAmount, $employeeId, $remarks, $approvalStatusId]);
                    }
                }
                
                // Add tracking entry
                $trackStmt = $pdo->prepare('INSERT INTO tbl_csdl_loan_tracking (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by) VALUES (?, ?, ?, ?, ?)');
                // loan_tracking_updated_by is constrained to tbl_csdl_students.student_id.
                // A Branch Admin is an employee, so we use the student's ID for FK and retain the
                // staff identity in the audit remark to track who actually processed it.
                $trackStmt->execute([$loanId, $nextStepId, $trackingAction, $trackingRemarks . " Processed by Branch Admin employee #{$employeeId}.", (int) $loan['loan_student_id']]);
                
                // Send notifications
                $notifyStmt = $pdo->prepare('INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, ?, NOW())');
                $pushQueue = [];
                foreach ($recipients as $recipientId) {
                    $officeTitle = 'Loan Assigned for Review';
                    $officeMessage = "Loan {$loan['loan_application_no']} is now assigned to your office.";
                    $notifyStmt->execute([$recipientId, null, $nextStepId, $loanId, $officeTitle, $officeMessage]);
                    $pushQueue[] = [$recipientId, 'employee', (int) $pdo->lastInsertId(), $officeTitle, $officeMessage];
                }
                $notifyStmt->execute([null, (int) $loan['loan_student_id'], $nextStepId, $loanId, $studentTitle, $studentMessage]);
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
                    senderRole: 'branch_admin'
                );
                foreach ($pushQueue as [$recipientId, $recipientType, $notificationId, $title, $message]) {
                    sendPushNotification($pdo, $recipientId, $recipientType, ['id' => $notificationId, 'title' => $title, 'message' => $message, 'loanId' => $loanId]);
                }
                
                $successMessage = $processType === 'partial'
                    ? 'Additional partial amount saved. New Amount Can Pay: ₱' . number_format((float) $newAmountCanPay, 2) . '. Sent to Cashier.'
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
                error_log('Branch Admin loan workflow: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['success' => false, 'message' => 'Unable to process this loan right now.']);
            }
            exit;
        }

        if (false && $action === 'legacy_process') {
            $loanId = intval($input['loanId'] ?? 0);
            $processType = $input['processType'] ?? '';
            $amountApproved = floatval($input['amountApproved'] ?? 0);
            $remarks = trim($input['remarks'] ?? '');
            // Auto-set communication metadata after processing
            $contactChannel = 'Email';
            $dateContacted = date('Y-m-d H:i:s');
            $approvedEmailFlag = 1;
            
            if ($loanId <= 0 || !$processType || !$remarks) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Missing required fields'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            if ($processType === 'decline' || $processType === 'return') {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Decline and return are handled by the Assessment office only.'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            
            $pdo->beginTransaction();
            
            // Get loan details with student info for notifications
            $loanStmt = $pdo->prepare("SELECT l.*, s.student_campus_id,
                                              CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                                              s.student_email,
                                              s.student_personal_email,
                                              s.student_contact_number
                                       FROM tbl_csdl_loans l
                                       JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
                                       WHERE l.loan_id = ?");
            $loanStmt->execute([$loanId]);
            $loan = $loanStmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$loan || $loan['student_campus_id'] != $campusId) {
                $pdo->rollBack();
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Loan not found or access denied'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            
            $newStatusId = 1;
            $newStepId = $loan['loan_current_step_id'];
            $actionText = '';
            
            if ($processType === 'approve') {
                $newStatusId = 2; // Approved
                $newStepId = 5; // Completed
                $actionText = 'Approved';

                $amountApproved = resolveLoanApprovedAmount(
                    $pdo,
                    $loanId,
                    $amountApproved,
                    (float) ($loan['loan_amount_can_pay'] ?? 0)
                );
                if ($amountApproved <= 0) {
                    $pdo->rollBack();
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Unable to determine the approved amount for this loan'], JSON_UNESCAPED_UNICODE);
                    exit;
                }
            } elseif ($processType === 'decline') {
                $newStatusId = 3; // Declined
                $actionText = 'Declined';
            } elseif ($processType === 'return') {
                $newStatusId = 5; // Returned
                $actionText = 'Returned';
            } else {
                $pdo->rollBack();
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid process type'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            $userId = (int) ($_SESSION['user_id'] ?? 0);
            
            // Update loan (match finance/assessment: who updated + milestone dates)
            $updateSql = "UPDATE tbl_csdl_loans 
                         SET loan_status_id = ?, 
                             loan_current_step_id = ?,
                             loan_updated_by = ?,
                             loan_updated_at = NOW()";
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
            
            // Add tracking
            $trackingSql = "INSERT INTO tbl_csdl_loan_tracking 
                           (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by)
                           VALUES (?, ?, ?, ?, ?)";
            $trackingStmt = $pdo->prepare($trackingSql);
            // This tracking column accepts student IDs only; this action was performed
            // by a Branch Admin employee, so the employee ID must not be stored here.
            $trackingStmt->execute([$loanId, 3, $actionText, $remarks, null]);
            
            // Check if approval record exists
            $checkApprovalStmt = $pdo->prepare("SELECT approval_id FROM tbl_csdl_loan_approvals 
                                                WHERE approval_loan_id = ? AND approval_step_id = ? AND approval_role_id = ?");
            $checkApprovalStmt->execute([$loanId, 3, 98]);
            $existingApproval = $checkApprovalStmt->fetch(PDO::FETCH_ASSOC);
            
            $approvalStatusId = ($processType === 'approve') ? 2 : (($processType === 'decline') ? 3 : 4);
            
            if ($existingApproval) {
                // Update existing approval record
                $approvalSql = "UPDATE tbl_csdl_loan_approvals 
                               SET approval_status_id = ?,
                                   approval_amount_approved = ?,
                                   approval_remarks = ?,
                                   approval_processed_by = ?,
                                   approval_date_processed = NOW(),
                                   approval_channel_used = ?,
                                   approval_date_contacted = ?,
                                   approval_approved_email = ?,
                                   approval_updated_at = NOW()
                               WHERE approval_id = ?";
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([$approvalStatusId, $amountApproved, $remarks, $_SESSION['user_id'], $contactChannel, $dateContacted, $approvedEmailFlag, $existingApproval['approval_id']]);
            } else {
                // Insert new approval record
                $approvalSql = "INSERT INTO tbl_csdl_loan_approvals 
                               (approval_loan_id, approval_step_id, approval_role_id, approval_status_id, 
                                approval_amount_approved, approval_remarks, approval_processed_by, approval_date_processed,
                                approval_channel_used, approval_date_contacted, approval_approved_email)
                               VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)";
                $approvalStmt = $pdo->prepare($approvalSql);
                $approvalStmt->execute([$loanId, 3, 98, $approvalStatusId, $amountApproved, $remarks, $_SESSION['user_id'], $contactChannel, $dateContacted, $approvedEmailFlag]);
            }
            
            $pdo->commit();
            
            // Send notifications after successful commit
            $applicationNo = $loan['loan_application_no'] ?? '';
            $studentId = $loan['loan_student_id'];
            $studentName = trim($loan['student_name'] ?? '');
            
            // Prepare notification data
            $amountApprovedDisplay = null;
            if ($processType === 'approve' && $amountApproved > 0) {
                $amountApprovedDisplay = '₱' . number_format($amountApproved, 2);
            }
            
            // Build notification title and message
            $studentNotifTitle = '';
            $studentNotifMessage = '';
            
            if ($processType === 'approve') {
                $studentNotifTitle = 'Loan Approved by Branch Admin';
                $studentNotifMessage = "Loan {$applicationNo} approved"
                    . ($amountApprovedDisplay ? " for {$amountApprovedDisplay}" : '')
                    . ".";
            } elseif ($processType === 'decline') {
                $studentNotifTitle = 'Loan Declined by Branch Admin';
                $studentNotifMessage = "Loan {$applicationNo} declined.";
            } elseif ($processType === 'return') {
                $studentNotifTitle = 'Loan Application Returned';
                $studentNotifMessage = "Loan {$applicationNo} returned for revision.";
            }
            
            if ($studentNotifTitle !== '' && $studentNotifMessage !== '') {
                // Insert notification for student
                $notifStmt = $pdo->prepare("INSERT INTO tbl_csdl_notifications 
                                           (notification_student_id, notification_loan_id, notification_workflow_step_id,
                                            notification_title, notification_message, notification_sent_at) 
                                           VALUES (?, ?, ?, ?, ?, NOW())");
                $notifStmt->execute([$studentId, $loanId, $newStepId, $studentNotifTitle, $studentNotifMessage]);
                
                // Get notification ID for push notification
                $notificationId = (int)$pdo->lastInsertId();
                
                // Send push notification to student
                require_once __DIR__ . '/../includes/includes-send-push-notification.php';
                sendPushNotification($pdo, $studentId, 'student', [
                    'id' => $notificationId,
                    'title' => $studentNotifTitle,
                    'message' => $studentNotifMessage,
                    'loanId' => $loanId
                ]);
                
                // Send email and push notifications
                require_once __DIR__ . '/../includes/includes-send-loan-notifications.php';
                queueLoanNotifications($pdo, $loan, $processType, $applicationNo, $amountApprovedDisplay, senderRole: 'branch_admin');
            }
            
            echo json_encode(['success' => true, 'message' => 'Loan processed successfully'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        
        // Partial-payment requirements are now created through action=process.
        if ($action === 'recordPartialPayment') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Use the Partial Payment action from Active Loans.'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid action'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        RBAC::requirePermission($employeeId, 'branch_admin.loans.view', 'You do not have permission to view loans');
        $action = $_GET['action'] ?? '';

        if ($action === 'filters') {
            $statusStmt = $pdo->query('SELECT loan_status_id, loan_status_name FROM tbl_csdl_loan_statuses ORDER BY loan_status_id');
            $statuses = $statusStmt ? $statusStmt->fetchAll(PDO::FETCH_ASSOC) : [];

            $periodStmt = $pdo->query("SELECT app_period_id, app_period_name
                                       FROM tbl_csdl_application_periods
                                       WHERE app_period_status = 1
                                       ORDER BY app_period_id");
            $periods = $periodStmt ? $periodStmt->fetchAll(PDO::FETCH_ASSOC) : [];

            // Reference lists for loan filters (branch admins may lack masterfile RBAC)
            $semestersStmt = $pdo->query('SELECT semester_id, semester_name FROM tbl_csdl_semesters ORDER BY semester_id');
            $semesters = $semestersStmt ? $semestersStmt->fetchAll(PDO::FETCH_ASSOC) : [];

            $schoolYearsStmt = $pdo->query(
                "SELECT sy.sy_id AS id,
                        sy.sy_code AS code,
                        sy.sy_semester_id AS semester_id,
                        sem.semester_name AS semester_name,
                        sy.sy_start_date AS start_date,
                        sy.sy_end_date AS end_date,
                        sy.sy_status AS status
                 FROM tbl_csdl_school_years sy
                 LEFT JOIN tbl_csdl_semesters sem ON sem.semester_id = sy.sy_semester_id
                 ORDER BY sy.sy_code ASC"
            );
            $schoolYears = $schoolYearsStmt ? $schoolYearsStmt->fetchAll(PDO::FETCH_ASSOC) : [];

            echo json_encode([
                'success' => true,
                'statuses' => $statuses,
                'periods' => $periods,
                'semesters' => $semesters,
                'schoolYears' => $schoolYears,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;
        }

        if ($action === 'details') {
            $loanId = (int) ($_GET['loanId'] ?? 0);
            if ($loanId <= 0) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Invalid loan ID']);
                exit;
            }

            $sql = "SELECT
                        l.loan_id,
                        l.loan_application_no,
                        l.loan_application_date,
                        l.loan_promised_payment_date,
                        l.loan_amount_can_pay,
                        l.loan_due_date,
                        l.loan_expiry_timestamp,
                        l.loan_reason,
                        l.loan_status_id,
                        ls.loan_status_name,
                        l.loan_current_step_id,
                        ws.step_name AS current_step_name,
                        l.loan_app_period_id,
                        ap.app_period_name,
                        s.student_school_id,
                        CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                        CONCAT(s.student_last_name, ', ', s.student_first_name) AS name,
                        s.student_email,
                        s.student_personal_email,
                        s.student_contact_number,
                        p.program_name,
                        yl.year_level_name,
                        g.guardian_name,
                        rel.relationship_name AS guardian_relationship,
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
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
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
                    WHERE l.loan_id = ?
                    LIMIT 1";

            $stmt = $pdo->prepare($sql);
            $stmt->execute([$campusId, $loanId]);
            $loan = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$loan) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Loan not found'], JSON_UNESCAPED_UNICODE);
                exit;
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
            exit;
        }

        if ($action === 'list') {
            $page = max(1, (int) ($_GET['page'] ?? 1));
            $perPage = max(10, min(100, (int) ($_GET['perPage'] ?? 25)));
            $offset = ($page - 1) * $perPage;

            $statusFilter = trim((string) ($_GET['status'] ?? ''));
            $periodFilter = trim((string) ($_GET['period'] ?? ''));
            $semesterFilter = trim((string) ($_GET['semester'] ?? ''));
            $schoolYearFilter = trim((string) ($_GET['schoolYear'] ?? ''));
            $search = trim((string) ($_GET['search'] ?? ''));

            $allowedStatusIds = ['1', '12'];

            $where = ['l.loan_current_step_id = ' . BRANCH_STEP];
            $params = [];

            if ($statusFilter !== '') {
                if (!in_array($statusFilter, $allowedStatusIds, true)) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'message' => 'Invalid status filter'], JSON_UNESCAPED_UNICODE);
                    exit;
                }
                if ($statusFilter === '1') {
                    $where[] = 'l.loan_status_id IN (1, 12)';
                } else {
                    $where[] = 'l.loan_status_id = ?';
                    $params[] = $statusFilter;
                }
            } else {
                $where[] = 'l.loan_status_id IN (1, 12)';
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
                $searchParam = '%' . $search . '%';
                $params[] = $searchParam;
                $params[] = $searchParam;
                $params[] = $searchParam;
            }

            $whereClause = implode(' AND ', $where);

            // Total count
            $countSql = "SELECT COUNT(*) as total
                         FROM tbl_csdl_loans l
                         JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
                         WHERE {$whereClause}";

            $countStmt = $pdo->prepare($countSql);
            $countStmt->execute(array_merge([$campusId], $params));
            $total = (int) ($countStmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);

            // List
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
                        l.loan_expiry_timestamp AS expiryTimestamp,
                        (SELECT approval_pn_tagging FROM tbl_csdl_loan_approvals WHERE approval_loan_id = l.loan_id AND approval_pn_tagging IS NOT NULL ORDER BY approval_pn_date_processed DESC LIMIT 1) as pnStatus
                    FROM tbl_csdl_loans l
                    JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
                    LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
                    LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                    LEFT JOIN tbl_csdl_workflow_steps ws ON ws.step_id = l.loan_current_step_id
                    WHERE {$whereClause}
                    ORDER BY l.loan_application_date DESC, l.loan_id DESC
                    LIMIT ? OFFSET ?";

            $stmt = $pdo->prepare($sql);
            $listParams = array_merge([$campusId], $params, [$perPage, $offset]);
            $stmt->execute($listParams);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate statistics for cards (independent of filters)
            $statsSql = "SELECT
                            COUNT(*) as total_pending,
                            SUM(CASE WHEN l.loan_expiry_timestamp IS NOT NULL AND l.loan_expiry_timestamp < NOW() THEN 1 ELSE 0 END) as total_overdue
                         FROM tbl_csdl_loans l
                         JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id AND s.student_campus_id = ?
                         WHERE l.loan_current_step_id = " . BRANCH_STEP . "
                         AND l.loan_status_id IN (1, 12)";
            
            $statsStmt = $pdo->prepare($statsSql);
            $statsStmt->execute([$campusId]);
            $statsRow = $statsStmt->fetch(PDO::FETCH_ASSOC);
            
            $stats = [
                'pending' => (int) ($statsRow['total_pending'] ?? 0),
                'overdue' => (int) ($statsRow['total_overdue'] ?? 0)
            ];

            echo json_encode([
                'success' => true,
                'data' => $rows,
                'total' => $total,
                'page' => $page,
                'perPage' => $perPage,
                'totalPages' => $perPage > 0 ? (int) ceil($total / $perPage) : 0,
                'stats' => $stats,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;
        }

        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid action'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Error: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
