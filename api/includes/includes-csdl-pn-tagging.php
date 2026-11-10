<?php
require_once __DIR__ . '/includes-loan-pn-routing.php';

/** Paid loans assigned to CSDL's PN queue. */
function csdlPnTaggingScopeSql(): string
{
    return "l.loan_payment_status_id = 3 AND (" . loanPnTaggingOfficeSql() . ") = 'csdl'";
}

function canReadCsdlPnTagging(PDO $pdo, int $loanId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM tbl_csdl_loans l WHERE l.loan_id = ? AND ' . csdlPnTaggingScopeSql());
    $stmt->execute([$loanId]);
    return (bool) $stmt->fetchColumn();
}

/** Complete a paid application with an ownership check under the loan lock. */
function completeCsdlPnTagging(PDO $pdo, int $employeeId, int $loanId, string $remarks): void
{
    try {
        $pdo->beginTransaction();
        $stmt = $pdo->prepare("SELECT l.*, s.student_campus_id, s.student_email, s.student_personal_email,
                s.student_contact_number, CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
            FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            WHERE l.loan_id = ? FOR UPDATE");
        $stmt->execute([$loanId]);
        $loan = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$loan) throw new RuntimeException('Loan not found.');
        $owner = resolveLoanPnTaggingOffice($pdo, $loanId);
        if ($owner['office'] !== 'csdl'
            || (int) $loan['loan_current_step_id'] !== 1
            || (int) $loan['loan_status_id'] !== 2
            || !empty($loan['loan_pn_tagged_date'])
            || (int) ($loan['loan_pn_status_id'] ?? 1) === 2) {
            throw new RuntimeException("This loan is not waiting for PN tagging at CSDL.");
        }
        if ((int) $loan['loan_payment_status_id'] !== 3) {
            throw new RuntimeException('Cashier must confirm payment before this loan can be tagged.');
        }
        $pdo->prepare('UPDATE tbl_csdl_loans SET loan_status_id = 5, loan_pn_status_id = 2,
            loan_pn_tagged_date = NOW(), loan_current_step_id = 5, loan_approval_date = COALESCE(loan_approval_date, CURDATE()),
            loan_updated_by = ?, loan_updated_at = NOW() WHERE loan_id = ?')->execute([$employeeId, $loanId]);
        $trackingRemarks = ($remarks !== '' ? $remarks : 'PN tagged after payment confirmation. Loan completed.')
            . " Processed by CSDL employee #{$employeeId}.";
        // This legacy FK references students; retain the staff identity in the remark.
        $pdo->prepare("INSERT INTO tbl_csdl_loan_tracking
            (loan_tracking_loan_id, loan_tracking_step_id, loan_tracking_action, loan_tracking_remarks, loan_tracking_updated_by)
            VALUES (?, 5, 'PN Tagged - Loan Completed', ?, ?)")
            ->execute([$loanId, $trackingRemarks, (int) $loan['loan_student_id']]);
        $title = 'Loan Application Completed';
        $message = "Congratulations! Your loan application {$loan['loan_application_no']} has been completed. Your promissory note has been tagged successfully.";
        $pdo->prepare('INSERT INTO tbl_csdl_notifications
            (notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at)
            VALUES (?, 5, ?, ?, ?, NOW())')->execute([(int) $loan['loan_student_id'], $loanId, $title, $message]);
        $notificationId = (int) $pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }

    // Delivery must not turn a committed tag into a reported failure/retry.
    try {
        queueLoanNotifications($pdo, $loan, 'pn_tagged_completed', (string) $loan['loan_application_no'], null, null, senderRole: 'csdl');
        sendPushNotification($pdo, (int) $loan['loan_student_id'], 'student', [
            'id' => $notificationId, 'title' => $title, 'message' => $message, 'loanId' => $loanId,
        ]);
    } catch (Throwable $e) {
        error_log('PN tagging notification delivery: ' . $e->getMessage());
    }
}
