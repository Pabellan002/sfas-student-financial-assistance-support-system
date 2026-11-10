<?php

class PasswordPolicy
{
    public const MAX_AGE_DAYS = 30;

    public static function getChangeReason(
        string $passwordHash,
        string $schoolId,
        $passwordChangedAt,
        $accountCreatedAt,
        ?int $now = null
    ): ?string {
        if (password_verify($schoolId, $passwordHash)) {
            return 'default';
        }

        $baseline = $passwordChangedAt ?: $accountCreatedAt;
        $changedAt = is_string($baseline) ? strtotime($baseline) : false;
        $now ??= time();
        if ($changedAt === false || $changedAt <= $now - (self::MAX_AGE_DAYS * 86400)) {
            return 'expired';
        }

        return null;
    }
}

