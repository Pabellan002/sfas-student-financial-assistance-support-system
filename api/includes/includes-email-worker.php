<?php

require_once __DIR__ . '/includes-email-queue.php';

function emailWorkerOptions(array $arguments, array $environment): array
{
    $options = [
        'watch' => false, 'dry_run' => false, 'help' => false,
        'interval' => $environment['EMAIL_QUEUE_POLL_SECONDS'] ?? 15,
        'batch_size' => $environment['EMAIL_QUEUE_BATCH_SIZE'] ?? 25,
        'retry_delay' => $environment['EMAIL_QUEUE_RETRY_DELAY_SECONDS'] ?? 60,
        'max_cycles' => 0,
    ];
    foreach (array_slice($arguments, 1) as $argument) {
        if (in_array($argument, ['--watch', '--dry-run', '--help'], true)) {
            $options[str_replace('-', '_', substr($argument, 2))] = true;
        } elseif (preg_match('/^--(interval|max-cycles)=(\d+)$/', $argument, $match)) {
            $options[str_replace('-', '_', $match[1])] = $match[2];
        } else {
            throw new InvalidArgumentException('Unknown argument. Use --help for supported options.');
        }
    }
    foreach (['interval' => [1, 60], 'batch_size' => [1, 100], 'retry_delay' => [5, 3600], 'max_cycles' => [0, 1000000]] as $key => [$min, $max]) {
        $value = filter_var($options[$key], FILTER_VALIDATE_INT);
        if ($value === false || $value < $min || $value > $max) {
            throw new InvalidArgumentException("Invalid {$key}; expected an integer between {$min} and {$max}.");
        }
        $options[$key] = $value;
    }
    return $options;
}

/** Connect afresh each cycle so idle database timeouts do not strand a long-running worker. */
function emailWorkerConnect(array $environment): PDO
{
    $host = $environment['DB_HOST'] ?? 'localhost';
    $database = $environment['DB_NAME'] ?? 'db_csdl_student_loan';
    return new PDO("mysql:host={$host};dbname={$database};charset=utf8mb4",
        $environment['DB_USER'] ?? 'root', $environment['DB_PASS'] ?? '', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
}

/** One cycle. The dry run never creates reminders, updates queue records, or contacts SMTP. */
function emailWorkerCycle(PDO $pdo, array $options, float &$nextReminderCheck, ?callable $shouldStop = null): array
{
    if ($options['dry_run']) {
        $delay = $options['retry_delay'];
        $queue = $pdo->query("SELECT email_queue_status AS status, COUNT(*) AS total,
            SUM(CASE WHEN email_queue_status = 'pending' AND email_queue_attempts < email_queue_max_attempts
                AND (email_queue_processed_at IS NULL OR email_queue_processed_at <= DATE_SUB(NOW(), INTERVAL {$delay} SECOND))
                THEN 1 ELSE 0 END) AS ready
            FROM tbl_csdl_email_queue GROUP BY email_queue_status")->fetchAll();
        return ['success' => true, 'dry_run' => true, 'queue' => $queue];
    }

    $database = (string) $pdo->query('SELECT DATABASE()')->fetchColumn();
    $lockName = 'sfas-email-worker:' . substr(hash('sha256', $database), 0, 32);
    $lock = $pdo->prepare('SELECT GET_LOCK(?, 0)');
    $lock->execute([$lockName]);
    $lockResult = $lock->fetchColumn();
    if ($lockResult === null || $lockResult === false) {
        throw new RuntimeException('Unable to acquire email worker lock.');
    }
    if ((int) $lockResult !== 1) {
        return ['success' => true, 'busy' => true];
    }
    try {
        $overdueNotices = 0;
        if (microtime(true) >= $nextReminderCheck && !($shouldStop && $shouldStop())) {
            require_once __DIR__ . '/includes-send-loan-notifications.php';
            $overdueNotices = queueOverdueLoanNotifications($pdo);
            $nextReminderCheck = microtime(true) + 60;
        }
        $stats = emailQueueProcessBatch($pdo, $options['batch_size'], $options['retry_delay'], $shouldStop);
        return ['success' => $stats['failed'] === 0 && $stats['errors'] === [],
            'overdue_notices' => $overdueNotices] + $stats;
    } finally {
        $release = $pdo->prepare('SELECT RELEASE_LOCK(?)');
        $release->execute([$lockName]);
    }
}

/** Callback-based loop keeps timing/error recovery testable without sending email. */
function emailWorkerRun(array $options, callable $cycle, callable $wait, callable $log, callable $shouldStop): int
{
    $cycles = 0;
    $failures = 0;
    $exitCode = 0;
    $lastLog = 0.0;
    while (!$shouldStop()) {
        try {
            $result = $cycle();
        } catch (Throwable $e) {
            // Never print a connection string, password, or notification payload.
            $result = ['success' => false, 'error' => 'Email worker cycle failed; check database availability and server logs.',
                'error_type' => get_class($e), 'error_code' => (string) $e->getCode()];
        }
        $cycles++;
        $failed = empty($result['success']);
        $failures = $failed ? $failures + 1 : 0;
        if ($failed) $exitCode = 1;
        if (!$options['watch'] || $options['dry_run'] || $failed || !empty($result['processed'])
            || !empty($result['overdue_notices']) || microtime(true) - $lastLog >= 60) {
            $log(['time' => date(DATE_ATOM), 'cycle' => $cycles] + $result);
            $lastLog = microtime(true);
        }
        if (!$options['watch'] || ($options['max_cycles'] > 0 && $cycles >= $options['max_cycles']) || $shouldStop()) break;
        // Drain a healthy backlog without an unnecessary polling pause between full batches.
        $delay = !$failed && (int) ($result['processed'] ?? 0) >= $options['batch_size'] && empty($result['busy'])
            ? 0 : $options['interval'];
        if ($failed) $delay = min(60, max($delay, 5 * (2 ** min($failures - 1, 4))));
        $wait($delay);
    }
    // A long-running worker may recover from an earlier transient failure.
    // Report a clean supervisor stop as success once the latest cycles are healthy.
    return $options['watch'] && $shouldStop() && $failures === 0 ? 0 : $exitCode;
}
