<?php

/** The final approving office owns PN tagging; balance changes never change it. */
function loanPnTaggingOfficeSql(string $alias = 'l'): string
{
    if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/D', $alias)) {
        throw new InvalidArgumentException('Invalid loan alias.');
    }
    return "CASE WHEN COALESCE((
        SELECT pa.approval_role_id FROM tbl_csdl_loan_approvals pa
        WHERE pa.approval_loan_id = {$alias}.loan_id
          AND pa.approval_status_id = 2
          AND ((pa.approval_role_id = 100 AND pa.approval_step_id = 1)
            OR (pa.approval_role_id = 101 AND pa.approval_step_id IN (2, 11))
            OR (pa.approval_role_id = 98 AND pa.approval_step_id = 3)
            OR (pa.approval_role_id = 97 AND pa.approval_step_id = 4))
        ORDER BY pa.approval_date_processed DESC, pa.approval_id DESC LIMIT 1
    ), 0) = 100 THEN 'csdl' ELSE 'assessment' END";
}

function loanPnTaggingOfficeSettings(string $office): array
{
    return match ($office) {
        'csdl' => ['office' => 'csdl', 'name' => 'CSDL', 'step' => 1, 'role' => 100],
        'assessment' => ['office' => 'assessment', 'name' => 'Assessment', 'step' => 11, 'role' => 101],
        default => throw new InvalidArgumentException('Invalid PN tagging office.'),
    };
}

function resolveLoanPnTaggingOffice(PDO $pdo, int $loanId): array
{
    $stmt = $pdo->prepare('SELECT ' . loanPnTaggingOfficeSql() . ' FROM tbl_csdl_loans l WHERE l.loan_id = ?');
    $stmt->execute([$loanId]);
    $office = $stmt->fetchColumn();
    if ($office === false) throw new RuntimeException('Loan application not found.');
    return loanPnTaggingOfficeSettings((string) $office);
}
