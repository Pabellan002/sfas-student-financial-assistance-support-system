<?php

function guardianIdNameTokens(string $name): array
{
    $name = mb_strtolower(trim($name), 'UTF-8');
    $name = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $name) ?? '';
    $tokens = array_values(array_filter(preg_split('/\s+/u', trim($name)) ?: []));
    $suffixes = ['jr', 'sr', 'ii', 'iii', 'iv'];
    return array_values(array_filter($tokens, static fn(string $token): bool => !in_array($token, $suffixes, true)));
}

/** Reject a guardian entry that resolves to the logged-in student's own name. */
function guardianIdNameMatchesStudent(string $guardianName, string $firstName, string $middleName, string $lastName): bool
{
    $guardianTokens = guardianIdNameTokens($guardianName);
    $studentFullTokens = guardianIdNameTokens(trim("{$firstName} {$middleName} {$lastName}"));
    $studentShortTokens = guardianIdNameTokens(trim("{$firstName} {$lastName}"));
    if ($guardianTokens === [] || $studentShortTokens === []) return false;

    sort($guardianTokens);
    sort($studentFullTokens);
    sort($studentShortTokens);
    return $guardianTokens === $studentFullTokens || $guardianTokens === $studentShortTokens;
}

/** Visual screening is not issuer authentication or biometric identity verification. */
function guardianIdScreeningResult(array $result): array
{
    $bool = static fn(string $key) => is_bool($result[$key] ?? null) ? $result[$key] : null;
    $enum = static fn(string $key, array $values, string $fallback) =>
        in_array($result[$key] ?? null, $values, true) ? $result[$key] : $fallback;
    $screening = [
        'checked' => true,
        'decision' => 'needs_review',
        'document_side' => $enum('document_side', ['front', 'back', 'both', 'unclear'], 'unclear'),
        'front_required' => false,
        'name_matches' => $bool('name_matches'),
        'holder_matches_student' => $bool('holder_matches_student'),
        'document_type_matches' => $bool('document_type_matches'),
        'image_quality' => $enum('image_quality', ['clear', 'unclear', 'unreadable'], 'unclear'),
        'signature_visible' => $enum('signature_visible', ['yes', 'no', 'unclear'], 'unclear'),
        'portrait_visible' => $enum('portrait_visible', ['yes', 'no', 'unclear'], 'unclear'),
        'portrait_quality' => $enum('portrait_quality', ['clear', 'unclear', 'placeholder'], 'unclear'),
        'template_or_sample' => $enum('template_or_sample', ['yes', 'no', 'unclear'], 'unclear'),
        'tampering_signs' => $enum('tampering_signs', ['yes', 'no', 'unclear'], 'unclear'),
        // Never accept a model's claim that it verified an issuer signature or a face identity.
        'issuer_verified' => false,
        'reason' => '',
        'warnings' => [],
    ];

    // A back-only photo is the wrong side, not evidence of a template or a fake portrait.
    if ($screening['document_side'] === 'back') {
        $screening['front_required'] = true;
        $screening['reason'] = 'This appears to be the back of your ID. Please upload the front side showing the guardian photo and full name. The back alone cannot complete verification.';
    } elseif ($screening['template_or_sample'] === 'yes' || $screening['portrait_quality'] === 'placeholder') {
        $screening['decision'] = 'invalid';
        $screening['reason'] = 'The image appears to be a sample or template, or contains a placeholder portrait. Upload the complete issued ID, not a sample or generated replacement.';
    } elseif ($screening['document_side'] === 'unclear') {
        $screening['front_required'] = true;
        $screening['reason'] = 'The check could not determine which side of the ID is shown. Please upload a clear, complete front-side photo showing the guardian portrait and full name.';
    } elseif ($screening['holder_matches_student'] === true) {
        $screening['decision'] = 'invalid';
        $screening['reason'] = 'The uploaded ID appears to belong to the student. Upload a valid ID belonging to the named parent or guardian.';
    } elseif ($screening['holder_matches_student'] !== false) {
        $screening['reason'] = 'The check could not confirm that this ID belongs to someone other than the student. Upload a clearer parent or guardian ID.';
    } elseif ($screening['name_matches'] === false || $screening['document_type_matches'] === false) {
        $screening['decision'] = 'invalid';
        $screening['reason'] = 'The visible guardian name or document type does not match your selection.';
    } elseif ($screening['tampering_signs'] !== 'no') {
        $screening['reason'] = 'The image has possible editing or generation artifacts, or its integrity is unclear. Please present the original document to CSDL for review.';
    } elseif ($screening['portrait_visible'] !== 'yes' || $screening['portrait_quality'] !== 'clear') {
        $screening['reason'] = 'A clear ID-holder portrait is required. Upload a clearer complete document or contact CSDL for review. This checks portrait visibility, not the identity of the person.';
    } elseif ($screening['image_quality'] !== 'clear') {
        $screening['reason'] = 'The ID image is not clear enough to read. Please retake the photo with the full ID in focus and without glare covering the details.';
    } elseif ($screening['name_matches'] !== true) {
        $screening['reason'] = 'The guardian name could not be read confidently. Check the entered name and upload a clearer photo of the printed name fields.';
    } elseif ($screening['document_type_matches'] !== true) {
        $screening['reason'] = 'The selected document type could not be confirmed. Check your selection and include the ID heading in the photo.';
    } elseif ($screening['template_or_sample'] !== 'no') {
        $screening['reason'] = 'The check could not rule out a sample or template. Upload a clear photo of the complete issued document or contact CSDL for review.';
    } elseif (($result['decision'] ?? '') === 'visual_checks_passed') {
        $screening['decision'] = 'visual_checks_passed';
        $screening['reason'] = 'Visual checks passed. This does not authenticate the ID or prove that the portrait is genuine. Staff must still inspect the document.';
    } else {
        $screening['reason'] = 'The automated check could not confidently clear the document. Please contact CSDL for review.';
    }
    // Portrait screening must not reject a document solely because its face lacks a signature.
    if ($screening['signature_visible'] !== 'yes') {
        $screening['warnings'][] = 'Signature visibility was not confirmed by AI. This does not block portrait verification; any separate signed-copy requirement still applies.';
    }
    return $screening;
}

/** Bind the scan to the exact bytes and form details; never trust a browser pass flag. */
function guardianIdScreeningReceipt(string $filePath, int $studentId, string $guardianName, int $documentTypeId, array $screening, ?int $now = null): ?array
{
    if (empty($screening['checked']) || ($screening['decision'] ?? '') !== 'visual_checks_passed') {
        return null;
    }
    $hash = is_file($filePath) ? hash_file('sha256', $filePath) : false;
    if ($hash === false) return null;
    return [
        'version' => 1,
        'student_id' => $studentId,
        'file_sha256' => $hash,
        'guardian_name' => trim($guardianName),
        'document_type_id' => $documentTypeId,
        'expires_at' => ($now ?? time()) + 1800,
    ];
}

function guardianIdScreeningReceiptMatches(?array $receipt, string $filePath, int $studentId, string $guardianName, int $documentTypeId, ?int $now = null): bool
{
    if (!$receipt || ($receipt['version'] ?? null) !== 1
        || ($receipt['student_id'] ?? null) !== $studentId
        || ($receipt['guardian_name'] ?? null) !== trim($guardianName)
        || ($receipt['document_type_id'] ?? null) !== $documentTypeId
        || ($receipt['expires_at'] ?? 0) <= ($now ?? time()) || !is_file($filePath)) {
        return false;
    }
    $hash = hash_file('sha256', $filePath);
    return is_string($hash) && is_string($receipt['file_sha256'] ?? null)
        && hash_equals($receipt['file_sha256'], $hash);
}

/** Compare extracted holder text without telling the OCR model the expected answer. */
function guardianIdExtractedNameMatches(?string $visibleName, string $expectedName): ?bool
{
    $visible = guardianIdNameTokens((string) $visibleName);
    $expected = guardianIdNameTokens($expectedName);
    if (count($visible) < 2 || count($expected) < 2) return null;
    $visibleEnds = [$visible[0], $visible[count($visible) - 1]];
    $expectedEnds = [$expected[0], $expected[count($expected) - 1]];
    if ($visibleEnds !== $expectedEnds) return false;
    sort($visible);
    sort($expected);
    // If one middle name is omitted, staff must resolve the uncertainty.
    return $visible === $expected ? true : null;
}

function guardianIdDocumentFamily(string $label): ?string
{
    $label = mb_strtolower(trim($label), 'UTF-8');
    foreach (['philsys' => ['philsys', 'national id', 'philippine identification'],
              'umid' => ['umid', 'unified multi-purpose'], 'gsis' => ['gsis'],
              'passport' => ['passport'], 'postal' => ['postal'], 'prc' => ['prc', 'professional regulation'],
              'senior' => ['senior citizen'], 'ofw' => ['ofw'], 'voter' => ["voter's", 'voters'],
              'nbi' => ['nbi']] as $family => $phrases) {
        foreach ($phrases as $phrase) {
            if (str_contains($label, $phrase)) return $family;
        }
    }
    return null;
}

function guardianIdExtractedTypeMatches(?string $visibleLabel, string $selectedType): ?bool
{
    $visible = guardianIdDocumentFamily((string) $visibleLabel);
    $expected = guardianIdDocumentFamily($selectedType);
    return $visible !== null && $expected !== null ? $visible === $expected : null;
}

/** A review receipt grants submission only, never automated approval. */
function guardianIdReviewReceipt(string $filePath, int $studentId, string $guardianName, int $documentTypeId, array $screening, ?int $now = null): ?array
{
    if (empty($screening['checked']) || ($screening['decision'] ?? '') !== 'needs_review') return null;
    $hash = is_file($filePath) ? hash_file('sha256', $filePath) : false;
    if ($hash === false) return null;
    return [
        'version' => 2, 'student_id' => $studentId, 'file_sha256' => $hash,
        'guardian_name' => trim($guardianName), 'document_type_id' => $documentTypeId,
        'expires_at' => ($now ?? time()) + 1800,
        'screening' => $screening,
    ];
}

function guardianIdReviewReceiptMatches(?array $receipt, string $filePath, int $studentId, string $guardianName, int $documentTypeId, ?int $now = null): bool
{
    if (!$receipt || ($receipt['version'] ?? null) !== 2 || ($receipt['student_id'] ?? null) !== $studentId
        || ($receipt['guardian_name'] ?? null) !== trim($guardianName)
        || ($receipt['document_type_id'] ?? null) !== $documentTypeId
        || ($receipt['expires_at'] ?? 0) <= ($now ?? time()) || !is_file($filePath)) return false;
    $hash = hash_file('sha256', $filePath);
    return is_string($hash) && is_string($receipt['file_sha256'] ?? null)
        && hash_equals($receipt['file_sha256'], $hash);
}
