<?php
/**
 * Email queue CLI. The systemd service uses --watch for continuous delivery.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'CLI only']);
    exit(1);
}

require_once __DIR__ . '/../config/config-env.php';
require_once __DIR__ . '/../includes/includes-email-worker.php';

try {
    $options = emailWorkerOptions($argv, $_ENV);
} catch (InvalidArgumentException $e) {
    fwrite(STDERR, $e->getMessage() . PHP_EOL);
    exit(2);
}
if ($options['help']) {
    echo <<<'HELP'
Email queue worker
  php process-email-queue.php                   Process one batch manually
  php process-email-queue.php --watch           Keep running; poll every 15 seconds
  php process-email-queue.php --dry-run         Read queue counts only; never send or update
  php process-email-queue.php --watch --dry-run --max-cycles=3
Options:
  --interval=N      Idle polling seconds, 1-60 (default 15)
  --max-cycles=N    Stop after N cycles; 0 means unlimited in watch mode
Environment (.env):
  EMAIL_QUEUE_POLL_SECONDS=15
  EMAIL_QUEUE_BATCH_SIZE=25
  EMAIL_QUEUE_RETRY_DELAY_SECONDS=60
Real runs send pending mail and enqueue due reminders. Use Ctrl+C to stop.
Production delivery runs as the sfas-email-worker.service background worker.
HELP;
    echo PHP_EOL;
    exit(0);
}

set_time_limit(0);
$stopRequested = false;
$shouldStop = static function () use (&$stopRequested): bool { return $stopRequested; };
if (function_exists('pcntl_async_signals') && function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    $stopHandler = static function () use (&$stopRequested): void { $stopRequested = true; };
    pcntl_signal(SIGTERM, $stopHandler);
    pcntl_signal(SIGINT, $stopHandler);
}
if (function_exists('sapi_windows_set_ctrl_handler')) {
    sapi_windows_set_ctrl_handler(static function (int $event) use (&$stopRequested): void {
        if ($event === PHP_WINDOWS_EVENT_CTRL_C || $event === PHP_WINDOWS_EVENT_CTRL_BREAK) {
            $stopRequested = true;
        }
    });
}
$nextReminderCheck = 0.0;
$exitCode = emailWorkerRun(
    $options,
    static function () use ($options, &$nextReminderCheck, $shouldStop): array {
        $pdo = emailWorkerConnect($_ENV);
        return emailWorkerCycle($pdo, $options, $nextReminderCheck, $shouldStop);
    },
    static function (int $seconds) use ($shouldStop): void {
        $until = microtime(true) + $seconds;
        while (!$shouldStop() && microtime(true) < $until) {
            usleep((int) (min(0.2, max(0, $until - microtime(true))) * 1000000));
        }
    },
    static function (array $result): void {
        echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . PHP_EOL;
    },
    $shouldStop
);
exit($exitCode);
