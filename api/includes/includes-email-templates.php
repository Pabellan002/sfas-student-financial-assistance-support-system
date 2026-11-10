<?php

class EmailTemplates
{
    private const SCHOOL_NAME = 'PHINMA Cagayan de Oro College';
    private const COLOR_PRIMARY = '#03600f';
    private const COLOR_PRIMARY_LIGHT = '#0a8f1b';
    private const COLOR_GOLD = '#c9a227';
    private const SCHOOL_LOGO_CID = 'sfas-school-logo';

    private static function schoolLogoPath(): ?string
    {
        $logoPath = __DIR__ . '/../../assets/images/csdl-logo.png';
        if (!is_file($logoPath) || ($handle = @fopen($logoPath, 'rb')) === false) {
            return null;
        }
        fclose($handle);
        return $logoPath;
    }

    public static function schoolLogoCid(): ?string
    {
        return self::schoolLogoPath() !== null ? self::SCHOOL_LOGO_CID : null;
    }

    private static function schoolLogoUrl(): ?string
    {
        $base = trim((string) ($_ENV['APP_URL'] ?? ''));
        $parts = $base !== '' ? parse_url($base) : false;
        if (!is_array($parts) || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
            || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])) {
            return null;
        }

        $base = preg_replace('~/views/auth(?:/login\.html)?$~i', '', rtrim($base, '/'));
        return rtrim($base, '/') . '/assets/images/csdl-logo.png';
    }

    public static function embedSchoolLogo(\Symfony\Component\Mime\Email $email): void
    {
        if (!str_contains((string) $email->getHtmlBody(), 'cid:' . self::SCHOOL_LOGO_CID)) {
            return;
        }
        $logoPath = self::schoolLogoPath();
        if ($logoPath !== null) {
            $email->embed(file_get_contents($logoPath), self::SCHOOL_LOGO_CID, 'image/png');
        }
    }

    public static function editableOffices(): array
    {
        return [
            'csdl' => 'CSDL Counseling',
            'coo' => 'COO',
            'assessment' => 'Assessment / Finance',
            'cashier' => 'Cashier / Finance',
            'branch_butuan' => 'Branch Admin · Butuan',
            'branch_iligan' => 'Branch Admin · Iligan',
            'branch_puerto' => 'Branch Admin · Puerto',
        ];
    }

    public static function editableTypes(string $role): array
    {
        $labels = [
            'registration_submitted' => 'Registration received',
            'registration_rejected' => 'Registration not approved',
            'registration_pending_finance' => 'Registration approved by CSDL',
            'registration_approved' => 'Balance setup completed',
            'loan_application_receipt' => 'Loan application receipt',
            'loan_approve' => 'Loan approved',
            'loan_return' => 'Loan returned',
            'loan_endorsed' => 'Loan endorsed',
            'loan_partial_payment' => 'Partial payment / amount updated',
            'loan_paid_partial' => 'Partial payment recorded',
            'loan_paid_pending' => 'Advance payment recorded',
            'loan_payment_confirmed' => 'Payment confirmed',
            'loan_pn_tagged_completed' => 'PN tagged / completed',
        ];
        $sentByOffice = match ($role) {
            'csdl' => ['registration_submitted', 'registration_rejected', 'registration_pending_finance', 'loan_application_receipt',
                'loan_approve', 'loan_return', 'loan_endorsed'],
            'assessment' => ['registration_approved', 'loan_approve', 'loan_endorsed',
                'loan_partial_payment', 'loan_pn_tagged_completed'],
            'cashier' => ['loan_approve', 'loan_partial_payment', 'loan_paid_partial',
                'loan_paid_pending', 'loan_payment_confirmed'],
            'coo', 'branch_butuan', 'branch_iligan', 'branch_puerto' => ['loan_approve', 'loan_partial_payment'],
            default => [],
        };
        return array_intersect_key($labels, array_fill_keys($sentByOffice, true));
    }

    public static function editableDefaults(string $type): array
    {
        $defaults = [
            'registration_submitted' => ['Registration received - awaiting CSDL approval', 'We received your registration, {student_name}. Your School ID is {school_id}. CSDL will review your information and email you when there is an update.'],
            'registration_rejected' => ['Registration not approved - School ID {school_id}', 'Your registration was not approved, {student_name}. Please review your information and submit a new registration with School ID {school_id}. Contact the CSDL office if you need help.'],
            'registration_pending_finance' => ['CSDL approved your registration - you can now sign in', 'Your registration has been approved by CSDL, {student_name}. You may sign in with your School ID {school_id} while Assessment prepares your balance.'],
            'registration_approved' => ['Your student balance is ready', 'Your student balance setup is complete, {student_name}. Sign in with School ID {school_id} to view your balance and available loan applications.'],
            'loan_application_receipt' => ['PHINMA COC Student Financial Assistance Application Form - Application #{application_no}', 'We received your student loan application. Below is a summary of your submission for your reference.'],
            'loan_approve' => ['Loan Approved - Application #{application_no}', 'Your loan application {application_no} has been approved. Please check your account for the next step.'],
            'loan_return' => ['Loan Application Returned - Application #{application_no}', 'Your loan application {application_no} was returned for revision. Sign in, review the remarks, and resubmit the requested information.'],
            'loan_endorsed' => ['Loan Endorsed - Application #{application_no}', 'Your loan application {application_no} has been endorsed to {destination_office} for the next review step. No action is needed right now.'],
            'loan_partial_payment' => ['Partial Payment Update - Application #{application_no}', 'A partial amount {amount} has been set or updated for your loan application {application_no}. Please review your account for payment instructions and any due date.'],
            'loan_paid_partial' => ['Partial Payment Recorded - Application #{application_no}', 'Your partial payment {amount} for loan application {application_no} has been recorded.'],
            'loan_paid_pending' => ['Advance Payment Recorded - Application #{application_no}', 'Your advance payment {amount} for loan application {application_no} has been recorded while the application remains under review.'],
            'loan_payment_confirmed' => ['Payment Confirmed - Application #{application_no}', 'Your payment {amount} for loan application {application_no} has been confirmed.'],
            'loan_pn_tagged_completed' => ['Loan Application Completed - Application #{application_no}', 'The promissory note for loan application {application_no} has been tagged successfully. Your application is complete.'],
        ];
        if (!isset($defaults[$type])) throw new InvalidArgumentException('Unknown email template.');
        return ['subject' => $defaults[$type][0], 'body' => $defaults[$type][1]];
    }

    public static function editableKey(string $role, string $type): string
    {
        if (!isset(self::editableOffices()[$role]) || !isset(self::editableTypes($role)[$type])) {
            throw new InvalidArgumentException('Unknown office or email template.');
        }
        return 'email_template_' . $role . '_' . $type;
    }

    public static function editableOverride(PDO $pdo, string $role, string $type): ?array
    {
        // Old queue jobs may still use the role that existed before campus routing.
        if ($role === 'legacy' || $role === 'system') return null;
        $key = self::editableKey($role, $type);
        $stmt = $pdo->prepare('SELECT setting_value FROM tbl_csdl_settings WHERE setting_key = ? LIMIT 1');
        $stmt->execute([$key]);
        $value = $stmt->fetchColumn();
        $saved = is_string($value) ? json_decode($value, true) : null;
        return is_array($saved) && isset($saved['subject'], $saved['body']) ? $saved : null;
    }

    public static function editableVariables(array $values): array
    {
        return [
            'student_name' => (string) ($values['student_name'] ?? 'Student'),
            'application_no' => (string) ($values['application_no'] ?? ''),
            'school_id' => (string) ($values['school_id'] ?? ''),
            'amount' => (string) ($values['amount'] ?? ''),
            'due_date' => (string) ($values['due_date'] ?? ''),
            'destination_office' => (string) ($values['destination_office'] ?? ''),
        ];
    }

    public static function editableText(string $text, array $values, bool $html = false): string
    {
        $values = self::editableVariables($values);
        $rendered = preg_replace_callback('/\{([a-z_]+)\}/',
            static fn($match) => $values[$match[1]] ?? $match[0], $text);
        return $html ? nl2br(self::escape($rendered), false) : str_replace(["\r", "\n"], ' ', $rendered);
    }

    public static function editableMessage(?array $override, array $values): ?string
    {
        return $override === null ? null : self::editableText((string) $override['body'], $values, true);
    }

    public static function otpEmail(
        string $recipientName,
        string $otp,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = 'support@csdl.edu'
    ): string {
        $safeName = self::escape($recipientName ?: 'User');
        $safeOtp = self::escape($otp);
        $logoCid = self::schoolLogoCid();

        $content = self::renderGreeting($safeName)
            . self::renderParagraph(
                'We received a request to verify your identity on the <strong>Student Financial Assistance System</strong>. '
                . 'Please enter the one-time password (OTP) below to continue.'
            )
            . self::renderOtpBox($safeOtp)
            . self::renderNoticeBox(
                'This code is valid for <strong>10 minutes</strong>. For your security, do not share this code with anyone.',
                'info'
            )
            . self::renderParagraph(
                'If you did not request this verification, you may safely ignore this email. '
                . 'No changes will be made to your account.'
            );

        return self::renderEmailShell(
            'Identity Verification',
            $content,
            $appName,
            $supportEmail,
            'Your one-time password for account verification.',
            $logoCid
        );
    }

    public static function loanNotificationEmail(
        string $recipientName, 
        string $statusType, 
        string $applicationNo, 
        ?string $amountApproved = null,
        ?string $paymentDueDate = null,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = 'support@csdl.edu',
        ?string $destinationOffice = null,
        ?string $updatedAmountCanPay = null,
        ?string $customMessage = null
    ): string {
        $safeName = self::escape($recipientName ?: 'Student');
        $safeAppNo = self::escape($applicationNo);
        $safeAmount = $amountApproved ? self::escape($amountApproved) : null;
        $safePaymentDueDate = $paymentDueDate ? self::escape($paymentDueDate) : null;
        $destinationOffice = trim((string) $destinationOffice);
        $safeDestinationOffice = $destinationOffice !== '' ? self::escape($destinationOffice) : null;
        $safeUpdatedAmountCanPay = $updatedAmountCanPay ? self::escape(trim($updatedAmountCanPay)) : null;

        $statusConfig = [
            'approve' => [
                'title' => 'Loan Application Approved',
                'badge' => 'Approved',
                'color' => '#059669',
                'bg' => '#ecfdf5',
                'border' => '#a7f3d0',
                'message' => 'Congratulations! Your student loan application has been <strong>reviewed and approved</strong>'
                    . ($safeAmount ? ' for an amount of <strong>' . $safeAmount . '</strong>.' : '.'),
                'details' => 'Your application is now waiting for <strong>PN tagging</strong>. Please wait for the next step; '
                    . 'we will notify you as soon as your PN status has been updated.',
            ],
            'decline' => [
                'title' => 'Application Not Approved',
                'badge' => 'Declined',
                'color' => '#dc2626',
                'bg' => '#fef2f2',
                'border' => '#fecaca',
                'message' => 'After careful review, we regret to inform you that your student loan application was <strong>not approved</strong> at this time.',
                'details' => 'For further clarification regarding this decision, you may visit the CSDL office during regular office hours '
                    . 'or contact us using the information below.',
            ],
            'return' => [
                'title' => 'Application Returned for Revision',
                'badge' => 'Returned',
                'color' => '#d97706',
                'bg' => '#fffbeb',
                'border' => '#fde68a',
                'message' => 'Your student loan application has been <strong>returned for revision</strong>.',
                'details' => 'Please sign in to the Student Financial Assistance System to review the remarks, '
                    . 'complete the required updates, and resubmit your application at your earliest convenience.',
            ],
            'resubmitted' => [
                'title' => 'Application Resubmitted',
                'badge' => 'Resubmitted',
                'color' => '#2563eb',
                'bg' => '#eff6ff',
                'border' => '#bfdbfe',
                'message' => 'Your student loan application has been <strong>resubmitted successfully</strong>.',
                'details' => 'Your application is back in the review queue. We will email you again when its status changes.',
            ],
            'cancelled' => [
                'title' => 'Application Cancelled',
                'badge' => 'Cancelled',
                'color' => '#6b7280',
                'bg' => '#f9fafb',
                'border' => '#d1d5db',
                'message' => 'Your student loan application has been <strong>cancelled</strong>.',
                'details' => 'No further processing will occur for this application. You may submit a new application when permitted by the current application-period rules.',
            ],
            'endorsed' => [
                'title' => $destinationOffice !== '' ? 'Application Endorsed to ' . $destinationOffice : 'Application Endorsed for Review',
                'badge' => $destinationOffice !== '' ? 'Endorsed to ' . $destinationOffice : 'Endorsed',
                'color' => '#2563eb',
                'bg' => '#eff6ff',
                'border' => '#bfdbfe',
                'message' => $safeDestinationOffice
                    ? 'Your student loan application has been <strong>reviewed and endorsed to ' . $safeDestinationOffice . '</strong> for the next approval step.'
                    : 'Your student loan application has been <strong>reviewed and endorsed</strong> for the next approval step.',
                'details' => 'No action is needed from you right now. '
                    . ($safeDestinationOffice ? 'The ' . $safeDestinationOffice : 'The receiving office') . ' will continue the review, '
                    . 'and we will notify you once there is an update on your application.',
            ],
            'endorsed_to_bukas' => [
                'title' => 'Application Endorsed to Bukas',
                'badge' => 'Endorsed to Bukas',
                'color' => '#2563eb',
                'bg' => '#eff6ff',
                'border' => '#bfdbfe',
                'message' => 'Your student loan application has been <strong>endorsed to Bukas</strong> for the next processing step.',
                'details' => 'No action is needed from you right now. Please monitor your account and email for the next update.',
            ],
            'partial_payment' => [
                'title' => $safeUpdatedAmountCanPay ? 'Amount Can Pay Updated' : 'Partial Payment',
                'badge' => $safeUpdatedAmountCanPay ? 'Additional Amount Added' : 'Partial Payment',
                'color' => '#d97706',
                'bg' => '#fffbeb',
                'border' => '#fde68a',
                'message' => $safeUpdatedAmountCanPay
                    ? 'An <strong>additional partial amount</strong>'
                        . ($safeAmount ? ' of <strong>' . $safeAmount . '</strong>' : '')
                        . ' has been added to your student loan application.'
                    : 'A <strong>partial payment</strong> has been set'
                        . ($safeAmount ? ' of <strong>' . $safeAmount . '</strong>' : '')
                        . ' for your student loan application.',
                'details' => $safeUpdatedAmountCanPay
                    ? 'Your updated <strong>Amount Can Pay is ' . $safeUpdatedAmountCanPay . '</strong>. Please proceed to the Cashier for payment processing.'
                    : 'Please pay this amount'
                        . ($safePaymentDueDate ? ' on or before <strong>' . $safePaymentDueDate . '</strong>.' : '.')
                        . ' Once the payment is recorded, your loan can proceed to completion.',
            ],
            'paid_partial' => [
                'title' => 'Partial Payment Recorded',
                'badge' => 'Paid Partial',
                'color' => '#d97706',
                'bg' => '#fffbeb',
                'border' => '#fde68a',
                'message' => 'Your partial payment'
                    . ($safeAmount ? ' of <strong>' . $safeAmount . '</strong>' : '')
                    . ' has been <strong>recorded successfully</strong>.',
                'details' => 'Your loan remains open for the remaining payment. You can monitor its payment status in the Student Financial Assistance System.',
            ],
            'paid_pending' => [
                'title' => 'Advance Payment Recorded',
                'badge' => 'Paid Pending',
                'color' => '#d97706',
                'bg' => '#fffbeb',
                'border' => '#fde68a',
                'message' => 'Your advance payment'
                    . ($safeAmount ? ' of <strong>' . $safeAmount . '</strong>' : '')
                    . ' has been <strong>recorded</strong> while your loan is still under review.',
                'details' => 'Your loan will continue through its remaining approval steps. We will notify you when its status changes.',
            ],
            'payment_confirmed' => [
                'title' => 'Payment Confirmed',
                'badge' => 'Paid',
                'color' => '#059669',
                'bg' => '#ecfdf5',
                'border' => '#a7f3d0',
                'message' => 'Your payment'
                    . ($safeAmount ? ' of <strong>' . $safeAmount . '</strong>' : '')
                    . ' has been <strong>confirmed</strong>.',
                'details' => 'Your loan has been forwarded to ' . ($safeDestinationOffice ?? 'the responsible office') . ' for PN tagging. We will notify you when the process is complete.',
            ],
            'pn_paid' => [
                'title' => 'Loan Application Marked as Paid',
                'badge' => 'Paid',
                'color' => '#059669',
                'bg' => '#ecfdf5',
                'border' => '#a7f3d0',
                'message' => 'Congratulations! Your loan application <strong>' . $safeAppNo . '</strong> has been marked as <strong>paid</strong>.',
                'details' => 'You can now view or download your exam permit in <strong>SIS PHINMA COC</strong>. '
                    . 'Please sign in to your SIS account to access your permit.',
                'action_url' => 'https://sis-coc.phinma.edu.ph/iitmsv4eGq0RuNHb0G5WbhLmTKLmTO7YBcJ4RHuXxCNPvuIw=?enc=EGbCGWnlHNJ/WdgJnKH8DA==',
                'action_label' => 'Open SIS PHINMA COC',
            ],
            'pn_tagged_completed' => [
                'title' => 'Loan Application Completed',
                'badge' => 'PN Tagged',
                'color' => '#059669',
                'bg' => '#ecfdf5',
                'border' => '#a7f3d0',
                'message' => 'Congratulations! The promissory note for your loan application <strong>' . $safeAppNo . '</strong> has been <strong>tagged successfully</strong>.',
                'details' => 'Your loan application is now complete. You may sign in to <strong>SIS PHINMA COC</strong> to view or download your exam permit.',
                'action_url' => 'https://sis-coc.phinma.edu.ph/iitmsv4eGq0RuNHb0G5WbhLmTKLmTO7YBcJ4RHuXxCNPvuIw=?enc=EGbCGWnlHNJ/WdgJnKH8DA==',
                'action_label' => 'Open SIS PHINMA COC',
            ],
            'overdue' => [
                'title' => 'Loan Application Overdue',
                'badge' => 'Overdue',
                'color' => '#dc2626',
                'bg' => '#fef2f2',
                'border' => '#fecaca',
                'message' => 'The review deadline for your student loan application has <strong>passed</strong>.',
                'details' => 'Your application remains active and can still be processed by the assigned office. Please check your account for updates or instructions.',
            ],
        ];
        
        $config = $statusConfig[$statusType] ?? $statusConfig['endorsed'];
        
        $content = self::renderGreeting($safeName)
            . self::renderParagraph($customMessage ?? $config['message'])
            . self::renderStatusCard($config)
            . self::renderHighlightBox(
                '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Application Number</div>'
                . '<div style="font-size:20px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $safeAppNo . '</div>'
            );

        if ($statusType === 'partial_payment' && $safeUpdatedAmountCanPay) {
            $content .= self::renderHighlightBox(
                '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">New Amount Can Pay</div>'
                . '<div style="font-size:20px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $safeUpdatedAmountCanPay . '</div>'
            );
        }

        if ($customMessage === null) $content .= self::renderParagraph($config['details']);

        if (!empty($config['action_url']) && !empty($config['action_label'])) {
            $content .= self::renderButton((string) $config['action_url'], (string) $config['action_label']);
        }

        return self::renderEmailShell(
            $config['title'],
            $content,
            $appName,
            $supportEmail,
            'Update on your loan application #' . $applicationNo,
            self::schoolLogoCid()
        );
    }

    public static function loanApplicationSubmittedEmail(
        array $data,
        ?string $imageCid = null,
        ?string $idSampleCid = null,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = 'support@csdl.edu',
        ?string $customMessage = null
    ): string {
        $safe = fn($key, $fallback = '-') => self::escape(trim($data[$key] ?? $fallback));

        $studentName = $safe('studentName', 'Student');
        $studentSchoolId = $safe('studentSchoolId');
        $applicationNo = $safe('applicationNo', 'N/A');
        $course = $safe('course');
        $yearLevel = $safe('yearLevel');
        $campus = $safe('campus');
        $scholarship = $safe('scholarship');
        $contact = $safe('contact');
        $email = $safe('email');
        $fbAccount = $safe('fbAccount');
        $applicationPeriod = $safe('applicationPeriod');
        $loanReason = $safe('loanReason');
        $amountCanPay = $safe('amountCanPay');
        $paymentDate = $safe('paymentDate');
        $parentName = $safe('parentName');
        $parentContact = $safe('parentContact');
        $relationship = $safe('relationship');
        $guardianIdLabel = $safe('guardianIdLabel', 'Attached');

        $consentValue = null;
        $consentKeys = ['dataPrivacyConsent', 'loan_data_privacy_consent', 'data_privacy_consent', 'consent', 'loanDataPrivacyConsent'];
        foreach ($consentKeys as $k) {
            if (array_key_exists($k, $data)) {
                $candidate = $data[$k];
                if ($candidate !== null && $candidate !== '') {
                    $consentValue = $candidate;
                    break;
                }
            }
        }

        $consentRaw = trim((string) $consentValue);
        $consentLower = strtolower($consentRaw);
        $consentAgreed = in_array($consentLower, ['1', 'yes', 'agree', 'agreed', 'true', 'on'], true);
        $consentDisagreed = in_array($consentLower, ['0', 'no', 'disagree', 'declined', 'false', 'off'], true);
        $agreeLabel = self::escape(($consentAgreed ? '☑ ' : '☐ ') . 'I agree');
        $disagreeLabel = self::escape(($consentDisagreed ? '☑ ' : '☐ ') . 'I disagree');
        $consentSummary = self::escape($consentAgreed ? 'Agree' : ($consentDisagreed ? 'Disagree' : 'Not provided'));

        $promissoryValue = null;
        $promissoryKeys = ['loan_promissory_agreement', 'promissoryAgreement', 'loanPromissoryAgreement'];
        foreach ($promissoryKeys as $k) {
            if (array_key_exists($k, $data)) {
                $candidate = $data[$k];
                if ($candidate !== null && $candidate !== '') {
                    $promissoryValue = $candidate;
                    break;
                }
            }
        }
        $promissoryRaw = trim((string) $promissoryValue);
        $promissoryLower = strtolower($promissoryRaw);
        $promissoryAgreed = in_array($promissoryLower, ['1', 'yes', 'agree', 'agreed', 'true', 'on'], true);
        $promissorySummary = self::escape($promissoryAgreed ? 'Agreed' : 'Not provided');

        $submittedFilesRaw = $data['submittedFiles'] ?? [];
        if (!is_array($submittedFilesRaw)) {
            $submittedFilesRaw = [$submittedFilesRaw];
        }
        $submittedFiles = [];
        foreach ($submittedFilesRaw as $v) {
            $v = trim((string) $v);
            if ($v !== '') {
                $submittedFiles[] = $v;
            }
        }

        $submittedFilesHtml = '';
        if (!empty($submittedFiles)) {
            $items = '';
            foreach ($submittedFiles as $name) {
                $items .= '<li style="margin-bottom:4px;">' . self::escape($name) . '</li>';
            }
            $submittedFilesHtml = self::renderSection(
                'Submitted Files',
                '<ul style="margin:0;padding-left:18px;color:#374151;line-height:1.7;">' . $items . '</ul>'
            );
        }

        $imageBlock = '';
        if ($imageCid) {
            $imageBlock = '<div style="text-align:center;margin:16px 0 8px;">
                <img src="cid:' . self::escape($imageCid) . '" alt="Application Process Overview" style="max-width:100%;height:auto;border-radius:10px;border:1px solid #d1e7d4;">
            </div>';
        }

        $idSampleBlock = '';
        if ($idSampleCid) {
            $idSampleBlock = '<div style="text-align:center;margin:14px 0 4px;">
                <img src="cid:' . self::escape($idSampleCid) . '" alt="Sample Parent or Guardian Valid ID" style="max-width:100%;height:auto;border-radius:10px;border:1px solid #d1e7d4;">
            </div>';
        }

        $consentBlock = self::renderSection(
            'Personal Data Consent',
            '<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#374151;">'
            . 'By accomplishing this Student Information Form, the student and her/his parents or guardian '
            . '(1) certify that the information provided is true and complete, '
            . '(2) acknowledge that the confidentiality of information is protected by the Data Privacy Act of 2012 (R.A. 10173), and '
            . '(3) authorize the release of any and all academic, financial, and any other information that may be requested by the government for regulatory purposes '
            . 'or affiliates of the school to aid the school in achieving its purposes. The information will be available to the school until such time the consent is revoked in writing.'
            . '</p>'
            . '<div style="font-size:14px;line-height:1.8;color:#1f2937;">'
            . '<div>' . $agreeLabel . '</div>'
            . '<div>' . $disagreeLabel . '</div>'
            . '<div style="margin-top:8px;font-size:13px;color:#6b7280;">Selection: <strong>' . $consentSummary . '</strong></div>'
            . '</div>'
        );

        $instructionsBlock = self::renderSection(
            'Instructions',
            '<ol style="margin:8px 0 0 20px;padding:0;line-height:1.7;color:#374151;font-size:14px;">'
            . '<li>Application is open one week before every periodic examination within office hours: Monday - Friday: 7:30 AM - 5:00 PM; Saturday: 8:00 AM - 12:00 NN.</li>'
            . '<li>Students must attach/submit one (1) valid ID of parent/guardian with signature.</li>'
            . '<li>The maximum amount per student is Php 3,000.00. Loans above Php 3,000.00 require the approval of the Controller or COO.</li>'
            . '<li>Wait 1-2 days for the verification process. Status will be sent to your PHINMAEd email or via call/text from CSDL/Assessment/Cashier/COO Office.</li>'
              . '<li>Approved loan amount shall be paid within 30 days.</li>'
            . '</ol>'
            . '<p style="margin:12px 0 0;font-size:14px;color:#4b5563;">Your email (<strong>' . $email . '</strong>) was recorded when you submitted this form.</p>'
        );

        $content = self::renderParagraph(
            '<strong>This form is intended for PHINMA COC Students only.</strong> '
            . 'Students can apply for an interest-free loan to ensure the examination permit is secured on time '
            . 'or request a forward balance during enrollment.'
        )
            . $instructionsBlock
            . $imageBlock
            . $consentBlock
            . self::renderGreeting($studentName)
            . self::renderParagraph($customMessage ??
                'We received your student loan application. Below is a summary of your submission for your reference.')
            . self::renderHighlightBox(
                '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Application No</div>'
                . '<div style="font-size:22px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $applicationNo . '</div>'
            )
            . self::renderSection(
                'Student Information',
                self::renderKeyValueGrid([
                    ['Student ID Number', $studentSchoolId],
                    ['Complete Name', $studentName],
                    ['Course', $course],
                    ['Year Level', $yearLevel],
                    ['Campus', $campus],
                    ['Type of Scholarship', $scholarship],
                    ['Student Active Contact Number', $contact],
                    ['FB Account (Name or Link)', $fbAccount],
                    ['PHINMAEd Email', $email],
                ])
            )
            . self::renderSection(
                'Promissory Note',
                self::renderKeyValueGrid([
                    ['Reason/s for student loan application', $loanReason],
                    ['Amount I can pay', $amountCanPay],
                    ['Promised Date of Payment', $paymentDate],
                    ['Application Period', $applicationPeriod],
                ])
                . '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eef2ef;font-size:14px;color:#374151;">'
                . 'Promissory Agreement: <strong>' . $promissorySummary . '</strong>'
                . '</div>'
            )
            . self::renderSection(
                'Parent/Guardian Information',
                self::renderKeyValueGrid([
                    ['Parent/Guardian Complete Name', $parentName],
                    ['Relationship to the Student', $relationship],
                    ['Parent/Guardian Active Contact No', $parentContact],
                ])
            )
            . self::renderSection(
                'Parent/Guardian Valid ID with Signature',
                '<p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;">List of Valid ID:</p>'
                . '<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#374151;">'
                . 'Voter\'s ID, National ID, Passport, Driver\'s License, UMID, PhilHealth ID, Postal ID, TIN ID, '
                . 'NBI Clearance, PRC ID, Senior Citizen ID, OWWA OFW e-Card, PWD ID, Barangay ID, Police Clearance'
                . '</p>'
                . '<p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;">For Self-Employed Students:</p>'
                . '<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#374151;">Valid Company ID or Current Payslip</p>'
                . self::renderNoticeBox(
                    'Note: Make sure that the file uploaded is clear and not your school ID.',
                    'warning'
                )
                . '<p style="margin:12px 0 0;font-size:14px;color:#374151;"><strong>Uploaded file:</strong> ' . $guardianIdLabel . '</p>'
                . $idSampleBlock
            )
            . $submittedFilesHtml
            . self::renderParagraph(
                'Please keep this email for your records. If you have questions, contact us at '
                . '<a href="mailto:' . self::escape($supportEmail) . '" style="color:' . self::COLOR_PRIMARY_LIGHT . ';text-decoration:none;font-weight:600;">'
                . self::escape($supportEmail) . '</a>.'
            )
            . self::renderParagraph(
                '<span style="font-size:13px;color:#6b7280;">This email was sent by ' . self::escape($appName) . '. Please do not reply directly to this message.</span>'
            );

        return self::renderEmailShell(
            'Application Received',
            $content,
            $appName,
            $supportEmail,
            'Confirmation of your student financial assistance application #' . ($data['applicationNo'] ?? ''),
            self::schoolLogoCid()
        );
    }

    public static function studentRegistrationSubmittedEmail(
        string $recipientName,
        string $schoolId,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = '',
        ?string $logoCid = null,
        ?string $customMessage = null
    ): string {
        $safeName = self::escape($recipientName ?: 'Student');
        $safeSchoolId = self::escape($schoolId);

        $content = self::renderGreeting($safeName)
            . self::renderParagraph($customMessage ?? (
                'We received your student account registration for the <strong>Student Financial Assistance System</strong>. '
                . 'Your information is now waiting for review by the <strong>CSDL office</strong>.'
            ))
            . self::renderHighlightBox(
                '<div style="text-align:center;">'
                . '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">School ID</div>'
                . '<div style="font-size:20px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $safeSchoolId . '</div>'
                . '</div>'
            )
            . self::renderNoticeBox(
                '<strong>Your account is not active yet.</strong> You will receive another email after CSDL approves your registration. '
                . 'After approval, Assessment will prepare your balance before loan applications become available.',
                'info'
            )
            . self::renderParagraph(
                'You do not need to submit another registration while this request is under review.'
            );

        return self::renderEmailShell(
            'Registration Received',
            $content,
            $appName,
            $supportEmail,
            'We received your registration and it is waiting for CSDL review.',
            $logoCid
        );
    }

    public static function studentRegistrationRejectedEmail(
        string $recipientName,
        string $schoolId,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = '',
        ?string $logoCid = null,
        ?string $customMessage = null
    ): string {
        $safeName = self::escape($recipientName ?: 'Student');
        $safeSchoolId = self::escape($schoolId);

        $content = self::renderGreeting($safeName)
            . self::renderParagraph($customMessage ?? (
                'Your student account registration was <strong>not approved</strong> by the CSDL office. '
                . 'Please review your information and submit a new registration if you wish to apply again.'
            ))
            . self::renderHighlightBox(
                '<div style="text-align:center;">'
                . '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">School ID</div>'
                . '<div style="font-size:20px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $safeSchoolId . '</div>'
                . '</div>'
            )
            . self::renderNoticeBox(
                'This registration cannot be used to sign in. You may submit a new registration with the same School ID. '
                . 'For questions about the decision, please contact the CSDL office.',
                'info'
            );

        return self::renderEmailShell(
            'Registration Not Approved',
            $content,
            $appName,
            $supportEmail,
            'Your registration was not approved. You may submit a new registration.',
            $logoCid
        );
    }

    public static function studentRegistrationPendingFinanceEmail(
        string $recipientName,
        string $schoolId,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = '',
        ?string $loginUrl = null,
        ?string $logoCid = null,
        ?string $customMessage = null
    ): string {
        $safeName = self::escape($recipientName ?: 'Student');
        $safeSchoolId = self::escape($schoolId);
        $loginUrl = $loginUrl ?: self::resolveLoginUrl();
        $safeLoginUrl = self::escape($loginUrl);

        $content = self::renderGreeting($safeName)
            . self::renderParagraph($customMessage ?? (
                'Your registration with the <strong>Student Financial Assistance System</strong> has been '
                . '<strong>approved by the CSDL office</strong>. You may now sign in using your School ID and the password you created during registration.'
            ))
            . self::renderHighlightBox(
                '<div style="text-align:center;">'
                . '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">School ID</div>'
                . '<div style="font-size:20px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $safeSchoolId . '</div>'
                . '</div>'
            )
            . self::renderButton($safeLoginUrl, 'Sign In to Your Account')
            . self::renderNoticeBox(
                'The Assessment office is setting up your student balance record. '
                . '<strong>You cannot apply for a loan until your balance is ready.</strong> '
                . 'You can continue using your account while you wait.',
                'info'
            )
            . self::renderParagraph(
                'We will notify you when Assessment completes your balance setup.'
            );

        return self::renderEmailShell(
            'Registration Update',
            $content,
            $appName,
            $supportEmail,
            'CSDL approved your registration. You can now sign in while Assessment sets up your balance.',
            $logoCid
        );
    }

    public static function studentRegistrationApprovedEmail(
        string $recipientName,
        string $schoolId,
        string $appName = 'Student Financial Assistance System',
        string $supportEmail = 'support@csdl.edu',
        ?string $loginUrl = null,
        ?string $logoCid = null,
        ?string $customMessage = null
    ): string {
        $safeName = self::escape($recipientName ?: 'Student');
        $safeSchoolId = self::escape($schoolId);
        $loginUrl = $loginUrl ?: self::resolveLoginUrl();
        $safeLoginUrl = self::escape($loginUrl);

        $content = self::renderGreeting($safeName)
            . self::renderParagraph($customMessage ?? (
                'Assessment has completed your balance setup in the <strong>Student Financial Assistance System</strong>. '
                . 'You may now apply for a loan, subject to the normal eligibility requirements and available application periods.'
            ))
            . self::renderHighlightBox(
                '<div style="text-align:center;">'
                . '<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Your School ID</div>'
                . '<div style="font-size:20px;font-weight:700;color:' . self::COLOR_PRIMARY . ';">' . $safeSchoolId . '</div>'
                . '<div style="margin-top:8px;font-size:13px;color:#4b5563;">Sign in using your School ID and the password you created during registration.</div>'
                . '</div>'
            )
            . self::renderButton($safeLoginUrl, 'Sign In to Your Account')
            . self::renderParagraph(
                'If the button above does not work, copy and paste this link into your browser:<br>'
                . '<a href="' . $safeLoginUrl . '" style="color:' . self::COLOR_PRIMARY_LIGHT . ';word-break:break-all;">' . $safeLoginUrl . '</a>'
            )
            . self::renderNoticeBox(
                'For your security, never share your password with anyone. '
                . 'If you experience difficulty signing in, contact the CSDL office for assistance.',
                'info'
            );

        return self::renderEmailShell(
            'Balance Setup Completed',
            $content,
            $appName,
            $supportEmail,
            'Your student balance is ready. Sign in to view your balance and available loan applications.',
            $logoCid
        );
    }

    private static function renderEmailShell(
        string $title,
        string $content,
        string $appName,
        string $supportEmail,
        ?string $preheader = null,
        ?string $logoCid = null
    ): string {
        $safeApp = self::escape($appName);
        $safeTitle = self::escape($title);
        $safeSchool = self::escape(self::SCHOOL_NAME);
        $preheaderHtml = $preheader
            ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">' . self::escape($preheader) . '</div>'
            : '';

        return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<meta http-equiv="X-UA-Compatible" content="IE=edge">'
            . '<title>' . $safeApp . ' &ndash; ' . $safeTitle . '</title></head>'
            . '<body style="margin:0;padding:0;background:#eef2ef;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;-webkit-text-size-adjust:100%;">'
            . $preheaderHtml
            . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#eef2ef;padding:32px 16px;">'
            . '<tr><td align="center">'
            . '<table role="presentation" cellpadding="0" cellspacing="0" width="640" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d1e7d4;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(3,96,15,0.08);">'
            . self::renderHeader($safeApp, $safeTitle, $logoCid)
            . '<tr><td style="padding:32px 32px 8px;">' . $content . '</td></tr>'
            . self::renderFooter($safeApp, $supportEmail, $safeSchool)
            . '</table>'
            . '</td></tr></table>'
            . '</body></html>';
    }

    private static function renderHeader(string $appName, string $pageTitle, ?string $logoCid = null): string
    {
        $logoSrc = self::schoolLogoUrl() ?? ($logoCid ? 'cid:' . $logoCid : null);
        $logoHtml = $logoSrc
            ? '<td width="166" valign="middle" style="width:166px;padding-right:16px;">'
                . '<img src="' . self::escape($logoSrc) . '" width="150" height="69" alt="Student Financial Assistance System" style="display:block;width:150px;height:69px;border:0;outline:none;text-decoration:none;">'
                . '</td>'
            : '';

        return '<tr>'
            . '<td style="background:linear-gradient(135deg,' . self::COLOR_PRIMARY . ' 0%,' . self::COLOR_PRIMARY_LIGHT . ' 100%);padding:28px 32px 24px;">'
            . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>'
            . $logoHtml
            . '<td valign="middle">'
            . '<div style="font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,0.88);margin-bottom:6px;">'
            . self::escape(self::SCHOOL_NAME)
            . '</div>'
            . '<div style="font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">' . $appName . '</div>'
            . '</td></tr></table>'
            . '</td>'
            . '</tr>'
            . '<tr><td style="height:4px;background:linear-gradient(90deg,' . self::COLOR_GOLD . ' 0%,#e8c547 50%,' . self::COLOR_GOLD . ' 100%);"></td></tr>'
            . '<tr>'
            . '<td style="padding:18px 32px 0;">'
            . '<div style="display:inline-block;background:#f2fff4;border:1px solid #bbf7d0;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:600;color:' . self::COLOR_PRIMARY . ';letter-spacing:0.3px;">'
            . $pageTitle
            . '</div>'
            . '</td>'
            . '</tr>';
    }

    private static function renderFooter(string $appName, string $supportEmail, string $schoolName): string
    {
        $year = date('Y');
        $supportBlock = $supportEmail !== ''
            ? '<div style="margin-top:8px;font-size:12px;color:#6b7280;">'
            . 'For assistance, contact <a href="mailto:' . self::escape($supportEmail) . '" style="color:' . self::COLOR_PRIMARY_LIGHT . ';text-decoration:none;font-weight:600;">'
            . self::escape($supportEmail) . '</a>'
            . '</div>'
            : '';

        return '<tr>'
            . '<td style="background:#f8faf8;border-top:1px solid #e5ebe6;padding:22px 32px 26px;text-align:center;">'
            . '<div style="font-size:12px;color:#6b7280;">' . $schoolName . '</div>'
            . $supportBlock
            . '<div style="margin-top:14px;font-size:11px;color:#9ca3af;line-height:1.6;">'
            . '&copy; ' . $year . ' ' . $appName . '. All rights reserved.<br>'
            . 'This is an automated message. Please do not reply directly to this email.'
            . '</div>'
            . '</td>'
            . '</tr>';
    }

    private static function renderGreeting(string $safeName): string
    {
        return '<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1f2937;">Dear <strong>' . $safeName . '</strong>,</p>';
    }

    private static function renderParagraph(string $html): string
    {
        return '<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">' . $html . '</p>';
    }

    private static function renderOtpBox(string $safeOtp): string
    {
        return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:8px 0 20px;">'
            . '<tr><td align="center">'
            . '<div style="display:inline-block;background:#f2fff4;border:2px solid #86efac;border-radius:12px;padding:18px 28px;min-width:180px;">'
            . '<div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin-bottom:8px;">One-Time Password</div>'
            . '<div style="font-size:32px;font-weight:700;letter-spacing:6px;color:' . self::COLOR_PRIMARY . ';font-family:Consolas,Monaco,monospace;">'
            . $safeOtp
            . '</div>'
            . '</div>'
            . '</td></tr></table>';
    }

    private static function renderHighlightBox(string $html): string
    {
        return '<div style="background:#f2fff4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 18px;margin:0 0 18px;">'
            . $html
            . '</div>';
    }

    private static function renderNoticeBox(string $html, string $variant = 'info'): string
    {
        $styles = [
            'info' => ['bg' => '#eff6ff', 'border' => '#bfdbfe', 'text' => '#1e40af'],
            'warning' => ['bg' => '#fffbeb', 'border' => '#fde68a', 'text' => '#92400e'],
        ];
        $style = $styles[$variant] ?? $styles['info'];

        return '<div style="background:' . $style['bg'] . ';border:1px solid ' . $style['border'] . ';border-radius:12px;padding:14px 16px;margin:0 0 18px;font-size:14px;line-height:1.7;color:' . $style['text'] . ';">'
            . $html
            . '</div>';
    }

    private static function renderStatusCard(array $config): string
    {
        $color = self::escape($config['color'] ?? self::COLOR_PRIMARY);
        $bg = self::escape($config['bg'] ?? '#f2fff4');
        $border = self::escape($config['border'] ?? '#bbf7d0');
        $badge = self::escape($config['badge'] ?? 'Update');
        $title = self::escape($config['title'] ?? 'Status Update');

        return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;">'
            . '<tr><td align="center">'
            . '<div style="display:inline-block;background:' . $bg . ';border:2px solid ' . $border . ';border-radius:14px;padding:18px 28px;min-width:240px;text-align:center;">'
            . '<div style="display:inline-block;background:' . $color . ';color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;padding:5px 12px;border-radius:999px;margin-bottom:10px;">'
            . $badge
            . '</div>'
            . '<div style="font-size:18px;font-weight:700;color:' . $color . ';line-height:1.4;">' . $title . '</div>'
            . '</div>'
            . '</td></tr></table>';
    }

    private static function renderSection(string $title, string $content): string
    {
        return '<div style="margin:0 0 18px;border:1px solid #e5ebe6;border-radius:12px;overflow:hidden;">'
            . '<div style="background:linear-gradient(135deg,' . self::COLOR_PRIMARY . ' 0%,' . self::COLOR_PRIMARY_LIGHT . ' 100%);padding:10px 16px;">'
            . '<div style="font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.4px;text-transform:uppercase;">'
            . self::escape($title)
            . '</div>'
            . '</div>'
            . '<div style="padding:14px 16px;background:#ffffff;">'
            . $content
            . '</div>'
            . '</div>';
    }

    private static function renderKeyValueGrid(array $rows): string
    {
        $html = '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">';

        foreach ($rows as $index => $row) {
            if (!is_array($row) || count($row) < 2) {
                continue;
            }
            [$label, $value] = $row;
            $borderTop = $index > 0 ? 'border-top:1px solid #eef2ef;' : '';
            $html .= '<tr>'
                . '<td style="padding:10px 12px 10px 0;' . $borderTop . 'vertical-align:top;width:42%;font-size:13px;font-weight:600;color:#6b7280;">'
                . self::escape((string) $label)
                . '</td>'
                . '<td style="padding:10px 0;' . $borderTop . 'vertical-align:top;font-size:14px;color:#1f2937;line-height:1.5;">'
                . self::escape((string) $value)
                . '</td>'
                . '</tr>';
        }

        return $html . '</table>';
    }

    private static function renderButton(string $safeUrl, string $label): string
    {
        return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;">'
            . '<tr><td align="center">'
            . '<a href="' . $safeUrl . '" style="display:inline-block;background:linear-gradient(135deg,' . self::COLOR_PRIMARY . ' 0%,' . self::COLOR_PRIMARY_LIGHT . ' 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;box-shadow:0 4px 12px rgba(3,96,15,0.25);">'
            . self::escape($label)
            . '</a>'
            . '</td></tr></table>';
    }

    private static function escape(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
    }

    private static function resolveLoginUrl(): string
    {
        $configured = trim((string) ($_ENV['APP_URL'] ?? ''));
        if ($configured !== '') {
            $base = rtrim($configured, '/');
            $lower = strtolower($base);
            if (str_ends_with($lower, 'login.html')) {
                return $base;
            }
            if (str_ends_with($lower, '/views/auth')) {
                return $base . '/login.html';
            }
            return $base . '/views/auth/login.html';
        }

        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
        $basePath = '';
        $apiPos = strpos($script, '/api/');
        if ($apiPos !== false) {
            $basePath = substr($script, 0, $apiPos);
        }

        return $scheme . '://' . $host . $basePath . '/views/auth/login.html';
    }
}
