<?php
final class AppPath
{
    public static function base(): string
    {
        $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
        if (preg_match('~^(.*?)/(?:api|views)/~', $script, $match)) {
            return rtrim($match[1], '/');
        }
        $appUrl = (string) (getenv('APP_URL') ?: ($_ENV['APP_URL'] ?? ''));
        return rtrim((string) (parse_url($appUrl, PHP_URL_PATH) ?: ''), '/');
    }

    public static function url(string $path): string
    {
        return self::base() . '/' . ltrim($path, '/');
    }
}
