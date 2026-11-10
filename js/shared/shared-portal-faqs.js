import { escapeHtml } from './shared-escape.js';

export const STUDENT_PORTAL_FAQS = [
    {
        id: 'faq1',
        question: 'What is the Student Financial Assistance System?',
        answer: 'The Student Financial Assistance System is an online platform for PHINMA COC students to apply for interest-free financial assistance to secure examination permits on time or request forward balance during enrollment. This system streamlines the application process and allows you to track your application status.'
    },
    {
        id: 'faq2',
        question: 'What is student financial assistance?',
        answer: 'Student financial assistance is a program offered to PHINMA COC students that could not pay their balances on time. This program allows students to pay a portion or partial of their balances in order to get an exam permit on time or forward their balances to the next semester.'
    },
    {
        id: 'faq3',
        question: 'Who can apply for student financial assistance?',
        answer: 'All COC students can apply for student financial assistance. You must be an enrolled student with a valid School ID to use this system.'
    },
    {
        id: 'faq4',
        question: 'When can I apply for a loan?',
        answer: 'The application is made available two (2) weeks prior to the periodical examination; and during regular office hours: Monday - Friday: 7:30 AM - 5:00 PM; Saturday: 8:00 AM - 12:00 NN. However, the system remains accessible at any time.'
    },
    {
        id: 'faq5',
        question: 'What are the levels of student loan approvals?',
        answer: 'Student loan applications with an outstanding balance of ₱3,000 or less, after partial payment, will be reviewed and approved by CSDL. Applications with balances exceeding ₱3,000 but not more than ₱7,500 will be forwarded to the Finance Assessment team for evaluation and approval. Those with balances above ₱7,500 will be endorsed to the Chief Operating Officer (COO) for final approval.'
    },
    {
        id: 'faq6',
        question: 'What documents do I need to submit?',
        answer: 'You must attach/submit one (1) valid ID of your parent/guardian with signature. The ID should be clear and valid. Accepted valid IDs are: (1) PhilSys or National ID card, (2) printed PhilSys ID, (3) UMID, (4) GSIS, (5) passport, (6) Postal ID, (7) PRC ID, (8) Senior Citizen ID, (9) OFW ID, (10) Voter\'s ID, and (11) NBI Clearance.'
    },
    {
        id: 'faq7',
        question: 'How long does the verification process take?',
        answer: 'The verification process typically takes 1-2 days. You will receive a status update via your PHINMAEd Email Account, or you may receive a call/text from the CSDL, Finance, or COO\'s Office regarding your application.'
    },
    {
        id: 'faq8',
        question: 'When do I need to pay back the loan?',
        answer: 'Approved loan amounts must be paid on or before the due date, which is typically within 30 days from the approval date. The exact due date will be specified in your loan approval notification and shown on your dashboard calendar.'
    },
    {
        id: 'faq9',
        question: 'What happens if my loan application is declined?',
        answer: 'If your loan application is declined, you will receive a notification with the reason for the decline. You can review the feedback and may reapply if needed, ensuring you address the issues mentioned in the decline notice.'
    },
    {
        id: 'faq10',
        question: 'What does it mean if my loan is "Returned"?',
        answer: 'A "Returned" status means your application has been sent back to you for changes or corrections. You can review the feedback, make necessary adjustments, and resubmit your application through the reapply function.'
    },
    {
        id: 'faq11',
        question: 'How do I check my loan application status?',
        answer: 'You can check your loan status from the Loans page in your student portal, or by using the Loan Status tab on the login page Quick Help panel.'
    },
    {
        id: 'faq12',
        question: 'Can I reapply if my loan was returned?',
        answer: 'Yes, you can reapply for a returned loan. The system will allow you to review and edit your application details before resubmitting. Note that you cannot change the application period when reapplying.'
    },
    {
        id: 'faq13',
        question: 'What is the difference between "Approved" and "Completed" status?',
        answer: '"Approved" refers to applications approved by the authorized approver. "Completed" refers to student loans that have been paid.'
    },
    {
        id: 'faq14',
        question: 'Is there any interest charged on the loan?',
        answer: 'No, this is an interest-free student loan program offered to students that are unable to pay on time. Students are encouraged to pay the remaining balance on or before the date specified.'
    },
    {
        id: 'faq15',
        question: 'What should I do if I forget my password?',
        answer: 'Click on the "Forgot Password?" link on the login page. You will be guided through the password recovery process. Make sure you have access to your registered email or contact the system administrator for assistance.'
    },
    {
        id: 'faq16',
        question: 'Can I apply for multiple loans?',
        answer: 'You can apply for a loan for each application period. However, you must ensure that any previous loans are paid or in good standing. The system will show your current loan status when you apply.'
    },
    {
        id: 'faq17',
        question: 'How do I update my profile and contact details?',
        answer: 'Go to Settings, open Profile & contact, update your birthdate, gender, contact number, or personal email, complete the security verification, then save. An OTP will be sent to your email to confirm the update.'
    },
    {
        id: 'faq18',
        question: 'What do Previous Balance, Current Balance, and Total Balance mean?',
        answer: 'Previous balance includes your previous semester and/or periodical balance. Current balance covers your periodical balance. Total balance is the sum of the previous and current balance. You can view definitions on the Balances page.'
    },
    {
        id: 'faq19',
        question: 'What is "Advised to Pay" on my loan?',
        answer: 'Advised to Pay is the amount recommended for you to pay based on your current balance and loan rules. Amount to Pay is the amount you entered or agreed to pay for that application.'
    },
    {
        id: 'faq20',
        question: 'Why do I need to complete security verification?',
        answer: 'Security verification (math captcha and OTP) protects your account from unauthorized changes when updating profile information or changing your password.'
    }
];

export const STAFF_PORTAL_FAQS = [
    {
        id: 'staff1',
        question: 'How do I update my contact information?',
        answer: 'Open Contact information in Settings, edit your contact number, email, birthdate, gender, or profile photo, complete the security verification, and save. You may need to verify an OTP sent to your registered email.'
    },
    {
        id: 'staff2',
        question: 'How do I change my password?',
        answer: 'Open Change password in Settings, enter your current password and new password, complete the security verification, and submit. Your new password must meet the listed requirements.'
    },
    {
        id: 'staff3',
        question: 'Why is OTP verification required?',
        answer: 'OTP verification helps protect your account when updating contact details or changing your password. The code is sent to your registered email address and expires after a short time.'
    },
    {
        id: 'staff4',
        question: 'What if I do not receive the OTP email?',
        answer: 'Check your spam or junk folder, wait for the resend timer, then use Resend Code if available. Confirm your email address is correct in Contact information. If the problem continues, contact your system administrator.'
    },
    {
        id: 'staff5',
        question: 'What are the password requirements?',
        answer: 'Your password must be at least 8 characters long and include an uppercase letter, a lowercase letter, a number, and a special character (!@#$%^&*...).'
    },
    {
        id: 'staff6',
        question: 'How do I review and process student loan applications?',
        answer: 'Open Active Loans from the sidebar to view pending and in-progress applications assigned to your role. Use filters and search to find applications, then open a record to review documents, update status, or add remarks.'
    },
    {
        id: 'staff7',
        question: 'What do loan statuses mean?',
        answer: 'Pending — awaiting review. Approved — authorized for release. Declined — not approved. Returned — sent back to the student for corrections. Endorsed — forwarded to the next approver. Completed — fully paid. Expired or Cancelled — no longer active.'
    },
    {
        id: 'staff8',
        question: 'How do notifications work?',
        answer: 'The bell icon in the top navigation shows system notifications such as new applications or status updates. Click Mark all read to clear unread items. Notifications help you stay updated on tasks that need attention.'
    },
    {
        id: 'staff9',
        question: 'Why was my session signed out automatically?',
        answer: 'For security, inactive sessions are ended after a configured timeout. Save your work regularly. If you are working on a shared computer, sign out manually when finished.'
    },
    {
        id: 'staff10',
        question: 'Who can access system configuration settings?',
        answer: 'Only users with the appropriate permissions can change system settings such as security rules, application periods, exam schedules, and form descriptions. Contact your administrator if you need access.'
    },
    {
        id: 'staff11',
        question: 'How do I view audit logs?',
        answer: 'CSDL administrators can open Audit logs under Settings to review user actions such as logins, profile updates, and record changes. Use filters to narrow results by action type, user, or date range.'
    },
    {
        id: 'staff12',
        question: 'What should I do if I cannot access a page or feature?',
        answer: 'Your role determines which modules you can use. If a menu item or action is missing, your account may not have the required permission. Contact your system administrator to request access.'
    }
];

export function renderFaqContent(container, faqs) {
    if (!container || !Array.isArray(faqs) || faqs.length === 0) {
        return;
    }

    if (container.children.length > 0) {
        return;
    }

    container.innerHTML = '';

    faqs.forEach((faq) => {
        const item = document.createElement('article');
        item.className = 'portal-settings-faq-entry';
        item.innerHTML = `
            <h6 class="portal-settings-faq-entry__question">${escapeHtml(faq.question)}</h6>
            <p class="portal-settings-faq-entry__answer mb-0">${escapeHtml(faq.answer)}</p>
        `;
        container.appendChild(item);
    });
}
