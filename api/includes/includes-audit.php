<?php
class AuditLogger {
    private static bool $trackingInstalled = false;
    private static bool $loggedManually = false;
    private static ?PDO $trackingPdo = null;
    private static string $capturedOutput = '';
    private static string $requestBody = '';
    private static int $bufferLevel = 0;

    public static function log(PDO $pdo, string $action, string $details = '', ?int $studentId = null, ?int $employeeId = null, int $records = 1): void {
        $ip = $_SERVER['REMOTE_ADDR'] ?? '';
        $agent = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $stmt = $pdo->prepare(
            "INSERT INTO tbl_csdl_audit_log 
            (audit_log_employee_id, audit_log_student_id, audit_log_action, audit_log_records, audit_log_details, audit_log_ip_address, audit_log_user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        $stmt->execute([
            $employeeId,
            $studentId,
            $action,
            $records,
            $details,
            $ip,
            $agent
        ]);
        self::$loggedManually = true;
    }

    /** Capture successful, authenticated API writes without storing form contents. */
    public static function trackRequest(PDO $pdo): void {
        if (self::$trackingInstalled || !in_array(strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')), ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            return;
        }

        $path = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
        if (!preg_match('~/api/(masterfiles|csdl|assessment|coo|branch-admin|cashier|students|shared)/([^/]+\.php)$~', $path, $match)) {
            return;
        }
        $file = $match[2];
        if (preg_match('/(?:notification|push-subscription|chatbot|id-validation)/', $file)
            || $file === 'masterfiles-permissions.php') {
            return;
        }

        self::$trackingInstalled = true;
        self::$trackingPdo = $pdo;
        if (str_contains(strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? '')), 'application/json')
            && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) <= 65536) {
            $body = (string) file_get_contents('php://input', false, null, 0, 65537);
            if (strlen($body) <= 65536) self::$requestBody = $body;
        }
        ob_start(static function (string $chunk): string {
            if (strlen(self::$capturedOutput) + strlen($chunk) <= 1048576) {
                self::$capturedOutput .= $chunk;
            }
            return $chunk;
        });
        self::$bufferLevel = ob_get_level();
        register_shutdown_function([self::class, 'finishRequest']);
    }

    public static function finishRequest(): void {
        if (!self::$trackingInstalled || self::$loggedManually || self::$trackingPdo === null) return;
        $status = http_response_code();
        if (!is_int($status) || $status < 200 || $status >= 300) return;
        $lastError = error_get_last();
        if ($lastError && in_array($lastError['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) return;

        $output = self::$capturedOutput;
        if (ob_get_level() >= self::$bufferLevel) {
            $output .= (string) ob_get_contents();
        }
        $response = json_decode(trim($output), true);
        if (!is_array($response) || ($response['success'] ?? null) !== true) return;

        $body = json_decode(self::$requestBody, true);
        $input = array_merge(is_array($body) ? $body : [], $_POST);
        $path = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
        if (!preg_match('~/api/([^/]+)/([^/]+)\.php$~', $path, $match)) return;
        $area = $match[1];
        $resource = preg_replace('/^' . preg_quote($area, '/') . '-/', '', $match[2]);
        $rawOperation = (string) ($input['action'] ?? $_GET['action'] ?? 'submit');
        $operation = strtolower(preg_replace('/([a-z])([A-Z])/', '$1_$2', str_replace('-', '_', $rawOperation)));
        if (!preg_match('/^[a-z][a-z0-9_]{0,63}$/', $operation)
            || preg_match('/^(get|list|fetch|filter|stats|search|export|check|validate|preview|scan)(_|$)/', $operation)
            || preg_match('/(^|_)(filters|stats|list|details|export|preview)$/', $operation)
            || in_array($operation, ['send_otp', 'request_otp', 'resend_otp', 'typing', 'mark_read'], true)
            || ($match[2] === 'shared-loan-chat' && $operation !== 'send')
            || ($match[2] === 'csdl-loans-management' && in_array($operation, ['archive', 'restore'], true))) {
            return;
        }

        $userId = (int) ($_SESSION['user_id'] ?? 0);
        $userType = (string) ($_SESSION['user_type'] ?? '');
        if ($userId <= 0 || !in_array($userType, ['student', 'employee'], true)) return;

        $action = strtoupper(preg_replace('/[^a-z0-9]+/i', '_', implode('_', [$area, $resource, $operation])));
        $action = substr($action, 0, 100);
        $details = ucwords(str_replace('-', ' ', $area)) . ' / '
            . ucwords(str_replace('-', ' ', $resource)) . ': '
            . ucwords(str_replace('_', ' ', $operation));

        $identifiers = [
            'student_id' => 'Student', 'employee_id' => 'Employee', 'loan_id' => 'Loan',
            'studentId' => 'Student', 'employeeId' => 'Employee', 'loanId' => 'Loan',
            'application_no' => 'Application', 'applicationNo' => 'Application',
            'balance_id' => 'Balance', 'balanceId' => 'Balance',
            'doc_type_id' => 'Document type', 'program_id' => 'Program',
            'campus_id' => 'Campus', 'scholarship_id' => 'Scholarship', 'sy_id' => 'School year',
            'year_level_id' => 'Year level', 'modality_id' => 'Modality', 'app_period_id' => 'Period',
        ];
        foreach ($identifiers as $key => $label) {
            $value = $input[$key] ?? $response[$key] ?? null;
            if (is_scalar($value) && preg_match('/^[a-zA-Z0-9_\/-]{1,64}$/', (string) $value)) {
                $details .= ' | ' . $label . ' #' . $value;
            }
        }
        $decision = strtolower((string) ($input['processType'] ?? $input['status'] ?? ''));
        if (in_array($decision, ['approve', 'approved', 'decline', 'declined', 'return', 'returned', 'endorse', 'endorsed', 'cancel', 'cancelled', 'complete', 'completed'], true)) {
            $details .= ' | Decision: ' . ucfirst($decision);
        }
        $records = 1;
        foreach (['deleted_count', 'imported_count', 'updated_count', 'count', 'updated', 'deleted', 'imported'] as $key) {
            if (isset($response[$key]) && is_numeric($response[$key])) {
                $records = max(1, min(100000, (int) $response[$key]));
                break;
            }
        }
        if ($records === 1) {
            foreach (['loanIds', 'loan_ids', 'student_ids', 'employee_ids', 'balance_ids', 'ids'] as $key) {
                if (isset($input[$key]) && is_array($input[$key])) {
                    $records = max(1, min(100000, count($input[$key])));
                    break;
                }
            }
        }

        try {
            self::log(
                self::$trackingPdo,
                $action,
                substr($details, 0, 512),
                $userType === 'student' ? $userId : null,
                $userType === 'employee' ? $userId : null,
                $records
            );
        } catch (Throwable $e) {
            error_log('Automatic audit log error: ' . $e->getMessage());
        }
    }
}


