<?php

require_once __DIR__ . '/includes-email-templates.php';
require_once __DIR__ . '/includes-email-mailer.php';
require_once __DIR__ . '/includes-email-queue.php';
require_once __DIR__ . '/includes-student-notification-emails.php';

/**
 * @return bool
 */
function studentRegistrationColumnAvailable(PDO $pdo): bool
{
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_registration_status'");
        $cached = (bool) $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $cached = false;
    }
    return $cached;
}

function studentRegistrationSelfSourceColumnAvailable(PDO $pdo): bool
{
    static $cached = null;
    if ($cached === null) {
        $stmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_self_registered'");
        $cached = (bool) $stmt->fetch(PDO::FETCH_ASSOC);
    }
    return $cached;
}

function studentRegistrationIsSelfRegistered(PDO $pdo, int $studentId): bool
{
    if ($studentId <= 0) return false;
    if (studentRegistrationSelfSourceColumnAvailable($pdo)) {
        $stmt = $pdo->prepare('SELECT student_self_registered FROM tbl_csdl_students WHERE student_id = ?');
    } else {
        // Older local databases can use the acknowledgement generated only by public registration.
        $stmt = $pdo->prepare("SELECT 1 FROM tbl_csdl_email_queue
            WHERE email_queue_type = 'registration_submitted'
              AND CAST(JSON_UNQUOTE(JSON_EXTRACT(email_queue_payload, '$.student_id')) AS UNSIGNED) = ? LIMIT 1");
    }
    $stmt->execute([$studentId]);
    return (int) $stmt->fetchColumn() === 1;
}

/** @return array{ok:bool,message?:string,email?:?string,personal_email?:?string} */
function studentRegistrationParseEmails(array $post): array
{
    $emailLocal = trim($post['email_local'] ?? '');
    $emailLegacy = trim($post['email'] ?? '');
    $personalEmail = trim($post['personal_email'] ?? '');

    $schoolInput = $emailLocal !== '' ? $emailLocal : $emailLegacy;
    $email = null;
    if ($schoolInput !== '') {
        $normalized = InputValidation::normalizeSchoolEmailInput($schoolInput);
        if ($normalized === false) {
            return [
                'ok' => false,
                'message' => 'School email must end with .coc (e.g. romeo.joi.coc) before @phinmaed.com.',
            ];
        }
        $email = $normalized;
    }

    if ($personalEmail !== '') {
        $validPersonal = InputValidation::validateEmail($personalEmail);
        if (!$validPersonal) {
            return ['ok' => false, 'message' => 'Invalid personal email format.'];
        }
        if (str_ends_with(strtolower($validPersonal), InputValidation::PHINMAED_DOMAIN)) {
            return ['ok' => false, 'message' => 'Personal email cannot be a @phinmaed.com address. Use the School Email field instead.'];
        }
        $personalEmail = $validPersonal;
    } else {
        $personalEmail = null;
    }

    if ($email === null && $personalEmail === null) {
        return ['ok' => false, 'message' => 'Enter a PHINMAEd school email and/or a personal email.'];
    }

    return ['ok' => true, 'email' => $email, 'personal_email' => $personalEmail];
}

/**
 * @return array<string, mixed>|null
 */
function studentRegistrationFetchById(PDO $pdo, int $studentId): ?array
{
    $hasPersonal = false;
    try {
        $colStmt = $pdo->query("SHOW COLUMNS FROM tbl_csdl_students LIKE 'student_personal_email'");
        $hasPersonal = (bool) $colStmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $hasPersonal = false;
    }

    $personalSelect = $hasPersonal ? 's.student_personal_email,' : 'NULL AS student_personal_email,';
    $regSelect = studentRegistrationColumnAvailable($pdo)
        ? 's.student_registration_status,'
        : "'approved' AS student_registration_status,";

    $stmt = $pdo->prepare("
        SELECT s.student_id, s.student_school_id, s.student_first_name, s.student_middle_name, s.student_last_name,
               s.student_email, {$personalSelect} {$regSelect} s.student_is_active
        FROM tbl_csdl_students s
        WHERE s.student_id = ?
        LIMIT 1
    ");
    $stmt->execute([$studentId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function studentRegistrationEnsureMailerLoaded(): bool
{
    if (class_exists(\Symfony\Component\Mailer\Mailer::class)) {
        return true;
    }
    $autoload = __DIR__ . '/../../vendor/autoload.php';
    if (is_file($autoload)) {
        require_once $autoload;
    }
    return class_exists(\Symfony\Component\Mailer\Mailer::class);
}

/**
 * Queue an acknowledgement as soon as a student submits registration.
 * Email delivery remains outside the registration request so SMTP delays do not
 * slow down or invalidate a successfully created student record.
 *
 * @return array{ok:bool,sent_to:list<string>,failed:list<string>,message:string}
 */
function studentRegistrationSendSubmittedEmail(PDO $pdo, array $student): array
{
    $studentId = (int) ($student['student_id'] ?? 0);
    $recipients = getStudentNotificationEmails($student);
    if ($studentId <= 0 || $recipients === []) {
        return emailQueueQueuedFailureMessage('Registration confirmation email');
    }

    $queued = 0;
    foreach ($recipients as $recipient) {
        $queueId = emailQueueEnqueue($pdo, 'registration_submitted', [
            'student_id' => $studentId,
            'recipient' => $recipient,
        ]);
        if ($queueId !== null) {
            $queued++;
        }
    }

    if ($queued !== count($recipients)) {
        return emailQueueQueuedFailureMessage('Registration confirmation email');
    }

    $result = emailQueueQueuedSuccessMessage('Registration confirmation email');
    $result['sent_to'] = $recipients;
    return $result;
}

function studentRegistrationSendSubmittedEmailNow(PDO $pdo, int $studentId, ?string $requestedRecipient = null, string $senderRole = 'csdl'): bool
{
    if ($studentId <= 0) {
        return false;
    }

    $student = studentRegistrationFetchById($pdo, $studentId);
    if (!$student) {
        throw new RuntimeException('Student not found for registration confirmation email.');
    }

    $recipients = getStudentNotificationEmails($student);
    if ($recipients === []) {
        return true;
    }

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
            throw new RuntimeException('Registration confirmation recipient is no longer valid for this student.');
        }
        $recipients = [$matchedRecipient];
    }

    $mailerConfig = emailMailerCreate($senderRole);
    if ($mailerConfig === null) {
        return false;
    }

    $fullName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $logoCid = EmailTemplates::schoolLogoCid();
    $editableValues = ['student_name' => $fullName, 'school_id' => $schoolId];
    $override = EmailTemplates::editableOverride($pdo, $senderRole, 'registration_submitted');
    $htmlBody = EmailTemplates::studentRegistrationSubmittedEmail(
        $fullName,
        $schoolId,
        $mailerConfig['app_name'],
        $mailerConfig['support_email'],
        $logoCid,
        EmailTemplates::editableMessage($override, $editableValues)
    );

    foreach ($recipients as $recipient) {
        $emailMsg = (new \Symfony\Component\Mime\Email())
            ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
            ->to($recipient)
            ->subject($override ? EmailTemplates::editableText($override['subject'], $editableValues) : 'Registration received - awaiting CSDL approval')
            ->html($htmlBody);
        EmailTemplates::embedSchoolLogo($emailMsg);
        $mailerConfig['mailer']->send($emailMsg);
    }

    return true;
}

/**
 * Queue the CSDL decision using a snapshot so a later resubmission cannot change
 * the recipient or message details of this rejection.
 *
 * @return array{ok:bool,sent_to:list<string>,failed:list<string>,message:string}
 */
function studentRegistrationSendRejectedEmail(PDO $pdo, array $student): array
{
    $studentId = (int) ($student['student_id'] ?? 0);
    $recipients = getStudentNotificationEmails($student);
    if ($studentId <= 0 || $recipients === []) {
        return emailQueueQueuedFailureMessage('Registration decision email');
    }

    $fullName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $queued = 0;
    foreach ($recipients as $recipient) {
        if (emailQueueEnqueue($pdo, 'registration_rejected', [
            'student_id' => $studentId,
            'recipient' => $recipient,
            'student_name' => $fullName,
            'school_id' => $schoolId,
        ]) !== null) {
            $queued++;
        }
    }

    if ($queued !== count($recipients)) {
        return emailQueueQueuedFailureMessage('Registration decision email');
    }

    $result = emailQueueQueuedSuccessMessage('Registration decision email');
    $result['sent_to'] = $recipients;
    return $result;
}

function studentRegistrationSendRejectedEmailNow(PDO $pdo, array $payload, string $senderRole = 'csdl'): bool
{
    $recipient = filter_var((string) ($payload['recipient'] ?? ''), FILTER_VALIDATE_EMAIL);
    if ($recipient === false) {
        throw new InvalidArgumentException('Invalid registration decision recipient.');
    }

    $mailerConfig = emailMailerCreate($senderRole);
    if ($mailerConfig === null) {
        return false;
    }

    $fullName = (string) ($payload['student_name'] ?? 'Student');
    $schoolId = (string) ($payload['school_id'] ?? '');
    $editableValues = ['student_name' => $fullName, 'school_id' => $schoolId];
    $override = EmailTemplates::editableOverride($pdo, $senderRole, 'registration_rejected');
    $logoCid = EmailTemplates::schoolLogoCid();
    $htmlBody = EmailTemplates::studentRegistrationRejectedEmail(
        $fullName,
        $schoolId,
        $mailerConfig['app_name'],
        $mailerConfig['support_email'],
        $logoCid,
        EmailTemplates::editableMessage($override, $editableValues)
    );
    $subject = $override
        ? EmailTemplates::editableText($override['subject'], $editableValues)
        : EmailTemplates::editableText(EmailTemplates::editableDefaults('registration_rejected')['subject'], $editableValues);
    $emailMsg = (new \Symfony\Component\Mime\Email())
        ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
        ->to($recipient)
        ->subject($subject)
        ->html($htmlBody);
    EmailTemplates::embedSchoolLogo($emailMsg);
    $mailerConfig['mailer']->send($emailMsg);
    return true;
}

/**
 * Notify all valid student addresses (school + personal) that balance setup is complete.
 *
 * @return array{ok:bool,sent_to:list<string>,failed:list<string>,message:string}
 */
function studentRegistrationSendApprovedEmail(PDO $pdo, array $student): array
{
    $studentId = (int) ($student['student_id'] ?? 0);
    if (!studentRegistrationIsSelfRegistered($pdo, $studentId)) {
        return ['ok' => true, 'queued' => false, 'sent_to' => [], 'failed' => [], 'message' => ''];
    }
    if ($studentId <= 0) {
        return emailQueueQueuedFailureMessage('Approval email');
    }

    $recipients = getStudentNotificationEmails($student);
    if ($recipients === []) {
        return [
            'ok' => false,
            'queued' => false,
            'sent_to' => [],
            'failed' => [],
            'message' => 'No valid email on file for this student.',
        ];
    }

    $queued = 0;
    foreach ($recipients as $recipient) {
        $queueId = emailQueueEnqueue($pdo, 'registration_approved', [
            'student_id' => $studentId,
            'recipient' => $recipient,
        ]);
        if ($queueId !== null) {
            $queued++;
        }
    }

    if ($queued !== count($recipients)) {
        return emailQueueQueuedFailureMessage('Approval email');
    }

    $result = emailQueueQueuedSuccessMessage('Balance setup email');
    $result['sent_to'] = $recipients;
    $result['message'] = 'Balance setup completed. Email notification has been queued for delivery.';
    return $result;
}

function studentRegistrationSendApprovedEmailNow(PDO $pdo, int $studentId, ?string $requestedRecipient = null, string $senderRole = 'assessment'): bool
{
    if (!studentRegistrationIsSelfRegistered($pdo, $studentId)) {
        return true;
    }
    if ($studentId <= 0) {
        return false;
    }

    $student = studentRegistrationFetchById($pdo, $studentId);
    if (!$student) {
        throw new RuntimeException('Student not found for registration approval email.');
    }

    $recipients = getStudentNotificationEmails($student);
    if ($recipients === []) {
        return true;
    }

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
            throw new RuntimeException('Registration approval recipient is no longer valid for this student.');
        }
        $recipients = [$matchedRecipient];
    }

    $mailerConfig = emailMailerCreate($senderRole);
    if ($mailerConfig === null) {
        return false;
    }

    $fullName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $logoCid = EmailTemplates::schoolLogoCid();
    $editableValues = ['student_name' => $fullName, 'school_id' => $schoolId];
    $override = EmailTemplates::editableOverride($pdo, $senderRole, 'registration_approved');
    $htmlBody = EmailTemplates::studentRegistrationApprovedEmail(
        $fullName,
        $schoolId,
        $mailerConfig['app_name'],
        $mailerConfig['support_email'],
        null,
        $logoCid,
        EmailTemplates::editableMessage($override, $editableValues)
    );
    $subject = $override ? EmailTemplates::editableText($override['subject'], $editableValues) : 'Your student balance is ready';

    foreach ($recipients as $recipient) {
        $emailMsg = (new \Symfony\Component\Mime\Email())
            ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
            ->to($recipient)
            ->subject($subject)
            ->html($htmlBody);
        EmailTemplates::embedSchoolLogo($emailMsg);
        $mailerConfig['mailer']->send($emailMsg);
    }

    return true;
}

/**
 * @return list<int>
 */
function studentRegistrationGetEmployeeIdsByPermission(PDO $pdo, string $permissionKey): array
{
    try {
        $stmt = $pdo->prepare(
            "SELECT DISTINCT e.employee_id
             FROM tbl_csdl_employees e
             JOIN tbl_csdl_permissions p ON p.permission_key = ?
             LEFT JOIN tbl_csdl_role_permissions rp ON rp.role_id = e.employee_role_id AND rp.permission_id = p.permission_id
             LEFT JOIN tbl_csdl_employee_permissions ep ON ep.employee_id = e.employee_id AND ep.permission_id = p.permission_id
             WHERE e.employee_status = 1
               AND (
                 (ep.employee_permission_id IS NOT NULL AND ep.is_granted = 1)
                 OR (ep.employee_permission_id IS NULL AND rp.role_permission_id IS NOT NULL)
               )"
        );
        $stmt->execute([$permissionKey]);
        $ids = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $id = (int) ($row['employee_id'] ?? 0);
            if ($id > 0) {
                $ids[] = $id;
            }
        }
        return $ids;
    } catch (Throwable $e) {
        error_log('Registration employee permission lookup error: ' . $e->getMessage());
        return [];
    }
}

/**
 * @param list<int> $employeeIds
 */
function studentRegistrationSendEmployeeNotifications(PDO $pdo, array $employeeIds, string $title, string $message): void
{
    require_once __DIR__ . '/includes-send-push-notification.php';

    $employeeIds = array_values(array_unique(array_filter(array_map('intval', $employeeIds))));
    if ($employeeIds === []) {
        return;
    }

    try {
        $notifStmt = $pdo->prepare(
            "INSERT INTO tbl_csdl_notifications
             (notification_employee_id, notification_loan_id, notification_workflow_step_id, notification_title, notification_message, notification_sent_at)
             VALUES (?, NULL, NULL, ?, ?, NOW())"
        );

        foreach ($employeeIds as $employeeId) {
            $notifStmt->execute([$employeeId, $title, $message]);
            $notificationId = (int) $pdo->lastInsertId();
            sendPushNotification($pdo, $employeeId, 'employee', [
                'id' => $notificationId,
                'title' => $title,
                'message' => $message,
            ]);
        }
    } catch (Throwable $e) {
        error_log('Registration employee notification error: ' . $e->getMessage());
    }
}

function studentRegistrationSendStudentNotification(PDO $pdo, int $studentId, string $title, string $message): void
{
    require_once __DIR__ . '/includes-send-push-notification.php';

    if ($studentId <= 0) {
        return;
    }

    try {
        $notifStmt = $pdo->prepare(
            "INSERT INTO tbl_csdl_notifications
             (notification_student_id, notification_loan_id, notification_workflow_step_id, notification_title, notification_message, notification_sent_at)
             VALUES (?, NULL, NULL, ?, ?, NOW())"
        );
        $notifStmt->execute([$studentId, $title, $message]);
        $notificationId = (int) $pdo->lastInsertId();
        sendPushNotification($pdo, $studentId, 'student', [
            'id' => $notificationId,
            'title' => $title,
            'message' => $message,
        ]);
    } catch (Throwable $e) {
        error_log('Registration student notification error: ' . $e->getMessage());
    }
}

/**
 * Notify CSDL staff when a student submits online registration.
 */
function studentRegistrationNotifyCsdlEmployees(PDO $pdo, array $student): void
{
    $studentName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $title = 'New student registration submitted';
    $message = "Student {$studentName} ({$schoolId}) submitted an online registration and is awaiting CSDL review in Masterfiles.";

    $employeeIds = studentRegistrationGetEmployeeIdsByPermission($pdo, 'csdl.masterfiles.students.edit');
    if ($employeeIds === []) {
        // Fallback: CSDL Admin role (100)
        try {
            $fallbackStmt = $pdo->query(
                "SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = 100 AND employee_status = 1"
            );
            foreach ($fallbackStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $id = (int) ($row['employee_id'] ?? 0);
                if ($id > 0) {
                    $employeeIds[] = $id;
                }
            }
        } catch (Throwable $e) {
            error_log('CSDL registration fallback notification error: ' . $e->getMessage());
        }
    }

    studentRegistrationSendEmployeeNotifications($pdo, $employeeIds, $title, $message);
}

/**
 * Notify Finance employees that a newly registered student needs a balance record.
 */
function studentRegistrationNotifyFinanceEmployees(PDO $pdo, array $student): void
{
    $studentName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $title = 'New registration awaiting balance setup';
    $message = "Student {$studentName} ({$schoolId}) was approved by CSDL and can now sign in. Assessment must set up their balance before they can apply for a loan.";

    $employeeIds = studentRegistrationGetEmployeeIdsByPermission($pdo, 'assessment.balances.create');
    if ($employeeIds === []) {
        try {
            // Fallback: Query Assessment role (role_id = 101), not Cashier (role_id = 99)
            $fallbackStmt = $pdo->query(
                "SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = 101 AND employee_status = 1"
            );
            foreach ($fallbackStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $id = (int) ($row['employee_id'] ?? 0);
                if ($id > 0) {
                    $employeeIds[] = $id;
                }
            }
        } catch (Throwable $e) {
            error_log('Finance registration fallback notification error: ' . $e->getMessage());
        }
    }

    studentRegistrationSendEmployeeNotifications($pdo, $employeeIds, $title, $message);
}

/**
 * Notify CSDL that Finance completed balance setup for a registration.
 */
function studentRegistrationNotifyCsdlFinanceComplete(PDO $pdo, array $student): void
{
    $studentName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $title = 'Student registration completed';
    $message = "Assessment has set up the balance for {$studentName} ({$schoolId}). Loan applications are now available, subject to the normal eligibility requirements.";

    $employeeIds = studentRegistrationGetEmployeeIdsByPermission($pdo, 'csdl.masterfiles.students.view');
    if ($employeeIds === []) {
        try {
            $fallbackStmt = $pdo->query(
                "SELECT employee_id FROM tbl_csdl_employees WHERE employee_role_id = 100 AND employee_status = 1"
            );
            foreach ($fallbackStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $id = (int) ($row['employee_id'] ?? 0);
                if ($id > 0) {
                    $employeeIds[] = $id;
                }
            }
        } catch (Throwable $e) {
            error_log('CSDL finance-complete fallback notification error: ' . $e->getMessage());
        }
    }

    studentRegistrationSendEmployeeNotifications($pdo, $employeeIds, $title, $message);
}

/**
 * Email student after CSDL approval — account forwarded to Assessment for balance setup.
 *
 * @return array{ok:bool,sent_to:list<string>,failed:list<string>,message:string}
 */
function studentRegistrationSendPendingFinanceEmail(PDO $pdo, array $student): array
{
    $studentId = (int) ($student['student_id'] ?? 0);
    if ($studentId <= 0) {
        return emailQueueQueuedFailureMessage('Pending finance email');
    }

    $recipients = getStudentNotificationEmails($student);
    if ($recipients === []) {
        return [
            'ok' => false,
            'queued' => false,
            'sent_to' => [],
            'failed' => [],
            'message' => 'No valid email on file for this student.',
        ];
    }

    $queued = 0;
    foreach ($recipients as $recipient) {
        $queueId = emailQueueEnqueue($pdo, 'registration_pending_finance', [
            'student_id' => $studentId,
            'recipient' => $recipient,
        ]);
        if ($queueId !== null) {
            $queued++;
        }
    }

    if ($queued !== count($recipients)) {
        return emailQueueQueuedFailureMessage('Pending finance email');
    }

    $result = emailQueueQueuedSuccessMessage('Registration update email');
    $result['sent_to'] = $recipients;
    $result['message'] = 'Student may now sign in. Loan applications remain unavailable until Assessment sets up the balance. Student email notification has been queued for delivery.';
    return $result;
}

function studentRegistrationSendPendingFinanceEmailNow(PDO $pdo, int $studentId, ?string $requestedRecipient = null, string $senderRole = 'csdl'): bool
{
    if ($studentId <= 0) {
        return false;
    }

    $student = studentRegistrationFetchById($pdo, $studentId);
    if (!$student) {
        throw new RuntimeException('Student not found for pending finance email.');
    }

    $recipients = getStudentNotificationEmails($student);
    if ($recipients === []) {
        return true;
    }

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
            throw new RuntimeException('Pending finance recipient is no longer valid for this student.');
        }
        $recipients = [$matchedRecipient];
    }

    $mailerConfig = emailMailerCreate($senderRole);
    if ($mailerConfig === null) {
        return false;
    }

    $fullName = trim(($student['student_first_name'] ?? '') . ' ' . ($student['student_last_name'] ?? ''));
    $schoolId = (string) ($student['student_school_id'] ?? '');
    $logoCid = EmailTemplates::schoolLogoCid();
    $editableValues = ['student_name' => $fullName, 'school_id' => $schoolId];
    $override = EmailTemplates::editableOverride($pdo, $senderRole, 'registration_pending_finance');
    $htmlBody = EmailTemplates::studentRegistrationPendingFinanceEmail(
        $fullName,
        $schoolId,
        $mailerConfig['app_name'],
        $mailerConfig['support_email'],
        null,
        $logoCid,
        EmailTemplates::editableMessage($override, $editableValues)
    );
    $subject = $override ? EmailTemplates::editableText($override['subject'], $editableValues) : 'CSDL approved your registration - you can now sign in';

    foreach ($recipients as $recipient) {
        $emailMsg = (new \Symfony\Component\Mime\Email())
            ->from(sprintf('%s <%s>', $mailerConfig['from_name'], $mailerConfig['from_email']))
            ->to($recipient)
            ->subject($subject)
            ->html($htmlBody);
        EmailTemplates::embedSchoolLogo($emailMsg);
        $mailerConfig['mailer']->send($emailMsg);
    }

    return true;
}

/**
 * After Assessment creates a balance, complete balance setup without changing account access.
 *
 * @return array{completed:bool,message:string,email_sent?:bool}
 */
function studentRegistrationCompleteAfterFinance(PDO $pdo, int $studentId): array
{
    if (!studentRegistrationColumnAvailable($pdo)) {
        return ['completed' => false, 'message' => 'Registration status is not available on this system.'];
    }

    $checkStmt = $pdo->prepare(
        "SELECT student_id FROM tbl_csdl_students s WHERE student_id = ? AND student_registration_status = 'pending_finance'
         AND EXISTS (SELECT 1 FROM tbl_csdl_balances WHERE balance_student_id = s.student_id) LIMIT 1"
    );
    $checkStmt->execute([$studentId]);
    if (!$checkStmt->fetch(PDO::FETCH_ASSOC)) {
        return ['completed' => false, 'message' => 'Student is not awaiting balance setup or has no balance record yet.'];
    }

    $approveStmt = $pdo->prepare(
        "UPDATE tbl_csdl_students SET student_registration_status = 'approved' WHERE student_id = ? AND student_registration_status = 'pending_finance'"
    );
    $approveStmt->execute([$studentId]);
    if ($approveStmt->rowCount() === 0) {
        return ['completed' => false, 'message' => 'Balance setup has already been completed.'];
    }

    $studentRow = studentRegistrationFetchById($pdo, $studentId);
    $emailResult = ['ok' => false, 'message' => '', 'queued' => false];
    if ($studentRow) {
        if (studentRegistrationIsSelfRegistered($pdo, $studentId)) {
            try {
                $emailResult = studentRegistrationSendApprovedEmail($pdo, $studentRow);
            } catch (Throwable $e) {
                error_log('Self-registration balance setup email error: ' . $e->getMessage());
                $emailResult['message'] = 'The balance setup email could not be queued.';
            }
        }
        $studentName = trim(($studentRow['student_first_name'] ?? '') . ' ' . ($studentRow['student_last_name'] ?? ''));
        studentRegistrationSendStudentNotification(
            $pdo,
            $studentId,
            'Balance setup completed',
            "Assessment has set up your balance, {$studentName}. You may now apply for a loan, subject to the normal eligibility requirements."
        );
        studentRegistrationNotifyCsdlFinanceComplete($pdo, $studentRow);
    }

    return [
        'completed' => true,
        'message' => trim('Balance setup completed. Loan applications are now available, subject to the normal eligibility requirements. ' . $emailResult['message']),
        'email_sent' => (bool) ($emailResult['queued'] ?? false),
    ];
}
