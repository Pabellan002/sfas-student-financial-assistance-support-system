<?php

function studentFamilyFullName(array $member): string {
    return trim((string)($member['name'] ?? ''));
}

function studentFamilyValidatedFullName($raw): string {
    $name = trim((string)$raw);
    $name = preg_replace('/\s+/u', ' ', $name);
    $words = preg_split('/\s+/u', $name) ?: [];
    if (mb_strlen($name) > 200 || count($words) < 2
        || count(array_filter($words, static fn($word) => preg_match('/\p{L}/u', $word) === 1)) !== count($words)
        || preg_match_all('/\p{L}/u', $name) < 4
        || !preg_match('/^[\p{L}\p{M} .,\x{2019}\x{0027}-]+$/u', $name)) {
        throw new InvalidArgumentException('Family member full name must include at least two words and contain letters only.');
    }
    return $name;
}

function studentFamilyParse($raw): array {
    if (is_string($raw)) {
        $raw = json_decode($raw, true);
    }
    if (!is_array($raw) || count($raw) > 30) {
        throw new InvalidArgumentException('Invalid family details.');
    }
    $allowed = [1, 2, 3];
    $seenFixed = [];
    $members = [];
    foreach ($raw as $item) {
        if (!is_array($item)) {
            throw new InvalidArgumentException('Invalid family member.');
        }
        $relationship = (int)($item['relationship_id'] ?? 0);
        $name = studentFamilyFullName($item);
        $contact = trim((string)($item['contact'] ?? ''));
        if (!in_array($relationship, $allowed, true)) {
            throw new InvalidArgumentException('Invalid family relationship.');
        }
        if ($name === '' && $contact === '') {
            continue;
        }
        $name = studentFamilyValidatedFullName($name);
        $normalized = InputValidation::parsePhilippineMobile($contact);
        if ($normalized === false || !preg_match('/^09\d{9}$/', $normalized)) {
            throw new InvalidArgumentException('Each family member needs a valid 9XXXXXXXXX or 09XXXXXXXXX contact number.');
        }
        if (isset($seenFixed[$relationship])) {
            throw new InvalidArgumentException('Only one father, mother, or guardian entry is allowed.');
        }
        $seenFixed[$relationship] = true;
        $members[] = [
            'id' => (int)($item['id'] ?? 0),
            'relationship_id' => $relationship,
            'name' => $name,
            'contact' => $normalized,
        ];
    }
    return $members;
}

function studentFamilyFetch(PDO $pdo, int $studentId): array {
    $stmt = $pdo->prepare('SELECT guardian_id AS id, guardian_relationship_id AS relationship_id, guardian_name AS name, guardian_contact AS contact FROM tbl_csdl_guardians WHERE guardian_student_id = ? AND guardian_status = 1 AND guardian_relationship_id IN (1, 2, 3) ORDER BY guardian_relationship_id, guardian_id');
    $stmt->execute([$studentId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function studentFamilyAttach(PDO $pdo, array &$rows): void {
    $ids = array_values(array_unique(array_filter(array_map(static fn($row) => (int)($row['id'] ?? 0), $rows))));
    $byStudent = [];
    foreach (array_chunk($ids, 500) as $batch) {
        $placeholders = implode(',', array_fill(0, count($batch), '?'));
        $stmt = $pdo->prepare("SELECT guardian_student_id, guardian_id AS id, guardian_relationship_id AS relationship_id, guardian_name AS name, guardian_contact AS contact FROM tbl_csdl_guardians WHERE guardian_student_id IN ($placeholders) AND guardian_status = 1 AND guardian_relationship_id IN (1, 2, 3) ORDER BY guardian_relationship_id, guardian_id");
        $stmt->execute($batch);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $member) {
            $byStudent[(int)$member['guardian_student_id']][] = $member;
        }
    }
    foreach ($rows as &$row) {
        $row['family_details'] = $byStudent[(int)($row['id'] ?? 0)] ?? [];
    }
    unset($row);
}

function studentFamilySync(PDO $pdo, int $studentId, array $members): void {
    $existing = studentFamilyFetch($pdo, $studentId);
    $existingById = [];
    foreach ($existing as $row) {
        $existingById[(int)$row['id']] = $row;
    }
    $kept = [];
    $update = $pdo->prepare('UPDATE tbl_csdl_guardians SET guardian_name = ?, guardian_contact = ?, guardian_relationship_id = ?, guardian_status = 1 WHERE guardian_id = ? AND guardian_student_id = ?');
    $insert = $pdo->prepare('INSERT INTO tbl_csdl_guardians (guardian_student_id, guardian_name, guardian_contact, guardian_relationship_id, guardian_is_primary, guardian_status) VALUES (?, ?, ?, ?, 1, 1)');
    foreach ($members as $member) {
        $id = (int)$member['id'];
        if ($id > 0) {
            if (!isset($existingById[$id]) || (int)$existingById[$id]['relationship_id'] !== $member['relationship_id'] || isset($kept[$id])) {
                throw new InvalidArgumentException('Invalid family member selection.');
            }
            $update->execute([$member['name'], $member['contact'], $member['relationship_id'], $id, $studentId]);
            $kept[$id] = true;
        } else {
            $insert->execute([$studentId, $member['name'], $member['contact'], $member['relationship_id']]);
        }
    }
    $deactivate = $pdo->prepare('UPDATE tbl_csdl_guardians SET guardian_status = 0 WHERE guardian_id = ? AND guardian_student_id = ?');
    foreach ($existingById as $id => $_) {
        if (!isset($kept[$id])) {
            $deactivate->execute([$id, $studentId]);
        }
    }
}
