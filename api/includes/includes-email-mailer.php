<?php

function emailMailerEnsureLoaded(): bool
{
    if (class_exists(\Symfony\Component\Mailer\Mailer::class)) {
        return true;
    }
    $autoload = __DIR__ . '/../../vendor/autoload.php';
    if (file_exists($autoload)) {
        require_once $autoload;
    }
    return class_exists(\Symfony\Component\Mailer\Mailer::class);
}

/**
 * Resolve the SMTP mailbox for the office responsible for an email.
 * Finance serves both Assessment and Cashier. Branch mailboxes are selected by
 * the student's campus before a message is queued. Missing office credentials
 * must never silently switch a message to another office account. System
 * messages and older queued messages use the CSDL mailbox.
 *
 * @return array{host:string,port:int,username:string,password:string,encryption:string,from_email:string,from_name:string,support_email:string,role:string}|null
 */
function emailMailerConfiguration(string $role = 'system'): ?array
{
    $roles = [
        'system' => 'System',
        'csdl' => 'CSDL',
        'assessment' => 'Finance',
        'coo' => 'COO',
        'branch_puerto' => 'Puerto Campus',
        'branch_iligan' => 'Iligan Campus',
        'branch_butuan' => 'Butuan Campus',
        'cashier' => 'Finance',
    ];
    if ($role !== 'legacy' && !isset($roles[$role])) {
        throw new InvalidArgumentException('Unknown email sender role: ' . $role);
    }

    $prefix = match ($role) {
        'legacy', 'system', 'csdl' => 'SMTP_CSDL_',
        'assessment', 'cashier' => 'SMTP_FINANCE_',
        default => 'SMTP_' . strtoupper($role) . '_',
    };

    $host = trim((string) ($_ENV[$prefix . 'HOST'] ?? ''));
    $username = trim((string) ($_ENV[$prefix . 'USERNAME'] ?? ''));
    $password = (string) ($_ENV[$prefix . 'PASSWORD'] ?? '');
    $fromEmail = trim((string) ($_ENV[$prefix . 'FROM_EMAIL'] ?? ''));
    $encryption = strtolower(trim((string) ($_ENV[$prefix . 'ENCRYPTION'] ?? 'tls')));
    $port = (int) ($_ENV[$prefix . 'PORT'] ?? ($encryption === 'ssl' ? 465 : 587));
    if ($host === '' || $username === '' || $password === ''
        || !filter_var($fromEmail, FILTER_VALIDATE_EMAIL)
        || $port < 1 || $port > 65535
        || !in_array($encryption, ['tls', 'ssl'], true)) {
        return null;
    }

    $defaultName = $role === 'legacy'
        ? 'CSDL Support'
        : (($roles[$role] ?? 'System') . ' · Student Financial Assistance');
    $fromName = trim((string) ($_ENV[$prefix . 'FROM_NAME'] ?? $defaultName));
    $supportEmail = trim((string) ($_ENV[$prefix . 'SUPPORT_EMAIL'] ?? $fromEmail));
    if (!filter_var($supportEmail, FILTER_VALIDATE_EMAIL)) {
        $supportEmail = $fromEmail;
    }

    return [
        'host' => $host,
        'port' => $port,
        'username' => $username,
        'password' => $password,
        'encryption' => $encryption,
        'from_email' => $fromEmail,
        'from_name' => $fromName !== '' ? $fromName : $defaultName,
        'support_email' => $supportEmail,
        'role' => $role,
    ];
}

function emailMailerRoleForEmployeeId(int $roleId): string
{
    return match ($roleId) {
        97 => 'coo',
        98 => 'branch_admin',
        99 => 'cashier',
        100 => 'csdl',
        101 => 'assessment',
        default => 'system',
    };
}

function emailMailerBranchRoleForCampusId(int $campusId): string
{
    return match ($campusId) {
        2 => 'branch_puerto',
        3 => 'branch_iligan',
        4 => 'branch_butuan',
        default => throw new InvalidArgumentException('No branch email sender for campus ' . $campusId),
    };
}

function emailMailerIsConfigured(string $role = 'system'): bool
{
    return emailMailerConfiguration($role) !== null;
}

/**
 * @return array{mailer:object,from_email:string,from_name:string,support_email:string,app_name:string}|null
 */
function emailMailerCreate(string $role = 'system'): ?array
{
    $config = emailMailerConfiguration($role);
    if ($config === null || !emailMailerEnsureLoaded()) {
        return null;
    }

    if ($config['encryption'] === 'ssl') {
        $dsn = sprintf(
            'smtps://%s:%s@%s:%d',
            rawurlencode($config['username']),
            rawurlencode($config['password']),
            $config['host'],
            $config['port']
        );
    } else {
        $dsn = sprintf(
            'smtp://%s:%s@%s:%d?encryption=tls',
            rawurlencode($config['username']),
            rawurlencode($config['password']),
            $config['host'],
            $config['port']
        );
    }

    try {
        $transport = \Symfony\Component\Mailer\Transport::fromDsn($dsn);
        $mailer = new \Symfony\Component\Mailer\Mailer($transport);
    } catch (Throwable $e) {
        error_log('Email mailer transport could not be created for role ' . $role);
        return null;
    }

    require_once __DIR__ . '/includes-email-apps-script-fallback.php';
    $fallback = emailAppsScriptFallbackConfiguration($role, $config['from_email']);
    if ($fallback !== null) {
        $mailer = new EmailAppsScriptFallbackMailer($mailer, $fallback);
    }

    return [
        'mailer' => $mailer,
        'from_email' => $config['from_email'],
        'from_name' => $config['from_name'],
        'support_email' => $config['support_email'],
        'role' => $role,
        'app_name' => $_ENV['APP_NAME'] ?? 'Student Financial Assistance System',
    ];
}
