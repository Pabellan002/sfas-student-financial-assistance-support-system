<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../config/connection-pdo.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

$schoolId = trim($_GET['school_id'] ?? '');
if ($schoolId === '' || !InputValidation::validateSchoolId($schoolId)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid School ID']);
    exit;
}

try {
    $stmt = $pdo->prepare("SELECT student_id FROM tbl_csdl_students WHERE student_school_id = ? LIMIT 1");
    $stmt->execute([$schoolId]);
    $student = $stmt->fetch();

    if (!$student) {
        echo json_encode(['success' => false, 'message' => 'No application found']);
        exit;
    }

    $loanStmt = $pdo->prepare(" 
        SELECT 
            l.loan_id,
            l.loan_application_no,
            l.loan_amount_can_pay,
            b.balance_total_balance,
            l.loan_status_id,
            s.loan_status_name,
            l.loan_application_date,
            l.loan_updated_at
        FROM tbl_csdl_loans l
        LEFT JOIN tbl_csdl_loan_statuses s ON s.loan_status_id = l.loan_status_id
        LEFT JOIN tbl_csdl_balances b ON b.balance_id = l.loan_balance_id
        WHERE l.loan_student_id = ?
        ORDER BY l.loan_id DESC
        LIMIT 1
    ");
    $loanStmt->execute([$student['student_id']]);
    $loan = $loanStmt->fetch();

    if (!$loan) {
        echo json_encode(['success' => false, 'message' => 'No application found']);
        exit;
    }

    echo json_encode([
        'success' => true,
        'status' => $loan['loan_status_name'] ?? 'Pending',
        'application_no' => $loan['loan_application_no'] ?? null,
        'balance' => $loan['balance_total_balance'] !== null ? number_format((float)$loan['balance_total_balance'], 2, '.', ',') : null,
        'amount' => $loan['loan_amount_can_pay'] !== null ? number_format((float)$loan['loan_amount_can_pay'], 2, '.', ',') : null,
        'application_date' => $loan['loan_application_date'] ?? null,
        'updated_at' => $loan['loan_updated_at'] ?? null
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unable to fetch status']);
}
?>


