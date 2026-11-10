<?php
class SecurityHeaders {
    
    public static function setHeaders() {
        header('X-Frame-Options: DENY');
        header('X-Content-Type-Options: nosniff');
        header('X-XSS-Protection: 1; mode=block');
        header('Referrer-Policy: strict-origin-when-cross-origin');
        header('Permissions-Policy: geolocation=(), microphone=(), camera=()');
        self::setCSP();
        
        if (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') {
            header('Strict-Transport-Security: max-age=31536000; includeSubDomains; preload');
        }
    }
    
    private static function setCSP() {
        $csp = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fcm.googleapis.com https://challenges.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
            "img-src 'self' data: https: blob:",
            "font-src 'self' https://cdn.jsdelivr.net data:",
            "connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fcm.googleapis.com",
            "frame-src 'self' https://challenges.cloudflare.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
            "upgrade-insecure-requests"
        ];
        
        header("Content-Security-Policy: " . implode('; ', $csp));
    }
    
    public static function setSessionSecurity() {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        
        ini_set('session.cookie_httponly', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.cookie_samesite', 'Lax');
        ini_set('session.cookie_path', '/');
        ini_set('session.cookie_lifetime', 0);
        
        if (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') {
            ini_set('session.cookie_secure', '1');
        }
    }
    
    public static function initSession() {
        if (session_status() === PHP_SESSION_NONE) {
            self::setSessionSecurity();
            session_start();
            
            if (!isset($_SESSION['initiated'])) {
                session_regenerate_id(true);
                $_SESSION['initiated'] = true;
            }
        }
    }
}
?>

