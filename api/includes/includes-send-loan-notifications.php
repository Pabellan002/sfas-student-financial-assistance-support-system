<?php
require_once __DIR__ . '/includes-email-templates.php';
require_once __DIR__ . '/includes-student-notification-emails.php';
require_once __DIR__ . '/includes-email-queue.php';
require_once __DIR__ . '/includes-email-mailer.php';
require_once __DIR__ . '/includes-send-push-notification.php';

/**
 * Send immediate push notification after notification is inserted
 * @param PDO $pdo Database connection
 * @param int|null $studentId Student ID (if notification is for student)
 * @param int|null $employeeId Employee ID (if notification is for employee)
 * @param string $title Notification title
 * @param string $message Notification message
 * @param int|null $loanId Associated loan ID
 */
function sendImmediatePushNotification(PDO $pdo, ?int $studentId, ?int $employeeId, string $title, string $message, ?int $loanId = null): void
{
    try {
        if ($studentId) {
            sendPushNotification($pdo, $studentId, 'student', [
                'title' => $title,
                'message' => $message,
                'loanId' => $loanId,
            ]);
        } elseif ($employeeId) {
            sendPushNotification($pdo, $employeeId, 'employee', [
                'title' => $title,
                'message' => $message,
                'loanId' => $loanId,
            ]);
        }
    } catch (Throwable $e) {
        // Push notifications are optional, don't block the main flow
        error_log('[WebPush] Error in sendImmediatePushNotification: ' . $e->getMessage());
    }
}

/**
 * Queue email + push notifications for loan status changes (non-blocking).
 */
function queueLoanNotifications(PDO $pdo, array $loan, string $processType, string $applicationNo, ?string $amountApproved = null, ?string $paymentDueDate = null, ?string $destinationOffice = null, ?string $updatedAmountCanPay = null, string $senderRole = 'system'): bool
{
    if ($senderRole === 'branch_admin') {
        $senderRole = emailMailerBranchRoleForCampusId((int) ($loan['student_campus_id'] ?? 0));
    }
    $recipients = getStudentNotificationEmails($loan);
    if ($recipients === []) {
        error_log("queueLoanNotifications skipped without a valid recipient - Type: {$processType}, AppNo: {$applicationNo}");
        return false;
    }

    $queued = 0;
    foreach ($recipients as $recipient) {
        $queueId = emailQueueEnqueue($pdo, 'loan_notification', [
            'sender_role' => $senderRole,
            'loan' => [
                'student_name' => $loan['student_name'] ?? '',
                'student_email' => $loan['student_email'] ?? '',
                'student_personal_email' => $loan['student_personal_email'] ?? '',
                'student_contact_number' => $loan['student_contact_number'] ?? '',
            ],
            'recipient' => $recipient,
            'process_type' => $processType,
            'application_no' => $applicationNo,
            'amount_approved' => $amountApproved,
            'payment_due_date' => $paymentDueDate,
            'destination_office' => $destinationOffice,
            'updated_amount_can_pay' => $updatedAmountCanPay,
        ]);

        if ($queueId !== null) {
            $queued++;
            error_log("queueLoanNotifications queued #{$queueId} - Type: {$processType}, AppNo: {$applicationNo}");
        }
    }

    return $queued === count($recipients);
}

/**
 * Create one overdue notice per active loan. The loan remains in its current
 * workflow queue; the elapsed timestamp is an alert, never an auto-expiry.
 */
function queueOverdueLoanNotifications(PDO $pdo): int
{
    $created = 0;

    try {
        $loansStmt = $pdo->query("SELECT
                l.loan_id,
                l.loan_student_id,
                l.loan_current_step_id,
                l.loan_application_no,
                l.loan_expiry_timestamp,
                s.student_email,
                s.student_personal_email,
                s.student_contact_number,
                CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name
            FROM tbl_csdl_loans l
            INNER JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            WHERE l.loan_status_id = 1
              AND l.loan_expiry_timestamp IS NOT NULL
              AND l.loan_expiry_timestamp <= NOW()
              AND NOT EXISTS (
                  SELECT 1
                  FROM tbl_csdl_notifications n
                  WHERE n.notification_loan_id = l.loan_id
                    AND n.notification_student_id = l.loan_student_id
                    AND n.notification_title = 'Loan Application Overdue'
              )");

        $insertNotice = $pdo->prepare("INSERT INTO tbl_csdl_notifications
                (notification_student_id, notification_workflow_step_id, notification_loan_id,
                 notification_title, notification_message, notification_sent_at)
            SELECT ?, ?, ?, 'Loan Application Overdue', ?, NOW()
            WHERE NOT EXISTS (
                SELECT 1
                FROM tbl_csdl_notifications n
                WHERE n.notification_loan_id = ?
                  AND n.notification_student_id = ?
                  AND n.notification_title = 'Loan Application Overdue'
            )");

        foreach ($loansStmt->fetchAll(PDO::FETCH_ASSOC) as $loan) {
            $applicationNo = (string) ($loan['loan_application_no'] ?? '');
            $deadline = !empty($loan['loan_expiry_timestamp'])
                ? date('F j, Y g:i A', strtotime((string) $loan['loan_expiry_timestamp']))
                : 'the stated deadline';
            $message = "Loan {$applicationNo} is overdue as of {$deadline}. It remains active and may still be processed by the assigned office.";

            $insertNotice->execute([
                (int) $loan['loan_student_id'],
                (int) $loan['loan_current_step_id'],
                (int) $loan['loan_id'],
                $message,
                (int) $loan['loan_id'],
                (int) $loan['loan_student_id'],
            ]);

            if ($insertNotice->rowCount() === 1) {
                $created++;
                queueLoanNotifications($pdo, $loan, 'overdue', $applicationNo);
            }
        }
    } catch (Throwable $e) {
        // Alert delivery must never block a loan page or a workflow action.
        error_log('queueOverdueLoanNotifications error: ' . $e->getMessage());
    }

    return $created;
}

/** @deprecated Use queueLoanNotifications() */
function sendLoanNotifications(PDO $pdo, array $loan, string $processType, string $applicationNo, ?string $amountApproved = null, ?string $paymentDueDate = null, ?string $destinationOffice = null, ?string $updatedAmountCanPay = null, string $senderRole = 'system'): void
{
    queueLoanNotifications($pdo, $loan, $processType, $applicationNo, $amountApproved, $paymentDueDate, $destinationOffice, $updatedAmountCanPay, $senderRole);
}

/**
 * Process a queued loan notification (email + push). Used by the email queue worker.
 */
function sendLoanNotificationsNow(PDO $pdo, array $loan, string $processType, string $applicationNo, ?string $amountApproved = null, ?string $paymentDueDate = null, ?string $destinationOffice = null, ?string $requestedRecipient = null, ?string $updatedAmountCanPay = null, string $senderRole = 'system'): bool
{
    $emailSent = false;
    $emailAttempted = false;
    $pushSent = false;

    try {
        // Active workflow endpoints use "endorse", while older queued jobs use
        // "endorsed". Normalize both so they receive the same subject/template.
        if ($processType === 'endorse') {
            $processType = 'endorsed';
        }

        $studentName = trim($loan['student_name'] ?? '');
        $notificationEmails = getStudentNotificationEmails($loan);
        $studentContact = $loan['student_contact_number'] ?? '';

        if ($requestedRecipient !== null && trim($requestedRecipient) !== '') {
            $requestedRecipient = trim($requestedRecipient);
            $matchedRecipient = null;
            foreach ($notificationEmails as $recipient) {
                if (strcasecmp($recipient, $requestedRecipient) === 0) {
                    $matchedRecipient = $recipient;
                    break;
                }
            }
            if ($matchedRecipient === null) {
                throw new RuntimeException('Loan notification recipient is no longer valid for this student.');
            }
            $notificationEmails = [$matchedRecipient];
        }

        $destinationOffice = trim((string) $destinationOffice);
        $updatedAmountCanPay = trim((string) $updatedAmountCanPay);
        $notificationTitles = [
            'approve' => 'Loan Approved',
            'decline' => 'Loan Declined',
            'return' => 'Loan Application Returned',
            'resubmitted' => 'Loan Application Resubmitted',
            'cancelled' => 'Loan Application Cancelled',
            'endorsed' => $destinationOffice !== '' ? "Loan Endorsed to {$destinationOffice}" : 'Loan Endorsed for Further Review',
            'endorsed_to_bukas' => 'Loan Endorsed to Bukas',
            'partial_payment' => $updatedAmountCanPay !== '' ? 'Amount Can Pay Updated' : 'Partial Payment',
            'paid_partial' => 'Partial Payment Recorded',
            'paid_pending' => 'Advance Payment Recorded',
            'payment_confirmed' => 'Payment Confirmed',
            'pn_paid' => 'Loan Application Marked as Paid',
            'pn_tagged_completed' => 'Loan Application Completed',
            'overdue' => 'Loan Application Overdue',
        ];
        $emailSubject = ($notificationTitles[$processType] ?? 'Loan Status Update') . ' - Application #' . $applicationNo;
        $editableValues = [
            'student_name' => $studentName,
            'application_no' => $applicationNo,
            'amount' => (string) $amountApproved,
            'due_date' => (string) $paymentDueDate,
            'destination_office' => $destinationOffice,
        ];
        $override = isset(EmailTemplates::editableTypes($senderRole)['loan_' . $processType])
            ? EmailTemplates::editableOverride($pdo, $senderRole, 'loan_' . $processType) : null;
        if ($override !== null) {
            $emailSubject = EmailTemplates::editableText($override['subject'], $editableValues);
        }

        // Send email notification
        $mailerConfig = emailMailerCreate($senderRole);
        if ($notificationEmails !== [] && $mailerConfig === null) {
            throw new RuntimeException('SMTP sender is not configured for role ' . $senderRole);
        }
        if ($notificationEmails !== [] && $mailerConfig !== null) {
            $emailAttempted = true;
            $htmlBody = EmailTemplates::loanNotificationEmail(
                $studentName,
                $processType,
                $applicationNo,
                $amountApproved,
                $paymentDueDate,
                $mailerConfig['app_name'],
                $mailerConfig['support_email'],
                $destinationOffice !== '' ? $destinationOffice : null,
                $updatedAmountCanPay !== '' ? $updatedAmountCanPay : null,
                EmailTemplates::editableMessage($override, $editableValues)
            );

            $emailMsg = (new \Symfony\Component\Mime\Email())
                ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
                ->to(...$notificationEmails)
                ->subject($emailSubject)
                ->html($htmlBody);
            EmailTemplates::embedSchoolLogo($emailMsg);

            $mailerConfig['mailer']->send($emailMsg);
            $emailSent = true;
            error_log('Loan notification email sent to: ' . implode(', ', $notificationEmails));
        }

        // Send push notification (get student_id if available)
        if (isset($loan['student_id'])) {
            $notificationMessage = '';
            switch ($processType) {
                case 'approve':
                    $notificationMessage = "Your loan application #{$applicationNo} has been approved" . ($amountApproved ? " for ₱" . number_format((float)$amountApproved, 2) : "") . ".";
                    break;
                case 'decline':
                    $notificationMessage = "Your loan application #{$applicationNo} has been declined.";
                    break;
                case 'return':
                    $notificationMessage = "Your loan application #{$applicationNo} has been returned for corrections.";
                    break;
                case 'resubmitted':
                    $notificationMessage = "Your loan application #{$applicationNo} has been resubmitted for review.";
                    break;
                case 'cancelled':
                    $notificationMessage = "Your loan application #{$applicationNo} has been cancelled.";
                    break;
                case 'endorsed':
                    $notificationMessage = $destinationOffice !== ''
                        ? "Your loan application #{$applicationNo} has been endorsed to {$destinationOffice} for review."
                        : "Your loan application #{$applicationNo} has been endorsed for further review.";
                    break;
                case 'endorsed_to_bukas':
                    $notificationMessage = "Your loan application #{$applicationNo} has been endorsed to Bukas.";
                    break;
                case 'partial_payment':
                    $notificationMessage = $updatedAmountCanPay !== ''
                        ? "An additional partial amount was added to loan application #{$applicationNo}. Your new Amount Can Pay is {$updatedAmountCanPay}."
                        : "A partial payment has been submitted for your loan application #{$applicationNo}.";
                    break;
                case 'paid_partial':
                    $notificationMessage = "A partial payment has been recorded for your loan application #{$applicationNo}.";
                    break;
                case 'paid_pending':
                    $notificationMessage = "An advance payment has been recorded for your loan application #{$applicationNo}.";
                    break;
                case 'payment_confirmed':
                    $notificationMessage = "Your payment for loan application #{$applicationNo} has been confirmed and sent for PN tagging.";
                    break;
                case 'pn_paid':
                    $notificationMessage = "Your loan application #{$applicationNo} has been marked as paid.";
                    break;
                case 'pn_tagged_completed':
                    $notificationMessage = "Your loan application #{$applicationNo} has been completed.";
                    break;
                case 'overdue':
                    $notificationMessage = "Your loan application #{$applicationNo} is overdue.";
                    break;
                default:
                    $notificationMessage = "Update on your loan application #{$applicationNo}.";
            }

            $pushSent = sendPushNotification($pdo, (int)$loan['student_id'], 'student', [
                'title' => $emailSubject,
                'message' => $notificationMessage,
                'loanId' => $loan['loan_id'] ?? null,
            ]);
        }

        if ($emailAttempted && !$emailSent) {
            return false;
        }

        return $emailSent || $pushSent;
    } catch (Throwable $e) {
        error_log('sendLoanNotificationsNow error: ' . $e->getMessage());
        throw $e;
    }
}
