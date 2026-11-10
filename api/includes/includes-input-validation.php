<?php
class InputValidation {
    
    public static function sanitizeString($input, $filter = FILTER_SANITIZE_FULL_SPECIAL_CHARS) {
        if (is_null($input)) return null;
        $input = trim($input);
        $input = stripslashes($input);
        return filter_var($input, $filter, FILTER_FLAG_NO_ENCODE_QUOTES);
    }
    
    public static function validateEmail($email) {
        if (empty($email)) return false;
        $email = filter_var($email, FILTER_SANITIZE_EMAIL);
        return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : false;
    }

  /** PHINMAEd school email domain (students). */
    public const PHINMAED_DOMAIN = '@phinmaed.com';

    public static function extractPhinmaEdLocalPart($email) {
        $email = strtolower(trim((string)$email));
        if ($email === '') {
            return '';
        }
        $suffix = self::PHINMAED_DOMAIN;
        if (substr($email, -strlen($suffix)) === $suffix) {
            return substr($email, 0, -strlen($suffix));
        }
        return '';
    }

    /**
     * PHINMAEd local part must end with .coc and include name segments (e.g. romeo.joi.coc, kesa.lumayog.coc).
     */
    public static function validatePhinmaEdLocalPart($local) {
        $local = strtolower(trim((string)$local));
        if ($local === '' || strpos($local, '@') !== false) {
            return false;
        }
        if (strlen($local) > 64) {
            return false;
        }
        return (bool)preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+\.coc$/', $local);
    }

    public static function buildPhinmaEdEmail($local) {
        if (!self::validatePhinmaEdLocalPart($local)) {
            return false;
        }
        return strtolower(trim($local)) . self::PHINMAED_DOMAIN;
    }

    /**
     * Accepts local part only (kesa.lumayog.coc) or full address (kesa.lumayog.coc@phinmaed.com).
     * Returns normalized full email, null if empty, false if invalid.
     */
    public static function normalizeSchoolEmailInput($input) {
        $input = strtolower(trim((string)$input));
        if ($input === '') {
            return null;
        }
        if (strpos($input, '@') !== false) {
            if (substr($input, -strlen(self::PHINMAED_DOMAIN)) !== self::PHINMAED_DOMAIN) {
                return false;
            }
            $local = self::extractPhinmaEdLocalPart($input);
            return self::validatePhinmaEdLocalPart($local) ? $input : false;
        }
        return self::buildPhinmaEdEmail($input);
    }
    
    /**
     * Normalize PH mobile numbers from 09XXXXXXXXX, 9XXXXXXXXX, or 639XXXXXXXXX.
     * Returns digits-only string or null when empty.
     */
    public static function normalizePhilippineMobile($phone) {
        if ($phone === null || trim((string)$phone) === '') {
            return null;
        }
        $digits = preg_replace('/\D/', '', (string)$phone);
        if ($digits === '') {
            return null;
        }
        if (preg_match('/^9\d{9}$/', $digits)) {
            return '0' . $digits;
        }
        if (preg_match('/^09\d{9}$/', $digits)) {
            return $digits;
        }
        if (preg_match('/^639\d{9}$/', $digits)) {
            return '0' . substr($digits, 2);
        }
        return $digits;
    }

    /**
     * @return string|false|null null when empty, false when invalid, normalized 09XXXXXXXXX when valid
     */
    public static function parsePhilippineMobile($phone) {
        $normalized = self::normalizePhilippineMobile($phone);
        if ($normalized === null) {
            return null;
        }
        if (!preg_match('/^09\d{9}$/', $normalized)) {
            return false;
        }
        return $normalized;
    }

    public static function validatePhone($phone) {
        return self::parsePhilippineMobile($phone) !== false;
    }
    
    public static function validateSchoolId($schoolId) {
        if (empty($schoolId)) return false;
        return preg_match('/^\d{2}-\d{4}-\d{4,6}$/', $schoolId);
    }
    
    public static function validatePassword($password, &$errors = []) {
        $errors = [];
        
        if (strlen($password) < 8) {
            $errors[] = "Password must be at least 8 characters long";
        }
        
        if (!preg_match('/[A-Z]/', $password)) {
            $errors[] = "Password must contain at least one uppercase letter";
        }
        
        if (!preg_match('/[a-z]/', $password)) {
            $errors[] = "Password must contain at least one lowercase letter";
        }
        
        if (!preg_match('/[0-9]/', $password)) {
            $errors[] = "Password must contain at least one number";
        }
        
        if (!preg_match('/[^A-Za-z0-9]/', $password)) {
            $errors[] = "Password must contain at least one special character";
        }
        
        return empty($errors);
    }
    
    public static function sanitizeInt($input) {
        return filter_var($input, FILTER_SANITIZE_NUMBER_INT);
    }
    
    public static function sanitizeFloat($input) {
        return filter_var($input, FILTER_SANITIZE_NUMBER_FLOAT, FILTER_FLAG_ALLOW_FRACTION);
    }
    
    public static function validateDate($date, $format = 'Y-m-d') {
        $d = DateTime::createFromFormat($format, $date);
        return $d && $d->format($format) === $date;
    }

    /**
     * Normalize dates from forms/CSV/Excel (serial numbers, M/D/YYYY without leading zeros).
     * @return string|false|null null when empty, Y-m-d when valid, false when invalid
     */
    public static function parseFlexibleDate($value) {
        if ($value === null) {
            return null;
        }
        $raw = trim((string)$value);
        if ($raw === '') {
            return null;
        }

        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw)) {
            return self::validateDate($raw) ? $raw : false;
        }

        // Excel serial date (e.g. 45321) when cell is numeric in CSV
        if (preg_match('/^\d+(\.\d+)?$/', $raw)) {
            $serial = (float)$raw;
            if ($serial >= 1 && $serial <= 2958465) {
                try {
                    $base = new DateTime('1899-12-30');
                    $days = (int)floor($serial);
                    if ($days > 0) {
                        $base->modify('+' . $days . ' days');
                        return $base->format('Y-m-d');
                    }
                } catch (Exception $e) {
                    return false;
                }
            }
        }

        $formats = [
            'Y-m-d', 'Y/m/d',
            'm/d/Y', 'n/j/Y', 'm/d/y', 'n/j/y',
            'd/m/Y', 'j/n/Y', 'd/m/y', 'j/n/y',
            'd-m-Y', 'j-n-Y', 'm-d-Y', 'n-j-Y',
            'M d, Y', 'M d Y',
        ];
        foreach ($formats as $fmt) {
            $d = DateTime::createFromFormat($fmt, $raw);
            if ($d instanceof DateTime) {
                $errors = DateTime::getLastErrors();
                if ($errors === false || (($errors['warning_count'] ?? 0) === 0 && ($errors['error_count'] ?? 0) === 0)) {
                    return $d->format('Y-m-d');
                }
            }
        }

        $ts = strtotime($raw);
        if ($ts !== false) {
            return date('Y-m-d', $ts);
        }

        return false;
    }
    
    public static function sanitizeFilename($filename) {
        $filename = preg_replace('/[^a-zA-Z0-9\-_\.]/', '', $filename);
        $filename = ltrim($filename, './');
        return $filename;
    }
    
    public static function validateFileType($filename, $allowedTypes = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png']) {
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        return in_array($ext, $allowedTypes);
    }
    
    public static function detectSQLInjection($input) {
        $patterns = [
            '/(\bUNION\b.*\bSELECT\b)/i',
            '/(\bSELECT\b.*\bFROM\b)/i',
            '/(\bINSERT\b.*\bINTO\b)/i',
            '/(\bUPDATE\b.*\bSET\b)/i',
            '/(\bDELETE\b.*\bFROM\b)/i',
            '/(\bDROP\b.*\bTABLE\b)/i',
            '/(\bEXEC\b|\bEXECUTE\b)/i',
            '/(\'\s*OR\s*\'\s*=\s*\')/i',
            '/(\'\s*OR\s*1\s*=\s*1)/i',
            '/(;.*--)/',
            '/(\/\*.*\*\/)/',
            '/(\bSCRIPT\b)/i'
        ];
        
        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $input)) {
                return true;
            }
        }
        
        return false;
    }
}
?>
