<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';
require_once __DIR__ . '/../includes/includes-rbac.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (!isset($_SESSION['user_id'], $_SESSION['user_type'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

$actorId = (int) $_SESSION['user_id'];
$actorType = (string) $_SESSION['user_type'];
$actorRoleId = (int) ($_SESSION['user_role_id'] ?? 0);
$isStudent = $actorType === 'student';
$staffRoleConfig = [
    100 => ['senderType' => 'csdl', 'permission' => 'csdl.loans.chat', 'label' => 'CSDL Office'],
    101 => ['senderType' => 'assessment', 'permission' => 'assessment.loans.chat', 'label' => 'Assessment Office'],
    97 => ['senderType' => 'coo', 'permission' => 'coo.loans.chat', 'label' => 'COO Office'],
    98 => ['senderType' => 'branch_admin', 'permission' => 'branch_admin.loans.chat', 'label' => 'Branch Admin Office'],
];
$staffConfig = $actorType === 'employee' ? ($staffRoleConfig[$actorRoleId] ?? null) : null;
$isStaff = is_array($staffConfig);
if (!$isStudent && !$isStaff) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Loan chat is not available for this account.']);
    exit;
}
if ($isStaff) {
    RBAC::init($pdo);
    RBAC::requirePermission($actorId, $staffConfig['permission'], 'You do not have permission to use loan chat.');
}

$actorCampusId = 0;
if ($isStaff && $actorRoleId === 98) {
    $campusStmt = $pdo->prepare('SELECT employee_campus_id FROM tbl_csdl_employees WHERE employee_id = ? AND employee_status = 1');
    $campusStmt->execute([$actorId]);
    $actorCampusId = (int) ($campusStmt->fetchColumn() ?: 0);
    if ($actorCampusId <= 0) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'No active campus is assigned to your account.']);
        exit;
    }
}

function loanChatSenderLabel(string $senderType): string
{
    return match ($senderType) {
        'csdl' => 'CSDL Office',
        'assessment' => 'Assessment Office',
        'coo' => 'COO Office',
        'branch_admin' => 'Branch Admin Office',
        default => 'Student',
    };
}

function ensureLoanChatSchema(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS tbl_csdl_loan_chat_messages (
        chat_message_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chat_message_loan_id INT NOT NULL,
        chat_message_sender_type VARCHAR(20) NOT NULL,
        chat_message_sender_student_id INT NULL,
        chat_message_sender_employee_id INT NULL,
        chat_message_office_type VARCHAR(20) NOT NULL,
        chat_message_body TEXT NOT NULL,
        chat_message_created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        chat_message_read_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (chat_message_id),
        KEY idx_loan_chat_loan_message (chat_message_loan_id, chat_message_id),
        KEY idx_loan_chat_unread (chat_message_loan_id, chat_message_sender_type, chat_message_read_at),
        KEY idx_loan_chat_office_message (chat_message_loan_id, chat_message_office_type, chat_message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS tbl_csdl_loan_chat_typing (
        chat_typing_loan_id INT NOT NULL,
        chat_typing_actor_type VARCHAR(20) NOT NULL,
        chat_typing_actor_id INT NOT NULL,
        chat_typing_office_type VARCHAR(20) NOT NULL,
        chat_typing_expires_at DATETIME NOT NULL,
        PRIMARY KEY (chat_typing_loan_id, chat_typing_actor_type, chat_typing_actor_id),
        KEY idx_loan_chat_typing_expiry (chat_typing_loan_id, chat_typing_actor_type, chat_typing_expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci");

    $messageType = $pdo->query("SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_csdl_loan_chat_messages' AND COLUMN_NAME = 'chat_message_sender_type'")->fetchColumn();
    if (strtolower((string) $messageType) === 'enum') {
        $pdo->exec("ALTER TABLE tbl_csdl_loan_chat_messages MODIFY chat_message_sender_type VARCHAR(20) NOT NULL");
    }
    $typingType = $pdo->query("SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_csdl_loan_chat_typing' AND COLUMN_NAME = 'chat_typing_actor_type'")->fetchColumn();
    if (strtolower((string) $typingType) === 'enum') {
        $pdo->exec("ALTER TABLE tbl_csdl_loan_chat_typing MODIFY chat_typing_actor_type VARCHAR(20) NOT NULL");
    }
}

function getAccessibleChatLoan(PDO $pdo, int $loanId, bool $isStudent, int $actorId, ?array $staffConfig, int $actorCampusId, string $officeType): array
{
    $sql = "SELECT l.loan_id, l.loan_student_id, l.loan_application_no, l.loan_status_id,
                   l.loan_current_step_id, CONCAT_WS(' ', s.student_first_name, s.student_middle_name, s.student_last_name) AS student_name,
                   s.student_campus_id, ls.loan_status_name
            FROM tbl_csdl_loans l
            JOIN tbl_csdl_students s ON s.student_id = l.loan_student_id
            LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
            WHERE l.loan_id = ?" . ($isStudent
                ? " AND l.loan_student_id = ?
                    AND EXISTS (
                        SELECT 1
                        FROM tbl_csdl_loan_chat_messages initiated_message
                        WHERE initiated_message.chat_message_loan_id = l.loan_id
                          AND initiated_message.chat_message_sender_type <> 'student'
                          AND initiated_message.chat_message_office_type = ?
                    )"
                : (($staffConfig['senderType'] ?? '') === 'branch_admin' ? ' AND s.student_campus_id = ?' : '')) . " LIMIT 1";
    $stmt = $pdo->prepare($sql);
    $params = [$loanId];
    if ($isStudent) {
        $params[] = $actorId;
        $params[] = $officeType;
    }
    elseif (($staffConfig['senderType'] ?? '') === 'branch_admin') $params[] = $actorCampusId;
    $stmt->execute($params);
    $loan = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$loan) {
        throw new RuntimeException('Loan conversation not found.');
    }
    return $loan;
}

function parseChatPostBody(): array
{
    $raw = file_get_contents('php://input');
    $json = json_decode($raw, true);
    if (is_array($json)) {
        $_POST = array_merge($_POST, $json);
    }
    return $_POST;
}

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET' && ($_GET['action'] ?? '') === 'unread_count') {
        if (!$isStudent) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Student chat count is unavailable for this account.']);
            exit;
        }
        try {
            $stmt = $pdo->prepare("SELECT COUNT(*)
                FROM tbl_csdl_loan_chat_messages m
                JOIN tbl_csdl_loans l ON l.loan_id = m.chat_message_loan_id
                WHERE l.loan_student_id = ?
                  AND m.chat_message_sender_type <> 'student'
                  AND m.chat_message_read_at IS NULL");
            $stmt->execute([$actorId]);
            $unreadCount = (int) $stmt->fetchColumn();
        } catch (PDOException $e) {
            if ($e->getCode() !== '42S02' && (int) ($e->errorInfo[1] ?? 0) !== 1146) {
                throw $e;
            }
            $unreadCount = 0;
        }
        echo json_encode(['success' => true, 'unreadCount' => $unreadCount]);
        exit;
    }

    ensureLoanChatSchema($pdo);

    if ($method === 'GET') {
        $action = $_GET['action'] ?? 'conversations';
        if ($action === 'conversations') {
            if (!$isStudent) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Select a loan from Active Loans to start a chat.']);
                exit;
            }
            $stmt = $pdo->prepare("SELECT l.loan_id, l.loan_application_no, l.loan_status_id, ls.loan_status_name,
                    offices.chat_message_office_type AS office_type,
                    (SELECT m.chat_message_body FROM tbl_csdl_loan_chat_messages m WHERE m.chat_message_loan_id = l.loan_id AND m.chat_message_office_type = offices.chat_message_office_type ORDER BY m.chat_message_id DESC LIMIT 1) AS last_message,
                    (SELECT m.chat_message_created_at FROM tbl_csdl_loan_chat_messages m WHERE m.chat_message_loan_id = l.loan_id AND m.chat_message_office_type = offices.chat_message_office_type ORDER BY m.chat_message_id DESC LIMIT 1) AS last_message_at,
                    (SELECT COUNT(*) FROM tbl_csdl_loan_chat_messages m WHERE m.chat_message_loan_id = l.loan_id AND m.chat_message_office_type = offices.chat_message_office_type AND m.chat_message_sender_type <> 'student' AND m.chat_message_read_at IS NULL) AS unread_count
                FROM tbl_csdl_loans l
                LEFT JOIN tbl_csdl_loan_statuses ls ON ls.loan_status_id = l.loan_status_id
                JOIN (SELECT chat_message_loan_id, chat_message_office_type
                      FROM tbl_csdl_loan_chat_messages
                      WHERE chat_message_sender_type <> 'student'
                      GROUP BY chat_message_loan_id, chat_message_office_type) offices ON offices.chat_message_loan_id = l.loan_id
                WHERE l.loan_student_id = ?
                ORDER BY COALESCE(last_message_at, l.loan_application_date) DESC, l.loan_id DESC");
            $stmt->execute([$actorId]);
            $conversations = $stmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($conversations as &$conversation) {
                $conversation['office_name'] = loanChatSenderLabel((string) ($conversation['office_type'] ?? ''));
            }
            unset($conversation);
            echo json_encode(['success' => true, 'conversations' => $conversations]);
            exit;
        }

        if ($action === 'messages') {
            $loanId = (int) ($_GET['loanId'] ?? 0);
            $afterId = max(0, (int) ($_GET['afterId'] ?? 0));
            $officeType = $isStudent ? (string) ($_GET['officeType'] ?? '') : (string) $staffConfig['senderType'];
            if (!in_array($officeType, array_column($staffRoleConfig, 'senderType'), true)) {
                throw new RuntimeException('Loan office not found.');
            }
            $loan = getAccessibleChatLoan($pdo, $loanId, $isStudent, $actorId, $staffConfig, $actorCampusId, $officeType);
            $stmt = $pdo->prepare("SELECT chat_message_id AS id, chat_message_sender_type AS sender_type,
                    chat_message_sender_student_id AS sender_student_id, chat_message_sender_employee_id AS sender_employee_id,
                    chat_message_body AS body, chat_message_created_at AS created_at
                FROM tbl_csdl_loan_chat_messages
                WHERE chat_message_loan_id = ? AND chat_message_office_type = ? AND chat_message_id > ?
                ORDER BY chat_message_id ASC LIMIT 250");
            $stmt->execute([$loanId, $officeType, $afterId]);
            $messages = $stmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($messages as &$message) {
                $message['is_mine'] = $isStudent
                    ? $message['sender_type'] === 'student'
                    : ($message['sender_type'] !== 'student' && (int) ($message['sender_employee_id'] ?? 0) === $actorId);
                $message['sender_label'] = loanChatSenderLabel((string) $message['sender_type']);
            }
            unset($message);
            $typingSql = $isStudent
                ? "SELECT chat_typing_actor_type FROM tbl_csdl_loan_chat_typing WHERE chat_typing_loan_id = ? AND chat_typing_office_type = ? AND chat_typing_actor_type <> 'student' AND chat_typing_expires_at > NOW() ORDER BY chat_typing_expires_at DESC LIMIT 1"
                : "SELECT chat_typing_actor_type FROM tbl_csdl_loan_chat_typing WHERE chat_typing_loan_id = ? AND chat_typing_office_type = ? AND chat_typing_actor_type = 'student' AND chat_typing_expires_at > NOW() ORDER BY chat_typing_expires_at DESC LIMIT 1";
            $typingStmt = $pdo->prepare($typingSql);
            $typingStmt->execute([$loanId, $officeType]);
            $typingActorType = $typingStmt->fetchColumn();
            echo json_encode([
                'success' => true,
                'loan' => $loan,
                'office_type' => $officeType,
                'messages' => $messages,
                'other_is_typing' => $typingActorType !== false,
                'other_typing_label' => $typingActorType !== false ? loanChatSenderLabel((string) $typingActorType) : ''
            ]);
            exit;
        }

        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid chat action.']);
        exit;
    }

    if ($method === 'POST') {
        $input = parseChatPostBody();
        CSRFProtection::validateRequest();
        $action = $input['action'] ?? '';
        $loanId = (int) ($input['loanId'] ?? 0);
        $officeType = $isStudent ? (string) ($input['officeType'] ?? '') : (string) $staffConfig['senderType'];
        if (!in_array($officeType, array_column($staffRoleConfig, 'senderType'), true)) {
            throw new RuntimeException('Loan office not found.');
        }
        $loan = getAccessibleChatLoan($pdo, $loanId, $isStudent, $actorId, $staffConfig, $actorCampusId, $officeType);

        if ($action === 'send') {
            $message = trim((string) ($input['message'] ?? ''));
            if ($message === '' || mb_strlen($message) > 2000) {
                http_response_code(422);
                echo json_encode(['success' => false, 'message' => 'Enter a message up to 2,000 characters.']);
                exit;
            }
            $senderType = $isStudent ? 'student' : (string) $staffConfig['senderType'];
            $stmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_chat_messages
                (chat_message_loan_id, chat_message_sender_type, chat_message_sender_student_id, chat_message_sender_employee_id, chat_message_office_type, chat_message_body)
                VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([$loanId, $senderType, $isStudent ? $actorId : null, $isStaff ? $actorId : null, $officeType, $message]);
            $messageId = (int) $pdo->lastInsertId();
            $pdo->prepare('DELETE FROM tbl_csdl_loan_chat_typing WHERE chat_typing_loan_id = ? AND chat_typing_office_type = ? AND chat_typing_actor_type = ? AND chat_typing_actor_id = ?')
                ->execute([$loanId, $officeType, $senderType, $actorId]);

            try {
                if ($isStudent) {
                    $recipientConfig = null;
                    $recipientRoleId = 0;
                    foreach ($staffRoleConfig as $roleId => $config) {
                        if ($config['senderType'] === $officeType) {
                            $recipientConfig = $config;
                            $recipientRoleId = (int) $roleId;
                            break;
                        }
                    }
                    if (!$recipientConfig) {
                        throw new RuntimeException('The receiving loan office is unavailable.');
                    }

                    $staffSql = "SELECT e.employee_id
                        FROM tbl_csdl_employees e
                        JOIN tbl_csdl_permissions p ON p.permission_key = ?
                        LEFT JOIN tbl_csdl_role_permissions rp
                            ON rp.role_id = e.employee_role_id AND rp.permission_id = p.permission_id
                        LEFT JOIN tbl_csdl_employee_permissions ep
                            ON ep.employee_id = e.employee_id AND ep.permission_id = p.permission_id
                        WHERE e.employee_role_id = ?
                          AND e.employee_status = 1
                          AND CASE
                              WHEN ep.employee_permission_id IS NOT NULL THEN ep.is_granted
                              WHEN rp.role_permission_id IS NOT NULL THEN 1
                              ELSE 0
                          END = 1";
                    $staffParams = [$recipientConfig['permission'], $recipientRoleId];
                    if ($officeType === 'branch_admin') {
                        $staffSql .= ' AND e.employee_campus_id = ?';
                        $staffParams[] = (int) $loan['student_campus_id'];
                    }
                    $staffStmt = $pdo->prepare($staffSql);
                    $staffStmt->execute($staffParams);
                    $notify = $pdo->prepare("INSERT INTO tbl_csdl_notifications (notification_employee_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, 'New Student Chat Message', ?, NOW())");
                    foreach ($staffStmt->fetchAll(PDO::FETCH_COLUMN) as $employeeId) {
                        $notify->execute([(int) $employeeId, (int) ($loan['loan_current_step_id'] ?: 11), $loanId, "Student replied about loan {$loan['loan_application_no']}."]);
                    }
                } else {
                    $officeLabel = (string) $staffConfig['label'];
                    $notifyTitle = "New {$officeLabel} Chat Message";
                    $notify = $pdo->prepare("INSERT INTO tbl_csdl_notifications (notification_student_id, notification_workflow_step_id, notification_loan_id, notification_title, notification_message, notification_sent_at) VALUES (?, ?, ?, ?, ?, NOW())");
                    $notify->execute([(int) $loan['loan_student_id'], (int) ($loan['loan_current_step_id'] ?: 11), $loanId, $notifyTitle, "{$officeLabel} sent a message about loan {$loan['loan_application_no']}."]);
                }
            } catch (Throwable $notificationError) {
                error_log('Loan chat notification error: ' . $notificationError->getMessage());
            }
            echo json_encode(['success' => true, 'messageId' => $messageId]);
            exit;
        }

        if ($action === 'typing') {
            $senderType = $isStudent ? 'student' : (string) $staffConfig['senderType'];
            $isTyping = filter_var($input['isTyping'] ?? false, FILTER_VALIDATE_BOOLEAN);
            if ($isTyping) {
                $stmt = $pdo->prepare("INSERT INTO tbl_csdl_loan_chat_typing
                        (chat_typing_loan_id, chat_typing_actor_type, chat_typing_actor_id, chat_typing_office_type, chat_typing_expires_at)
                    VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 4 SECOND))
                    ON DUPLICATE KEY UPDATE chat_typing_office_type = VALUES(chat_typing_office_type), chat_typing_expires_at = VALUES(chat_typing_expires_at)");
                $stmt->execute([$loanId, $senderType, $actorId, $officeType]);
            } else {
                $stmt = $pdo->prepare('DELETE FROM tbl_csdl_loan_chat_typing WHERE chat_typing_loan_id = ? AND chat_typing_office_type = ? AND chat_typing_actor_type = ? AND chat_typing_actor_id = ?');
                $stmt->execute([$loanId, $officeType, $senderType, $actorId]);
            }
            echo json_encode(['success' => true]);
            exit;
        }

        if ($action === 'mark_read') {
            $condition = $isStudent ? "chat_message_sender_type <> 'student'" : "chat_message_sender_type = 'student'";
            $stmt = $pdo->prepare("UPDATE tbl_csdl_loan_chat_messages SET chat_message_read_at = COALESCE(chat_message_read_at, NOW()) WHERE chat_message_loan_id = ? AND chat_message_office_type = ? AND {$condition}");
            $stmt->execute([$loanId, $officeType]);
            echo json_encode(['success' => true]);
            exit;
        }

        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid chat action.']);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
} catch (RuntimeException $e) {
    http_response_code(404);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('Loan chat error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unable to load the loan chat right now.']);
}
