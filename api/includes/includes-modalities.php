<?php

function modalityIdForCode(PDO $pdo, string $code): int {
    $stmt = $pdo->prepare('SELECT modality_id FROM tbl_csdl_modalities WHERE modality_code = ? AND modality_status = 1 LIMIT 1');
    $stmt->execute([strtolower(trim($code))]);
    return (int)($stmt->fetchColumn() ?: 0);
}
