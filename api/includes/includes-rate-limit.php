<?php
require_once __DIR__ . '/../config/connection-pdo.php';

class RateLimiter {
    
    private $pdo;
    private $ipAddress;
    
    public function __construct() {
        global $pdo;
        $this->pdo = $pdo;
        $this->ipAddress = $this->getIpAddress();
    }
    
    private function getIpAddress() {
        $ipKeys = ['HTTP_CLIENT_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'];
        
        foreach ($ipKeys as $key) {
            if (!empty($_SERVER[$key])) {
                $ips = explode(',', $_SERVER[$key]);
                $ip = trim($ips[0]);
                if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                    return $ip;
                }
            }
        }
        
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }
    
    public function checkRateLimit($action = 'login', $maxAttempts = 5, $timeWindow = 300, $studentId = null, $employeeId = null) {
        try {
            // First, try to find a record matching IP + action + user ID (if provided)
            // If not found, fall back to IP + action only
            $whereClause = "rate_limit_ip = ? AND rate_limit_action = ?";
            $params = [$this->ipAddress, $action];
            $orderByClause = "rate_limit_created_at DESC";
            
            if ($studentId !== null) {
                $whereClause .= " AND (rate_limit_student_id = ? OR rate_limit_student_id IS NULL)";
                $params[] = $studentId;
                $orderByClause = "CASE WHEN rate_limit_student_id = " . intval($studentId) . " THEN 0 ELSE 1 END, " . $orderByClause;
            } elseif ($employeeId !== null) {
                $whereClause .= " AND (rate_limit_employee_id = ? OR rate_limit_employee_id IS NULL)";
                $params[] = $employeeId;
                $orderByClause = "CASE WHEN rate_limit_employee_id = " . intval($employeeId) . " THEN 0 ELSE 1 END, " . $orderByClause;
            }
            
            $stmt = $this->pdo->prepare("
                SELECT 
                    rate_limit_id,
                    rate_limit_attempts,
                    rate_limit_reset_time,
                    rate_limit_blocked_until
                FROM tbl_csdl_rate_limits
                WHERE $whereClause
                ORDER BY $orderByClause
                LIMIT 1
            ");
            
            $stmt->execute($params);
            $record = $stmt->fetch(PDO::FETCH_ASSOC);
            $recordId = $record ? $record['rate_limit_id'] : null;
            
            $now = time();
            
            if (!$record) {
                $resetTime = $now + $timeWindow;
                $stmt = $this->pdo->prepare("
                    INSERT INTO tbl_csdl_rate_limits 
                    (rate_limit_ip, rate_limit_action, rate_limit_attempts, rate_limit_reset_time, rate_limit_student_id, rate_limit_employee_id)
                    VALUES (?, ?, 1, ?, ?, ?)
                ");
                $stmt->execute([$this->ipAddress, $action, $resetTime, $studentId, $employeeId]);
                
                return [
                    'allowed' => true,
                    'remaining' => $maxAttempts - 1,
                    'reset_time' => $resetTime
                ];
            }
            
            if ($record['rate_limit_blocked_until'] && $now < strtotime($record['rate_limit_blocked_until'])) {
                return [
                    'allowed' => false,
                    'remaining' => 0,
                    'reset_time' => strtotime($record['rate_limit_blocked_until']),
                    'message' => 'IP address temporarily blocked. Please try again later.'
                ];
            }
            
            if ($now >= $record['rate_limit_reset_time']) {
                $resetTime = $now + $timeWindow;
                $stmt = $this->pdo->prepare("
                    UPDATE tbl_csdl_rate_limits
                    SET rate_limit_attempts = 1,
                        rate_limit_reset_time = ?,
                        rate_limit_blocked_until = NULL,
                        rate_limit_student_id = ?,
                        rate_limit_employee_id = ?
                    WHERE rate_limit_id = ?
                ");
                $stmt->execute([$resetTime, $studentId, $employeeId, $recordId]);
                
                return [
                    'allowed' => true,
                    'remaining' => $maxAttempts - 1,
                    'reset_time' => $resetTime
                ];
            }
            
            if ($record['rate_limit_attempts'] >= $maxAttempts) {
                $blockUntil = date('Y-m-d H:i:s', $now + 1800);
                $stmt = $this->pdo->prepare("
                    UPDATE tbl_csdl_rate_limits
                    SET rate_limit_blocked_until = ?,
                        rate_limit_student_id = ?,
                        rate_limit_employee_id = ?
                    WHERE rate_limit_id = ?
                ");
                $stmt->execute([$blockUntil, $studentId, $employeeId, $recordId]);
                
                return [
                    'allowed' => false,
                    'remaining' => 0,
                    'reset_time' => strtotime($blockUntil),
                    'message' => 'Too many attempts. IP address blocked for 30 minutes.'
                ];
            }
            
            $stmt = $this->pdo->prepare("
                UPDATE tbl_csdl_rate_limits
                SET rate_limit_attempts = rate_limit_attempts + 1,
                    rate_limit_student_id = ?,
                    rate_limit_employee_id = ?
                WHERE rate_limit_id = ?
            ");
            $stmt->execute([$studentId, $employeeId, $recordId]);
            
            return [
                'allowed' => true,
                'remaining' => $maxAttempts - ($record['rate_limit_attempts'] + 1),
                'reset_time' => $record['rate_limit_reset_time']
            ];
            
        } catch (PDOException $e) {
            error_log("Rate Limiter Error: " . $e->getMessage());
            return [
                'allowed' => true,
                'remaining' => $maxAttempts,
                'reset_time' => time() + $timeWindow
            ];
        }
    }
    
    public function resetRateLimit($action = 'login', $studentId = null, $employeeId = null) {
        try {
            $whereClause = "rate_limit_ip = ? AND rate_limit_action = ?";
            $params = [$this->ipAddress, $action];
            
            if ($studentId !== null) {
                $whereClause .= " AND rate_limit_student_id = ?";
                $params[] = $studentId;
            } elseif ($employeeId !== null) {
                $whereClause .= " AND rate_limit_employee_id = ?";
                $params[] = $employeeId;
            }
            
            $stmt = $this->pdo->prepare("
                DELETE FROM tbl_csdl_rate_limits
                WHERE $whereClause
            ");
            $stmt->execute($params);
        } catch (PDOException $e) {
            error_log("Rate Limit Reset Error: " . $e->getMessage());
        }
    }
    
    public function getCurrentIp() {
        return $this->ipAddress;
    }
}
?>

