<?php
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

class CSRFProtection {
    
    public static function generateToken() {
        if (!isset($_SESSION['csrf_token'])) {
            $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
            $_SESSION['csrf_token_time'] = time();
        }
        return $_SESSION['csrf_token'];
    }
    
    public static function getToken() {
        return isset($_SESSION['csrf_token']) ? $_SESSION['csrf_token'] : null;
    }
    
    public static function validateToken($token, $expiry = 3600) {
        if (!isset($_SESSION['csrf_token']) || !isset($_SESSION['csrf_token_time'])) {
            return false;
        }
        
        if (time() - $_SESSION['csrf_token_time'] > $expiry) {
            self::destroyToken();
            return false;
        }
        
        if (!hash_equals($_SESSION['csrf_token'], $token)) {
            return false;
        }
        
        return true;
    }
    
    public static function destroyToken() {
        unset($_SESSION['csrf_token']);
        unset($_SESSION['csrf_token_time']);
    }
    
    public static function regenerateToken() {
        self::destroyToken();
        return self::generateToken();
    }
    
    public static function getTokenJSON() {
        header('Content-Type: application/json');
        // Reuse a valid session token so simultaneous requests cannot invalidate
        // one another. Expired or missing tokens are replaced automatically.
        $token = self::getToken();
        if (!$token || !self::validateToken($token)) {
            $token = self::regenerateToken();
        }
        echo json_encode([
            'success' => true,
            'token' => $token
        ]);
        exit;
    }
    
    public static function handleRequest() {
        if (isset($_GET['action']) && $_GET['action'] === 'get_token') {
            self::getTokenJSON();
        }
    }
    
    public static function validateRequest() {
        $token = $_POST['csrf_token'] ?? $_GET['csrf_token'] ?? null;
        
        if (!$token) {
            $headers = getallheaders();
            if ($headers === false) {
                $headers = [];
                foreach ($_SERVER as $key => $value) {
                    if (strpos($key, 'HTTP_') === 0) {
                        $headerName = str_replace(' ', '-', ucwords(str_replace('_', ' ', strtolower(substr($key, 5)))));
                        $headers[$headerName] = $value;
                    }
                }
            }
            $token = $headers['X-CSRF-Token'] ?? $headers['x-csrf-token'] ?? null;
        }
        
        if (!$token || !self::validateToken($token)) {
            http_response_code(403);
            header('Content-Type: application/json');
            echo json_encode([
                'success' => false,
                'message' => 'CSRF token validation failed. Please refresh the page and try again.',
                'error_code' => 'CSRF_INVALID'
            ]);
            exit;
        }
        return true;
    }
}
?>
