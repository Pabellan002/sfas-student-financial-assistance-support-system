<?php

require_once __DIR__ . '/includes-email-templates.php';
require_once __DIR__ . '/includes-student-notification-emails.php';
require_once __DIR__ . '/includes-email-mailer.php';
require_once __DIR__ . '/includes-email-queue.php';

function queueLoanApplicationReceiptEmail(
    PDO $pdo,
    array $studentInfo,
    array $details,
    ?string $guardianIdRelativePath = null,
    ?string $guardianIdOriginalName = null
): bool {
    if (!studentHasNotificationEmail($studentInfo)) {
        return false;
    }

    $guardianAbsolutePath = null;
    if ($guardianIdRelativePath) {
        $candidate = realpath(__DIR__ . '/../../' . ltrim(str_replace('\\', '/', $guardianIdRelativePath), '/'));
        if ($candidate && is_file($candidate)) {
            $guardianAbsolutePath = $candidate;
        }
    }

    $recipients = getStudentNotificationEmails($studentInfo);
    $queued = 0;
    foreach ($recipients as $recipient) {
        $queueId = emailQueueEnqueue($pdo, 'loan_application_receipt', [
            'student' => [
                'student_name' => $studentInfo['student_name'] ?? '',
                'student_email' => $studentInfo['student_email'] ?? '',
                'student_personal_email' => $studentInfo['student_personal_email'] ?? '',
            ],
            'recipient' => $recipient,
            'details' => $details,
            'guardian_id_path' => $guardianAbsolutePath,
            'guardian_id_name' => $guardianIdOriginalName,
        ]);
        if ($queueId !== null) {
            $queued++;
        }
    }

    return $queued === count($recipients);
}

function sendLoanApplicationReceiptEmailNow(
    array $studentInfo,
    array $details,
    ?string $guardianIdAbsolutePath = null,
    ?string $guardianIdOriginalName = null,
    ?string $requestedRecipient = null,
    string $senderRole = 'csdl',
    ?PDO $pdo = null
): bool {
    try {
        if (!studentHasNotificationEmail($studentInfo)) {
            return true;
        }

        $recipients = getStudentNotificationEmails($studentInfo);
        if ($requestedRecipient !== null && trim($requestedRecipient) !== '') {
            $requestedRecipient = trim($requestedRecipient);
            $matchedRecipient = null;
            foreach ($recipients as $recipient) {
                if (strcasecmp($recipient, $requestedRecipient) === 0) {
                    $matchedRecipient = $recipient;
                    break;
                }
            }
            if ($matchedRecipient === null) {
                throw new RuntimeException('Loan application receipt recipient is no longer valid for this student.');
            }
            $recipients = [$matchedRecipient];
        }

        $mailerConfig = emailMailerCreate($senderRole);
        if ($mailerConfig === null) {
            return false;
        }

        $studentName = trim($studentInfo['student_name'] ?? 'Student');
        $applicationNo = $details['applicationNo'] ?? 'N/A';
        $editableValues = ['student_name' => $studentName, 'application_no' => (string) $applicationNo];
        $override = $pdo ? EmailTemplates::editableOverride($pdo, $senderRole, 'loan_application_receipt') : null;

        $imagePath = realpath(__DIR__ . '/../../assets/images/template.jpg');
        $imageCid = $imagePath && file_exists($imagePath) ? 'loan_process_image' : null;

        $idSamplePath = realpath(__DIR__ . '/../../assets/images/id-temp.png');
        $idSampleCid = $idSamplePath && file_exists($idSamplePath) ? 'guardian_id_sample' : null;

        $htmlBody = EmailTemplates::loanApplicationSubmittedEmail(
            array_merge($details, ['studentName' => $studentName]),
            $imageCid,
            $idSampleCid,
            $mailerConfig['app_name'],
            $mailerConfig['support_email'],
            EmailTemplates::editableMessage($override, $editableValues)
        );

        $emailMsg = (new \Symfony\Component\Mime\Email())
            ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
            ->to(...$recipients)
            ->subject($override ? EmailTemplates::editableText($override['subject'], $editableValues)
                : 'PHINMA COC Student Financial Assistance Application Form - Application #' . $applicationNo)
            ->html($htmlBody);
        EmailTemplates::embedSchoolLogo($emailMsg);

        if ($imageCid && $imagePath) {
            $emailMsg->embedFromPath($imagePath, $imageCid);
            $emailMsg->attachFromPath($imagePath, 'Student-Loan-Application-Process.jpg');
        }

        if ($idSampleCid && $idSamplePath) {
            $emailMsg->embedFromPath($idSamplePath, $idSampleCid);
        }

        if ($guardianIdAbsolutePath && is_file($guardianIdAbsolutePath)) {
            $attachName = $guardianIdOriginalName ?: basename($guardianIdAbsolutePath);
            $emailMsg->attachFromPath($guardianIdAbsolutePath, $attachName);
        }

        $mailerConfig['mailer']->send($emailMsg);
        return true;
    } catch (Throwable $e) {
        error_log('Loan application receipt email error: ' . $e->getMessage());
        throw $e;
    }
}
