<?php

/**
 * Optional SMTP connection fallback. Each office must have its own Apps Script
 * deployment, owned by that office's Workspace mailbox. No browser route may
 * accept arbitrary mail requests.
 */
function emailAppsScriptFallbackConfiguration(string $role, string $fromEmail): ?array
{
    if (($_ENV['EMAIL_APPS_SCRIPT_FALLBACK_ENABLED'] ?? '') !== '1') {
        return null;
    }

    $office = match ($role) {
        'legacy', 'system', 'csdl' => 'SYSTEM',
        'assessment', 'cashier' => 'FINANCE',
        'coo' => 'COO',
        'branch_puerto' => 'BRANCH_PUERTO',
        'branch_iligan' => 'BRANCH_ILIGAN',
        'branch_butuan' => 'BRANCH_BUTUAN',
        default => throw new InvalidArgumentException('Unknown Apps Script sender role: ' . $role),
    };
    $prefix = 'APPS_SCRIPT_' . $office . '_';
    $url = trim((string) ($_ENV[$prefix . 'URL'] ?? ''));
    $secret = (string) ($_ENV[$prefix . 'SECRET'] ?? '');
    if ($url === '' && $secret === '') {
        return null;
    }
    if (!preg_match('~^https://script\.google\.com/(?:macros/s|a/macros/[A-Za-z0-9.-]+/s)/[A-Za-z0-9_-]+/exec$~D', $url)
        || strlen($secret) < 32) {
        error_log('Apps Script fallback configuration is incomplete for ' . $office);
        return null;
    }

    return ['url' => $url, 'secret' => $secret, 'from_email' => $fromEmail, 'office' => $office];
}

final class EmailAppsScriptFallbackMailer
{
    private const MAX_BINARY_BYTES = 12 * 1024 * 1024;

    public function __construct(
        private readonly \Symfony\Component\Mailer\MailerInterface $smtp,
        private readonly array $config,
        private readonly ?Closure $post = null,
    ) {
    }

    public function send(\Symfony\Component\Mime\Email $email): void
    {
        try {
            $this->smtp->send($email);
            return;
        } catch (\Symfony\Component\Mailer\Exception\TransportExceptionInterface $smtpError) {
            if (!self::isConnectionFailure($smtpError->getMessage())) {
                throw $smtpError;
            }
            try {
                $this->sendFallback($email);
                error_log('Email delivered through Apps Script fallback for ' . $this->config['office']);
                return;
            } catch (Throwable $fallbackError) {
                throw new RuntimeException(
                    'SMTP connection failed; Apps Script fallback failed: ' . $fallbackError->getMessage(),
                    0,
                    $smtpError
                );
            }
        }
    }

    private static function isConnectionFailure(string $message): bool
    {
        $message = strtolower($message);
        // A failed SMTP DATA acknowledgement is ambiguous: Google may already
        // have accepted the mail, so do not send a duplicate through fallback.
        if (str_contains($message, 'daily') || str_contains($message, 'quota')) {
            return false;
        }
        foreach (['connection could not be established', 'connection refused',
            'could not connect', 'unable to connect', 'network is unreachable',
            'php_network_getaddresses', 'name or service not known',
            'unable to connect with starttls'] as $needle) {
            if (str_contains($message, $needle)) {
                return true;
            }
        }
        return false;
    }

    private function sendFallback(\Symfony\Component\Mime\Email $email): void
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('PHP cURL is unavailable');
        }
        $from = $email->getFrom();
        if (count($from) !== 1 || strcasecmp($from[0]->getAddress(), $this->config['from_email']) !== 0) {
            throw new RuntimeException('Email sender does not match configured office');
        }
        $to = array_map(static fn ($address) => $address->getAddress(), $email->getTo());
        if (!$to || count($to) > 50) {
            throw new RuntimeException('Invalid recipient count for Apps Script');
        }
        $replyTo = $email->getReplyTo();
        $inline = [];
        $attachments = [];
        $binaryBytes = 0;
        foreach ($email->getAttachments() as $part) {
            $bytes = $part->getBody();
            $binaryBytes += strlen($bytes);
            if ($binaryBytes > self::MAX_BINARY_BYTES) {
                throw new RuntimeException('Email attachments exceed fallback size limit');
            }
            $item = [
                'name' => $part->getFilename() ?: 'attachment',
                'type' => $part->getContentType(),
                'data' => base64_encode($bytes),
            ];
            if ($part->getDisposition() === 'inline') {
                $inline[$item['name']] = $item;
            } else {
                $attachments[] = $item;
            }
        }
        $payload = json_encode([
            'timestamp' => time(),
            'nonce' => bin2hex(random_bytes(16)),
            'from_email' => $this->config['from_email'],
            'from_name' => $from[0]->getName(),
            'to' => $to,
            'reply_to' => $replyTo ? $replyTo[0]->getAddress() : '',
            'subject' => (string) $email->getSubject(),
            'text' => (string) ($email->getTextBody() ?: strip_tags((string) $email->getHtmlBody())),
            'html' => (string) $email->getHtmlBody(),
            'inline_images' => $inline,
            'attachments' => $attachments,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        $request = json_encode([
            'payload' => $payload,
            'signature' => hash_hmac('sha256', $payload, $this->config['secret']),
        ], JSON_THROW_ON_ERROR);

        $post = $this->post ?? self::post(...);
        $response = $post($this->config['url'], $request);
        $result = json_decode($response, true);
        if (!is_array($result) || ($result['ok'] ?? false) !== true
            || strcasecmp((string) ($result['sender'] ?? ''), $this->config['from_email']) !== 0) {
            $code = is_array($result) ? (string) ($result['error'] ?? 'invalid_response') : 'invalid_response';
            if ($code === 'quota') {
                throw new RuntimeException('daily sending quota exceeded on Apps Script fallback');
            }
            throw new RuntimeException('Apps Script rejected delivery (' . preg_replace('/[^a-z_]/', '', $code) . ')');
        }
    }

    private static function post(string $url, string $request): string
    {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $request,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 25,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $response = curl_exec($curl);
        $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $finalUrl = (string) curl_getinfo($curl, CURLINFO_EFFECTIVE_URL);
        $error = curl_error($curl);
        curl_close($curl);
        $finalHost = strtolower((string) parse_url($finalUrl, PHP_URL_HOST));
        if ($response === false || $status !== 200
            || !in_array($finalHost, ['script.google.com', 'script.googleusercontent.com'], true)) {
            throw new RuntimeException('Apps Script HTTP delivery failed' . ($error !== '' ? ' (network error)' : ''));
        }
        return $response;
    }
}
