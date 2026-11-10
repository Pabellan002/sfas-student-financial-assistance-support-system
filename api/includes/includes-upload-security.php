<?php

class UploadSecurity {
    /** Common MIME types per extension (Excel/Windows often mis-detect CSV). */
    private static $mimeByExtension = [
        'csv' => [
            'text/csv',
            'text/plain',
            'application/csv',
            'application/vnd.ms-excel',
            'application/octet-stream',
        ],
        'xls' => [
            'application/vnd.ms-excel',
            'application/vnd.ms-office',
            'application/octet-stream',
        ],
        'xlsx' => [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/zip',
            'application/octet-stream',
        ],
    ];

    public static function validateUploadedFile(array $file, array $allowedExtensions, array $allowedMimeTypes, int $maxBytes): array {
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            return [false, 'File upload failed.'];
        }

        $tmpName = $file['tmp_name'] ?? '';
        if (empty($tmpName) || !is_uploaded_file($tmpName)) {
            return [false, 'Invalid file upload.'];
        }

        $size = (int) ($file['size'] ?? 0);
        if ($size <= 0 || $size > $maxBytes) {
            $maxFileSizeMB = round($maxBytes / (1024 * 1024), 2);
            return [false, 'File size exceeds ' . $maxFileSizeMB . 'MB limit.'];
        }

        $extension = strtolower(pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
        if (empty($extension) || !in_array($extension, $allowedExtensions, true)) {
            return [false, 'Invalid file extension.'];
        }

        $detectedMimeType = null;
        if (function_exists('finfo_open')) {
            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo !== false) {
                $detectedMimeType = finfo_file($finfo, $tmpName) ?: null;
                finfo_close($finfo);
            }
        }

        $clientMimeType = strtolower(trim((string)($file['type'] ?? '')));
        $mimeToValidate = $detectedMimeType ?: $clientMimeType;

        $acceptableMimes = array_unique(array_merge(
            $allowedMimeTypes,
            self::$mimeByExtension[$extension] ?? []
        ));

        if (!empty($mimeToValidate) && in_array($mimeToValidate, $acceptableMimes, true)) {
            return [true, 'ok'];
        }

        // CSV saved from Excel: extension .csv but empty/unknown MIME — trust extension
        if ($extension === 'csv' && in_array('csv', $allowedExtensions, true)) {
            return [true, 'ok'];
        }

        if (empty($mimeToValidate)) {
            return [false, 'Invalid file content type.'];
        }

        return [false, 'Invalid file content type.'];
    }
}

