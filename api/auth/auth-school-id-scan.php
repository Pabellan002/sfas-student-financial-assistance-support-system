<?php
require_once __DIR__ . '/../includes/includes-security-init.php';
require_once __DIR__ . '/../includes/includes-upload-security.php';
require_once __DIR__ . '/../config/config-env.php';
require_once __DIR__ . '/../includes/includes-id-fallback.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
    exit;
}

// Note: This is a public registration endpoint, so we don't require CSRF validation
// to support various hosting environments including Cloudflare Tunnel
// CSRFProtection::validateRequest();

$rateLimiter = new RateLimiter();
$rateCheck = $rateLimiter->checkRateLimit('registration_school_id_scan', 8, 600);
if (!$rateCheck['allowed']) {
    http_response_code(429);
    echo json_encode(['success' => false, 'message' => 'Too many scan attempts. Please try again later.']);
    exit;
}

if (!isset($_FILES['school_id_image'])) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Please select a school ID image.']);
    exit;
}

$file = $_FILES['school_id_image'];
[$valid, $validationMessage] = UploadSecurity::validateUploadedFile(
    $file,
    ['jpg', 'jpeg', 'png', 'webp'],
    ['image/jpeg', 'image/png', 'image/webp'],
    5 * 1024 * 1024
);
if (!$valid) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => $validationMessage]);
    exit;
}

$apiKey = trim((string) ($_ENV['GEMINI_API_KEY'] ?? ''));
$mimeType = detectSchoolIdMimeType($file);
$scan = ['checked' => false];
$scanProvider = null;
if ($apiKey !== '') {
    foreach (idScanGeminiModels('gemini-3.5-flash-lite') as $model) {
        $scan = scanSchoolIdWithGemini((string) $file['tmp_name'], $mimeType, $apiKey, $model);
        if (!empty($scan['checked'])) {
            $scanProvider = 'gemini:' . $model;
            break;
        }
    }
}
if (empty($scan['checked']) && trim((string) ($_ENV['GROQ_API_KEY'] ?? '')) !== '') {
    $scan = scanSchoolIdWithGemini((string) $file['tmp_name'], $mimeType, '', 'groq', 'groq');
    if (!empty($scan['checked'])) $scanProvider = 'groq';
}
if (empty($scan['checked'])) {
    $ocr = idScanCloudOcr((string) $file['tmp_name'], $mimeType);
    if ($ocr !== null) {
        $scan = idScanSchoolIdFromOcr($ocr['text']);
        $scanProvider = $ocr['provider'];
    }
}
if (!$scan['checked']) {
    error_log('School ID scan: no configured provider completed the scan');
    http_response_code(503);
    echo json_encode(['success' => false, 'message' => 'School ID scanning is temporarily unavailable. Please enter your details manually.']);
    exit;
}

$schoolId = normalizeSchoolId((string) ($scan['school_id'] ?? ''));
$verified = $scanProvider !== 'ocr_space'
    && !empty($scan['document_is_school_id'])
    && ($scan['institution_matches'] ?? null) !== false
    && $schoolId !== ''
    && (int) ($scan['confidence'] ?? 0) >= 60;

echo json_encode([
    'success' => true,
    'scanProvider' => $scanProvider,
    'verified' => $verified,
    'confidence' => (int) ($scan['confidence'] ?? 0),
    'fields' => [
        'school_id' => $schoolId,
        'first_name' => cleanScannedText($scan['first_name'] ?? null, 80),
        'last_name' => cleanScannedText($scan['last_name'] ?? null, 80),
        'program' => cleanScannedText($scan['program'] ?? null, 160),
        'year_level' => cleanScannedText($scan['year_level'] ?? null, 40),
        'campus' => cleanScannedText($scan['campus'] ?? null, 100),
    ],
    'message' => $verified
        ? 'School ID details found. Please review the autofilled details.'
        : (cleanScannedText($scan['reason'] ?? null, 240) ?: 'The image could not be confidently verified as a PHINMA school ID.'),
]);

function scanSchoolIdWithGemini(string $filePath, string $mimeType, string $apiKey, string $model, string $provider = 'gemini'): array
{
    $fallback = ['checked' => false];
    if (!function_exists('curl_init') || !is_file($filePath)) return $fallback;
    $contents = file_get_contents($filePath);
    if ($contents === false) return $fallback;

    $prompt = <<<'PROMPT'
Review the supplied image only to assist a student in filling out a registration form. Extract only text that is visibly printed on the card. Never guess or infer missing personal information.

Determine whether this is a student/school ID issued by PHINMA Education or a PHINMA school. Do not require a specific PHINMA campus, including Cagayan de Oro College, to be printed on the ID. Return JSON only with exactly this structure:
{
  "document_is_school_id": true | false,
  "institution_matches": true | false | null,
  "school_id": "visible school ID/control number or null",
  "first_name": "visible first name or null",
  "last_name": "visible last name or null",
  "program": "visible program/course or null",
  "year_level": "visible year level or null",
  "campus": "visible campus or null",
  "confidence": 0-100,
  "reason": "short explanation"
}

Use null for unreadable or absent fields. Preserve the visible school ID punctuation. Set institution_matches to true when PHINMA Education or a PHINMA school is visible, false only when another institution is clearly shown, and null if the institution is not readable. A government ID, library card, or unrelated document is not a school ID.
PROMPT;

    if ($provider === 'groq') {
        $result = idScanGroqJson($prompt, $filePath, $mimeType);
        if (!is_array($result) || !is_bool($result['document_is_school_id'] ?? null)
            || !is_numeric($result['confidence'] ?? null)) return $fallback;
        $result['checked'] = true;
        $result['confidence'] = max(0, min(100, (int) $result['confidence']));
        return $result;
    }

    $payload = [
        'contents' => [[
            'role' => 'user',
            'parts' => [
                ['text' => $prompt],
                ['inline_data' => ['mime_type' => $mimeType, 'data' => base64_encode($contents)]],
            ],
        ]],
        'generationConfig' => [
            'maxOutputTokens' => 900,
            'responseMimeType' => 'application/json',
        ],
    ];

    $url = 'https://generativelanguage.googleapis.com/v1beta/models/' . rawurlencode($model) . ':generateContent?key=' . rawurlencode($apiKey);
    $curl = curl_init($url);
    if ($curl === false) return $fallback;
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $raw = curl_exec($curl);
    $httpCode = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
    $curlError = curl_error($curl);
    curl_close($curl);
    
    if ($raw === false || $curlError !== '' || $httpCode < 200 || $httpCode >= 300) {
        error_log("Gemini school ID scan failed (HTTP {$httpCode})");
        return $fallback;
    }

    $response = json_decode($raw, true);
    
    // Try to extract JSON from multiple possible locations
    $text = '';
    
    // Method 1: Try candidates[0].content.parts[].text (standard response)
    $parts = $response['candidates'][0]['content']['parts'] ?? [];
    foreach (is_array($parts) ? $parts : [] as $part) {
        if (isset($part['text']) && is_string($part['text'])) {
            $text .= $part['text'];
        }
    }
    
    // Method 2: If text is too short (extended thinking truncated), search raw response for complete JSON
    if (strlen($text) < 200) {
        // Use regex to find JSON object with all required fields
        $pattern = '/\{[^{}]*"document_is_school_id"[^{}]*"institution_matches"[^{}]*"school_id"[^{}]*"first_name"[^{}]*"last_name"[^{}]*"program"[^{}]*"year_level"[^{}]*"campus"[^{}]*"confidence"[^{}]*"reason"[^{}]*\}/s';
        if (preg_match($pattern, $raw, $matches)) {
            $text = $matches[0];
        } else {
            // Fallback: try to find any JSON that starts with document_is_school_id and extract until the closing brace
            if (preg_match('/\{\s*"document_is_school_id"[^}]*\}(?:[^}]*\})?/s', $raw, $matches)) {
                // Found start, now find the actual end by counting braces
                $startPos = strpos($raw, $matches[0]);
                if ($startPos !== false) {
                    $braceCount = 0;
                    $inString = false;
                    $escape = false;
                    
                    for ($i = $startPos; $i < strlen($raw); $i++) {
                        $char = $raw[$i];
                        
                        if ($escape) {
                            $escape = false;
                            continue;
                        }
                        
                        if ($char === '\\' && $inString) {
                            $escape = true;
                            continue;
                        }
                        
                        if ($char === '"') {
                            $inString = !$inString;
                            continue;
                        }
                        
                        if (!$inString) {
                            if ($char === '{') {
                                $braceCount++;
                            } elseif ($char === '}') {
                                $braceCount--;
                                if ($braceCount === 0) {
                                    $text = substr($raw, $startPos, $i - $startPos + 1);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    if (empty($text)) {
        return $fallback;
    }
    
    $result = json_decode(trim($text), true);
    if (!is_array($result)) {
        return $fallback;
    }

    $result['checked'] = true;
    $result['confidence'] = max(0, min(100, (int) ($result['confidence'] ?? 0)));
    return $result;
}

function detectSchoolIdMimeType(array $file): string
{
    $mime = function_exists('mime_content_type') ? mime_content_type((string) ($file['tmp_name'] ?? '')) : false;
    return in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)
        ? $mime
        : (in_array(($file['type'] ?? ''), ['image/jpeg', 'image/png', 'image/webp'], true) ? $file['type'] : 'image/jpeg');
}

function normalizeSchoolId(string $value): string
{
    $value = strtoupper(trim(preg_replace('/\s+/', '', $value)));
    if (preg_match('/\d{2}-\d{4}-\d{4,6}/', $value, $match)) return $match[0];
    return '';
}

function cleanScannedText($value, int $maxLength): ?string
{
    if (!is_string($value)) return null;
    $value = trim(preg_replace('/\s+/', ' ', strip_tags($value)));
    return $value === '' ? null : mb_substr($value, 0, $maxLength);
}
