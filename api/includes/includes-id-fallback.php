<?php

/** Use a second Gemini model only when it differs from the primary model. */
function idScanGeminiModels(string $defaultModel): array
{
    $primary = trim((string) ($_ENV['GEMINI_MODEL'] ?? $defaultModel));
    $secondary = trim((string) ($_ENV['GEMINI_FALLBACK_MODEL'] ?? ''));
    return array_values(array_unique(array_filter([$primary, $secondary])));
}

/** Groq hosts the vision model; no model runs on this PHP server. */
function idScanGroqJson(string $prompt, ?string $filePath = null, ?string $mimeType = null): ?array
{
    $key = trim((string) ($_ENV['GROQ_API_KEY'] ?? ''));
    if ($key === '' || !function_exists('curl_init')) return null;
    $parts = [['type' => 'text', 'text' => $prompt]];
    if ($filePath !== null) {
        if (!is_file($filePath) || filesize($filePath) > 5 * 1024 * 1024 || $mimeType === null) return null;
        $contents = file_get_contents($filePath);
        if ($contents === false) return null;
        if (in_array($mimeType, ['image/jpeg', 'image/png', 'image/webp'], true)) {
            $parts[] = ['type' => 'image_url', 'image_url' => [
                'url' => 'data:' . $mimeType . ';base64,' . base64_encode($contents)]];
        } else {
            return null;
        }
    }
    $model = trim((string) ($_ENV['GROQ_FALLBACK_MODEL'] ?? 'qwen/qwen3.8-27b'));
    $payload = json_encode([
        'model' => $model,
        'messages' => [['role' => 'user', 'content' => $filePath === null ? $prompt : $parts]],
        'response_format' => ['type' => 'json_object'],
        'max_completion_tokens' => 2048,
        'temperature' => 0.1,
    ]);
    $ch = curl_init('https://api.groq.com/openai/v1/chat/completions');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $key],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 30,
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $status !== 200) {
        error_log('Groq fallback unavailable (HTTP ' . $status . ').');
        return null;
    }
    $response = json_decode($raw, true);
    $content = $response['choices'][0]['message']['content'] ?? null;
    return is_string($content) && is_array($result = json_decode($content, true)) ? $result : null;
}

/**
 * OCR.space is opt-in. Never send a student's document using a demo key, and
 * never log the returned text or credentials.
 */
function idScanCloudOcr(string $filePath, string $mimeType): ?array
{
    if (!function_exists('curl_init') || !is_file($filePath) || filesize($filePath) > 5 * 1024 * 1024) {
        return null;
    }

    $ocrSpaceKey = trim((string) ($_ENV['OCR_SPACE_API_KEY'] ?? ''));
    if ($ocrSpaceKey === '' || strcasecmp($ocrSpaceKey, 'helloworld') === 0) return null;
    $upload = idScanPrepareFreeOcrUpload($filePath, $mimeType);
    if ($upload === null) return null;
    $extensions = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif',
        'image/webp' => 'webp', 'application/pdf' => 'pdf'];
    if (!isset($extensions[$upload['mime']])) return null;
    $ch = curl_init('https://api.ocr.space/parse/image');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => [
            'file' => new CURLFile($upload['path'], $upload['mime'], 'document.' . $extensions[$upload['mime']]),
            'OCREngine' => '2',
            'isOverlayRequired' => 'false',
        ],
        CURLOPT_HTTPHEADER => ['apikey: ' . $ocrSpaceKey],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 25,
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($upload['temporary']) unlink($upload['path']);
    if ($raw === false || $status !== 200) {
        error_log('OCR.space unavailable (HTTP ' . $status . ').');
        return null;
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || !empty($data['IsErroredOnProcessing'])) return null;
    $parsed = $data['ParsedResults'] ?? [];
    if (!is_array($parsed)) return null;
    $parts = array_map(static fn(array $part): string => (string) ($part['ParsedText'] ?? ''),
        array_filter($parsed, 'is_array'));
    $value = trim(implode("\n", $parts));
    return $value === '' ? null : ['provider' => 'ocr_space', 'text' => $value];
}

/** Keep OCR.space free-tier uploads below 1 MB without altering the original ID. */
function idScanPrepareFreeOcrUpload(string $filePath, string $mimeType): ?array
{
    $size = filesize($filePath);
    if ($size === false) return null;
    if ($size <= 950000) return ['path' => $filePath, 'mime' => $mimeType, 'temporary' => false];
    if (!str_starts_with($mimeType, 'image/') || !function_exists('imagecreatefromstring')
        || !function_exists('imagecreatetruecolor')) return null;
    $dimensions = getimagesize($filePath);
    if ($dimensions === false || ($dimensions[0] * $dimensions[1]) > 12000000) return null;
    $contents = file_get_contents($filePath);
    if ($contents === false) return null;
    $source = imagecreatefromstring($contents);
    if ($source === false) return null;
    $scale = min(1, 1600 / max($dimensions[0], $dimensions[1]));
    $width = max(1, (int) round($dimensions[0] * $scale));
    $height = max(1, (int) round($dimensions[1] * $scale));
    $image = imagecreatetruecolor($width, $height);
    $white = imagecolorallocate($image, 255, 255, 255);
    imagefill($image, 0, 0, $white);
    imagecopyresampled($image, $source, 0, 0, 0, 0, $width, $height, $dimensions[0], $dimensions[1]);
    imagedestroy($source);
    $temporaryPath = tempnam(sys_get_temp_dir(), 'sfas-ocr-');
    if ($temporaryPath === false) {
        imagedestroy($image);
        return null;
    }
    foreach ([82, 72, 62] as $quality) {
        if (!imagejpeg($image, $temporaryPath, $quality)) continue;
        clearstatcache(true, $temporaryPath);
        if (filesize($temporaryPath) <= 950000) {
            imagedestroy($image);
            return ['path' => $temporaryPath, 'mime' => 'image/jpeg', 'temporary' => true];
        }
    }
    imagedestroy($image);
    unlink($temporaryPath);
    return null;
}

/** OCR alone can prefill a visible number; it cannot authenticate a school ID. */
function idScanSchoolIdFromOcr(string $text): array
{
    $notSample = !preg_match('/\b(?:sample|specimen|template|not\s+valid)\b/i', $text);
    $institution = (bool) preg_match('/\bPHINMA\b/i', $text);
    $number = preg_match('/\b\d{2}\s*-\s*\d{4}\s*-\s*\d{4,6}\b/', $text, $matches)
        ? preg_replace('/\s+/', '', $matches[0]) : null;
    return [
        'checked' => true,
        'document_is_school_id' => $notSample && $institution && $number !== null,
        'institution_matches' => $institution,
        'school_id' => $notSample && $institution ? $number : null,
        'confidence' => 0,
        'reason' => $notSample
            ? 'OCR read some printed text. Please confirm the ID and enter any missing details manually; OCR cannot authenticate the card.'
            : 'The image appears to contain sample or template text. Please use your issued school ID.',
    ];
}

/** OCR evidence permits only the existing CSDL manual-review route. */
function idScanGuardianFromOcr(string $text): array
{
    $sample = (bool) preg_match('/\b(?:sample|specimen|template|not\s+valid)\b/i', $text);
    return [
        'checked' => true,
        'decision' => $sample ? 'invalid' : 'needs_review',
        'document_side' => 'unclear',
        'front_required' => false,
        'name_matches' => null,
        'holder_matches_student' => null,
        'document_type_matches' => null,
        'image_quality' => 'unclear',
        'signature_visible' => 'unclear',
        'portrait_visible' => 'unclear',
        'portrait_quality' => 'unclear',
        'template_or_sample' => $sample ? 'yes' : 'unclear',
        'tampering_signs' => 'unclear',
        'issuer_verified' => false,
        'visible_holder_name' => null,
        'visible_document_label' => null,
        'reason' => $sample
            ? 'OCR found sample or template text. Upload an issued ID.'
            : 'Only OCR text was available. CSDL must inspect the original image, holder, document type, and portrait before approval.',
    ];
}
