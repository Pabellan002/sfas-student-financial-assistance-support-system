<?php

require_once __DIR__ . '/includes-email-mailer.php';

const EMAIL_QUEUE_TYPES = [
    'loan_notification',
    'registration_submitted',
    'registration_rejected',
    'registration_approved',
    'registration_pending_finance',
    'loan_application_receipt',
];

function emailQueueEnsureTable(PDO $pdo): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    // Checking an existing table must not implicitly commit a caller's transaction.
    try {
        $pdo->query('SELECT 1 FROM tbl_csdl_email_queue LIMIT 0');
        $checked = true;
        return;
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02' || $pdo->inTransaction()) {
            throw $e;
        }
    }

    $pdo->exec("CREATE TABLE IF NOT EXISTS tbl_csdl_email_queue (
        email_queue_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        email_queue_type VARCHAR(64) NOT NULL,
        email_queue_payload JSON NOT NULL,
        email_queue_status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
        email_queue_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        email_queue_max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 3,
        email_queue_last_error TEXT NULL,
        email_queue_created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        email_queue_processed_at DATETIME NULL,
        PRIMARY KEY (email_queue_id),
        KEY idx_email_queue_status_created (email_queue_status, email_queue_created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $checked = true;
}

function emailQueueEnqueue(PDO $pdo, string $type, array $payload): ?int
{
    if (!in_array($type, EMAIL_QUEUE_TYPES, true)) {
        error_log('Email queue: invalid type ' . $type);
        return null;
    }

    // Keep the sender with the job so later role changes cannot reroute it.
    if (!isset($payload['sender_role'])) {
        $payload['sender_role'] = match ($type) {
            'registration_submitted', 'registration_rejected', 'registration_pending_finance', 'loan_application_receipt' => 'csdl',
            'registration_approved' => 'assessment',
            default => 'system',
        };
    }

    try {
        emailQueueEnsureTable($pdo);
        $stmt = $pdo->prepare(
            'INSERT INTO tbl_csdl_email_queue (email_queue_type, email_queue_payload, email_queue_status, email_queue_created_at)
             VALUES (?, ?, \'pending\', NOW())'
        );
        $stmt->execute([$type, json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)]);
        return (int) $pdo->lastInsertId();
    } catch (Throwable $e) {
        error_log('Email queue enqueue error: ' . $e->getMessage());
        return null;
    }
}

function emailQueueIsDailyProviderLimit(string $message): bool
{
    $message = strtolower($message);
    return str_contains($message, 'daily user sending limit exceeded')
        || str_contains($message, 'daily sending quota exceeded')
        || str_contains($message, 'daily message quota exceeded');
}

/** @return list<string> */
function emailQueueRolesSharingMailbox(string $senderRole): array
{
    $sender = emailMailerConfiguration($senderRole);
    if ($sender === null) {
        return [$senderRole];
    }

    $shared = [];
    foreach (['legacy', 'system', 'csdl', 'assessment', 'coo', 'branch_puerto', 'branch_iligan', 'branch_butuan', 'cashier'] as $role) {
        $candidate = emailMailerConfiguration($role);
        if ($candidate !== null
            && strcasecmp($candidate['host'], $sender['host']) === 0
            && strcasecmp($candidate['username'], $sender['username']) === 0) {
            $shared[] = $role;
        }
    }
    return $shared;
}

function emailQueueResolvedSenderRole(PDO $pdo, string $type, array $payload): string
{
    $role = (string) ($payload['sender_role'] ?? 'legacy');
    if ($role !== 'branch_admin') {
        return $role;
    }

    $campusId = (int) ($payload['loan']['student_campus_id'] ?? 0);
    if ($campusId === 0 && $type === 'loan_notification') {
        $applicationNo = (string) ($payload['application_no'] ?? '');
        $stmt = $pdo->prepare('SELECT s.student_campus_id FROM tbl_csdl_loans l JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id WHERE l.loan_application_no = ? LIMIT 1');
        $stmt->execute([$applicationNo]);
        $campusId = (int) ($stmt->fetchColumn() ?: 0);
    }

    return emailMailerBranchRoleForCampusId($campusId);
}

/**
 * @return array{processed:int,sent:int,failed:int,errors:list<string>}
 */
function emailQueueProcessBatch(PDO $pdo, int $limit = 20, int $retryDelaySeconds = 60, ?callable $shouldStop = null): array
{
    if ($pdo->inTransaction()) {
        throw new RuntimeException('Email delivery must run outside a database transaction.');
    }

    emailQueueEnsureTable($pdo);

    $stats = [
        'processed' => 0,
        'sent' => 0,
        'failed' => 0,
        'errors' => [],
    ];

    $limit = max(1, min(100, $limit));
    $retryDelaySeconds = max(5, min(3600, $retryDelaySeconds));

    try {
        $stmt = $pdo->prepare(
            "SELECT email_queue_id, email_queue_type, email_queue_payload, email_queue_attempts, email_queue_max_attempts
             FROM tbl_csdl_email_queue
             WHERE email_queue_status = 'pending'
               AND email_queue_attempts < email_queue_max_attempts
               AND (email_queue_processed_at IS NULL
                    OR email_queue_processed_at <= DATE_SUB(NOW(), INTERVAL {$retryDelaySeconds} SECOND))
             ORDER BY CASE email_queue_type
                        WHEN 'registration_submitted' THEN 0
                        WHEN 'registration_rejected' THEN 0
                        WHEN 'registration_pending_finance' THEN 1
                        WHEN 'loan_notification' THEN 2
                        WHEN 'loan_application_receipt' THEN 3
                        WHEN 'registration_approved' THEN 4
                        ELSE 5
                      END,
                      email_queue_created_at ASC, email_queue_id ASC
             LIMIT {$limit}"
        );
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        $stats['errors'][] = $e->getMessage();
        return $stats;
    }

    foreach ($rows as $row) {
        if ($shouldStop && $shouldStop()) {
            break;
        }
        $queueId = (int) ($row['email_queue_id'] ?? 0);
        if ($queueId <= 0) {
            continue;
        }

        $claim = $pdo->prepare(
            "UPDATE tbl_csdl_email_queue
             SET email_queue_status = 'processing', email_queue_attempts = email_queue_attempts + 1,
                 email_queue_processed_at = NOW()
             WHERE email_queue_id = ? AND email_queue_status = 'pending'
               AND email_queue_attempts = ? AND email_queue_attempts < email_queue_max_attempts
               AND (email_queue_processed_at IS NULL
                    OR email_queue_processed_at <= DATE_SUB(NOW(), INTERVAL {$retryDelaySeconds} SECOND))"
        );
        $claim->execute([$queueId, (int) $row['email_queue_attempts']]);
        if ($claim->rowCount() === 0) {
            continue;
        }

        $stats['processed']++;
        $type = (string) ($row['email_queue_type'] ?? '');
        $payload = json_decode((string) ($row['email_queue_payload'] ?? '{}'), true);
        if (!is_array($payload)) {
            $payload = [];
        }
        // Balance-setup emails belong only to accounts created through public registration.
        if ($type === 'registration_approved') {
            require_once __DIR__ . '/includes-student-registration.php';
            if (!studentRegistrationIsSelfRegistered($pdo, (int) ($payload['student_id'] ?? 0))) {
                $pdo->prepare(
                    "UPDATE tbl_csdl_email_queue
                     SET email_queue_status = 'failed', email_queue_attempts = email_queue_max_attempts,
                         email_queue_processed_at = NOW(), email_queue_last_error = 'Balance setup email skipped: account was not self-registered.'
                     WHERE email_queue_id = ?"
                )->execute([$queueId]);
                $stats['failed']++;
                continue;
            }
        }
        try {
            $senderRole = emailQueueResolvedSenderRole($pdo, $type, $payload);
            $ok = emailQueueDispatch($pdo, $type, $payload);
            if ($ok) {
                $pdo->prepare(
                    "UPDATE tbl_csdl_email_queue
                     SET email_queue_status = 'sent', email_queue_processed_at = NOW(), email_queue_last_error = NULL
                     WHERE email_queue_id = ?"
                )->execute([$queueId]);
                $stats['sent']++;
            } else {
                throw new RuntimeException('Processor returned false for type ' . $type);
            }
        } catch (Throwable $e) {
            $message = $e->getMessage();
            error_log("Email queue #{$queueId} ({$type}) failed: {$message}");

            if (emailQueueIsDailyProviderLimit($message)) {
                // Pause only this mailbox. Other offices have separate SMTP
                // accounts and must remain free to deliver their own messages.
                $pdo->prepare(
                    "UPDATE tbl_csdl_email_queue
                     SET email_queue_status = 'pending',
                         email_queue_attempts = GREATEST(email_queue_attempts - 1, 0),
                         email_queue_last_error = ?,
                         email_queue_processed_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)
                     WHERE email_queue_id = ?"
                )->execute([$message, $queueId]);
                $sharedRoles = emailQueueRolesSharingMailbox($senderRole);
                $placeholders = implode(', ', array_fill(0, count($sharedRoles), '?'));
                $pauseRole = $pdo->prepare(
                    "UPDATE tbl_csdl_email_queue
                     SET email_queue_processed_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)
                     WHERE email_queue_status = 'pending'
                       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(email_queue_payload, '$.sender_role')), 'legacy') IN ({$placeholders})
                       AND (email_queue_processed_at IS NULL OR email_queue_processed_at < NOW())"
                );
                $pauseRole->execute($sharedRoles);
                $stats['errors'][] = "Email provider daily sending limit reached for {$senderRole}; messages sharing that mailbox were deferred for 24 hours.";
                continue;
            }

            $stats['failed']++;
            $stats['errors'][] = "#{$queueId}: {$message}";

            $attempts = (int) ($row['email_queue_attempts'] ?? 0) + 1;
            $maxAttempts = (int) ($row['email_queue_max_attempts'] ?? 3);
            $newStatus = $attempts >= $maxAttempts ? 'failed' : 'pending';

            $pdo->prepare(
                "UPDATE tbl_csdl_email_queue
                 SET email_queue_status = ?, email_queue_last_error = ?, email_queue_processed_at = NOW()
                 WHERE email_queue_id = ?"
            )->execute([$newStatus, $message, $queueId]);
        }
    }

    return $stats;
}

function emailQueueDispatch(PDO $pdo, string $type, array $payload): bool
{
    // Jobs created before role routing keep using the original SMTP_* mailbox.
    $senderRole = emailQueueResolvedSenderRole($pdo, $type, $payload);
    switch ($type) {
        case 'loan_notification':
            require_once __DIR__ . '/includes-send-loan-notifications.php';
            return sendLoanNotificationsNow(
                $pdo,
                (array) ($payload['loan'] ?? []),
                (string) ($payload['process_type'] ?? ''),
                (string) ($payload['application_no'] ?? ''),
                isset($payload['amount_approved']) ? (string) $payload['amount_approved'] : null,
                isset($payload['payment_due_date']) ? (string) $payload['payment_due_date'] : null,
                isset($payload['destination_office']) ? (string) $payload['destination_office'] : null,
                isset($payload['recipient']) ? (string) $payload['recipient'] : null,
                isset($payload['updated_amount_can_pay']) ? (string) $payload['updated_amount_can_pay'] : null,
                $senderRole
            );
        case 'registration_approved':
            require_once __DIR__ . '/includes-student-registration.php';
            return studentRegistrationSendApprovedEmailNow(
                $pdo,
                (int) ($payload['student_id'] ?? 0),
                isset($payload['recipient']) ? (string) $payload['recipient'] : null,
                $senderRole
            );
        case 'registration_submitted':
            require_once __DIR__ . '/includes-student-registration.php';
            return studentRegistrationSendSubmittedEmailNow(
                $pdo,
                (int) ($payload['student_id'] ?? 0),
                isset($payload['recipient']) ? (string) $payload['recipient'] : null,
                $senderRole
            );
        case 'registration_rejected':
            require_once __DIR__ . '/includes-student-registration.php';
            return studentRegistrationSendRejectedEmailNow($pdo, $payload, $senderRole);
        case 'registration_pending_finance':
            require_once __DIR__ . '/includes-student-registration.php';
            return studentRegistrationSendPendingFinanceEmailNow(
                $pdo,
                (int) ($payload['student_id'] ?? 0),
                isset($payload['recipient']) ? (string) $payload['recipient'] : null,
                $senderRole
            );
        case 'loan_application_receipt':
            require_once __DIR__ . '/includes-send-loan-application-email.php';
            return sendLoanApplicationReceiptEmailNow(
                (array) ($payload['student'] ?? []),
                (array) ($payload['details'] ?? []),
                isset($payload['guardian_id_path']) ? (string) $payload['guardian_id_path'] : null,
                isset($payload['guardian_id_name']) ? (string) $payload['guardian_id_name'] : null,
                isset($payload['recipient']) ? (string) $payload['recipient'] : null,
                $senderRole,
                $pdo
            );
        default:
            throw new RuntimeException('Unknown email queue type: ' . $type);
    }
}

function emailQueueQueuedSuccessMessage(string $contextLabel = 'Email notification'): array
{
    return [
        'ok' => true,
        'queued' => true,
        'sent_to' => [],
        'failed' => [],
        'message' => $contextLabel . ' has been queued and will be sent shortly.',
    ];
}

function emailQueueQueuedFailureMessage(string $contextLabel = 'Email notification'): array
{
    return [
        'ok' => false,
        'queued' => false,
        'sent_to' => [],
        'failed' => [],
        'message' => $contextLabel . ' could not be queued. Please verify email settings.',
    ];
}
