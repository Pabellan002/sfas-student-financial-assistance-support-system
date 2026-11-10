<?php

/** Answers about the current student flows. Keep these aligned with the registration and loan forms. */
function getFAQResponses(string $question, ?array $student, array $recentLoans): string
{
    $q = strtolower(trim($question));

    if (preg_match('/^(hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/', $q)) {
        $name = trim((string) ($student['student_first_name'] ?? '')) ?: 'there';
        return "Hi, {$name}! I can help with registration, applying for a loan, requirements, your loan status, and payments. What would you like to know?";
    }

    if (preg_match('/\b(register|registration|sign\s?up|create (an? )?account|make (an? )?account|new account)\b/', $q)) {
        return "**How to register a student account**\n\n"
            . "1. On the sign-in page, choose Register. Upload a clear photo of your school ID so the system can scan and review it.\n"
            . "2. Complete your personal, academic, and contact details, then create a password. Add at least one parent or guardian with a full name and contact number.\n"
            . "3. Submit the form and wait for CSDL to review your registration. You can sign in after CSDL approves it.\n"
            . "4. Assessment must set up your balance before you can apply for a loan. You may still use your account while waiting for the balance.\n\n"
            . "If your School ID is already registered or pending, contact CSDL instead of creating another account.";
    }

    if (preg_match('/\b(how (?:do|can) i (?:log|sign) in|log ?in|sign ?in|forgot (?:my )?password)\b/', $q)) {
        return "After CSDL approves your registration, use your School ID and password on the sign-in page. "
            . "If you forgot the password, use the password-recovery option there. If your registration is still pending, wait for CSDL review or contact the office.";
    }

    if (preg_match('/\b(reapply|re-apply|returned|resubmit|edit (my |the )?application)\b/', $q)) {
        return "**Returned loan application**\n\n"
            . "Open Loans, find the returned application, and choose Reapply Loan. Review the feedback, correct the form and required ID, then submit again. "
            . "The original application period stays the same. If the action is unavailable, contact CSDL.";
    }

    if (preg_match('/\b(requirements?|documents?|valid id|guardian id|parent id|what do i need)\b/', $q)) {
        return "**What you need to apply**\n\n"
            . "An approved student account with a balance set up by Assessment; an available application period; your reason for applying; "
            . "the amount you can pay; an intended payment date within 30 days; and a saved parent or guardian with a contact number. "
            . "Select the ID document type shown in the form and upload a clear valid parent/guardian ID with a signature. "
            . "The form shows the currently accepted document types. You must also agree to the personal-data consent before submitting.";
    }

    if (preg_match('/\b(pn(?:\s|-)*(?:tagging|tag|status)?|promissory note|who approves|approval (?:process|workflow)|which office|what happens after.*(?:approv\w*|pay\w*)|after (?:the )?payment)\b/', $q)) {
        return "**Approval, payment, and PN tagging**\n\n"
            . "After the responsible office approves your loan, Cashier confirms your payment.\n\n"
            . "• If CSDL approved the loan directly, it returns to CSDL for PN tagging.\n"
            . "• If Assessment, Branch Admin, or COO approved it, it goes to Assessment for PN tagging.\n"
            . "• The assigned office tags the promissory note after payment is confirmed, then the application becomes Completed.\n\n"
            . "Open Loans for your current office and status. Use Chat to ask the loan office about your application; Ask SFAS AI provides guidance and does not approve loans or record payments.";
    }

    if (preg_match('/\b(chat|message (?:the |an? )?office|talk to (?:the )?(?:office|staff))\b/', $q)) {
        return "Open Chat, select your loan conversation and the available office, then write your message. "
            . "Those messages go to the loan office. Ask SFAS AI is a separate help assistant; its messages are not sent to staff. "
            . "You can use the floating AI icon on Dashboard, Loans, or Chat for general instructions.";
    }

    if (preg_match('/\b(status|track|progress|pending|approved|declined|rejected|where is|what happened to)\b/', $q)
        && preg_match('/\b(loan|application|status|track)\b/', $q)) {
        if (!$recentLoans) {
            return "I don't see a recent loan application on your account. Open Loans to check the full list, or use Apply on your dashboard to start one if you are eligible.";
        }
        $answer = "**Your recent loan applications**\n\n";
        foreach ($recentLoans as $loan) {
            $number = (string) ($loan['loan_application_no'] ?? '');
            $status = (string) ($loan['status_name'] ?? 'Unknown');
            $answer .= "• {$number}: {$status}\n";
        }
        return $answer . "\nOpen Loans for the latest details and any action you need to take.";
    }

    if (preg_match('/\b(why (?:can(?:not| not|\x27t|t) i|am i (?:not )?able to) apply|cannot apply|can not apply|can\x27t apply|cant apply|unable to apply|not eligible|awaiting balance|no balance|balance setup)\b/', $q)) {
        return "You can sign in after CSDL approves your registration, but applying for a loan also requires Assessment to set up your balance. "
            . "The Apply button and form will show your current eligibility. If your balance is already available but you still cannot apply, contact CSDL.";
    }

    if (preg_match('/\b(my balance|current balance|how much (?:is|do i owe)|balance amount)\b/', $q)) {
        return "Use Balance on your dashboard to see your current balance record. I can't verify the latest amount from this chat; Assessment can help if the displayed balance looks wrong.";
    }

    if (preg_match('/\b(how (?:do|can) i apply|how to apply|apply for (?:a |the )?loan|loan application steps|loan steps|steps (?:on|for|to).*loan|application process|start (?:a |my )?loan|apply)\b/', $q)) {
        return "**How to apply for a student loan**\n\n"
            . "1. Sign in after CSDL approves your account. Wait for Assessment to set up your balance if the dashboard says Awaiting Balance.\n"
            . "2. On your dashboard, choose Apply. Read the instructions and agree to the personal-data consent.\n"
            . "3. Select an available application period. Check your prefilled student and balance details, then enter your reason, the amount you can pay, and a payment date within 30 days.\n"
            . "4. Select a saved parent or guardian. Check the name and contact number; you can correct the contact number in the form.\n"
            . "5. Select the document type, upload and scan a clear valid ID with the guardian's signature, then submit.\n\n"
            . "Use Loans to follow the application and respond if it is returned.";
    }

    if (preg_match('/\b(application period|when (?:can|should|do) i apply|periods? available|office hours|is (?:the )?application open)\b/', $q)) {
        return "The application form shows the periods currently available to you. Periods may be opened for all students or granted to you individually. "
            . "The loan form describes the usual window as one week before a periodic examination during office hours. "
            . "If no period is available, check again later or ask CSDL.";
    }

    if (preg_match('/\b(maximum|max amount|loan limit|how much (?:can|may) i (?:borrow|loan)|3,?000)\b/', $q)) {
        return "The loan form lists ₱3,000 as the usual limit; an amount above that needs Controller or COO approval. "
            . "The amount you enter is what you can pay, and it is subject to review. The form shows the current minimum amount. Your approved amount depends on your balance and review.";
    }

    if (preg_match('/\b(payment|pay back|repay|due date|when to pay|promised date|intend to pay)\b/', $q)) {
        return "In the application, choose the date when you intend to pay your balance. The form accepts a date from today through 30 calendar days after you apply. "
            . "Check Loans and your official notifications for the approved terms and any payment status.";
    }

    if (preg_match('/\b(how long|processing time|verification|wait time|1-2 days)\b/', $q)) {
        return "The loan form advises allowing about 1–2 days for verification, but actual review time may vary. "
            . "Check Loans for your current status and any returned application; contact CSDL if you need an update.";
    }

    if (preg_match('/\b(interest|charges?|fees?|cost)\b/', $q)) {
        return "The loan form describes the student loan as interest-free. Check your application and official notices for the terms that apply to you.";
    }

    if (preg_match('/\b(help|support|contact|assistance|problem|issue|error)\b/', $q)) {
        return "I can explain registration, loan applications, requirements, status, and payments. For an account-specific issue or a blocked application, contact the CSDL office and include the message shown on your screen.";
    }

    return '';
}
