<?php

function getRecordedPartialPaymentTotal(PDO $pdo, int $loanId): float
{
    $stmt = $pdo->prepare("SELECT COALESCE(SUM(approval_amount_approved), 0)
                           FROM tbl_csdl_loan_approvals
                           WHERE approval_loan_id = ?
                             AND approval_step_id = 11
                             AND approval_amount_approved IS NOT NULL
                             AND approval_amount_approved > 0");
    $stmt->execute([$loanId]);
    $sum = (float) $stmt->fetchColumn();
    if ($sum > 0) {
        return $sum;
    }

    $trackStmt = $pdo->prepare("SELECT loan_tracking_remarks
                                FROM tbl_csdl_loan_tracking
                                WHERE loan_tracking_loan_id = ?
                                  AND loan_tracking_action = 'Partial Payment Recorded'");
    $trackStmt->execute([$loanId]);
    $total = 0.0;
    while ($row = $trackStmt->fetch(PDO::FETCH_ASSOC)) {
        $remarks = (string) ($row['loan_tracking_remarks'] ?? '');
        if (preg_match('/Partial payment of ₱([\d,]+\.\d{2})/', $remarks, $matches)) {
            $total += (float) str_replace(',', '', $matches[1]);
        }
    }
    return max(0, $total);
}

function getLoanPaymentTotalForRouting(PDO $pdo, int $loanId, float $remainingAmountCanPay): float
{
    $partialTotal = getRecordedPartialPaymentTotal($pdo, $loanId);
    $remaining = max(0, $remainingAmountCanPay);
    if ($partialTotal > 0) {
        return $partialTotal + $remaining;
    }
    return $remaining;
}

function getLoanPromisedDisplayAmount(PDO $pdo, int $loanId, float $remainingAmountCanPay): array
{
    $partialTotal = getRecordedPartialPaymentTotal($pdo, $loanId);
    $remaining = max(0, $remainingAmountCanPay);
    $promised = $remaining + $partialTotal;
    if ($promised <= 0) {
        $promised = $remaining > 0 ? $remaining : $partialTotal;
    }

    return [
        'promisedAmount' => $promised,
        'remainingAmount' => $remaining,
        'partialPaymentTotal' => $partialTotal,
    ];
}

function resolveLoanApprovedAmount(PDO $pdo, int $loanId, float $postedAmount, float $remainingAmountCanPay): float
{
    if ($postedAmount > 0) {
        return $postedAmount;
    }
    $amounts = getLoanPromisedDisplayAmount($pdo, $loanId, $remainingAmountCanPay);
    return (float) ($amounts['promisedAmount'] ?? 0);
}

function attachLoanPromisedAmountFields(PDO $pdo, int $loanId, array &$loan): void
{
    $amounts = getLoanPromisedDisplayAmount($pdo, $loanId, (float) ($loan['loan_amount_can_pay'] ?? 0));
    $loan['loan_amount_remaining'] = $amounts['remainingAmount'];
    $loan['loan_partial_payment_total'] = $amounts['partialPaymentTotal'];
    $loan['loan_promised_amount'] = $amounts['promisedAmount'];
}
