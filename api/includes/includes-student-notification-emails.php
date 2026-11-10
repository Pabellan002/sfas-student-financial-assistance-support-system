<?php
/**
 * Resolve school + personal email addresses for student notifications (deduplicated).
 *
 * @param array $data Row with student_email / student_personal_email (or email / personal_email aliases)
 * @return list<string> Valid unique recipient addresses
 */
function getStudentNotificationEmails(array $data): array
{
    $school = trim((string)($data['student_email'] ?? $data['email'] ?? ''));
    $personal = trim((string)($data['student_personal_email'] ?? $data['personal_email'] ?? ''));

    $recipients = [];
    $seen = [];

    foreach ([$school, $personal] as $address) {
        if ($address === '') {
            continue;
        }
        $valid = filter_var($address, FILTER_VALIDATE_EMAIL);
        if ($valid === false) {
            continue;
        }
        $key = strtolower($valid);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $recipients[] = $valid;
    }

    return $recipients;
}

function studentHasNotificationEmail(array $data): bool
{
    return getStudentNotificationEmails($data) !== [];
}

/**
 * Attach all student notification recipients to a Symfony Email.
 *
 * @param \Symfony\Component\Mime\Email $emailMsg
 * @return \Symfony\Component\Mime\Email
 */
function applyStudentNotificationRecipients($emailMsg, array $data)
{
    $recipients = getStudentNotificationEmails($data);
    if ($recipients === []) {
        return $emailMsg;
    }
    return $emailMsg->to(...$recipients);
}

function formatStudentNotificationEmailsForLog(array $data): string
{
    return implode(', ', getStudentNotificationEmails($data));
}
