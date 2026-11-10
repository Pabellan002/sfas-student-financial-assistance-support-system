import { escapeHtml } from './shared-escape.js';
import { fetchPromisedAmount, formatPeso, pickLoanPromisedAmount } from './shared-loan-action-amount.js';
const QUICK_LOAN_REMARKS = Object.freeze({
    approve: 'Loan approved.',
    decline: 'Loan declined.',
    return: 'Loan returned for review.',
});

export function pickLoanStudentLabel(loan) {
    if (!loan) return 'Student';
    return loan.student_name || loan.studentName || loan.name || 'Student';
}

export function pickLoanApplicationNo(loan) {
    if (!loan) return '';
    return loan.loan_application_no || loan.applicationNo || '';
}

export function findLoanInList(loans, loanId) {
    const key = String(loanId ?? '');
    if (!key) return null;
    return (loans || []).find((loan) => String(loan.loan_id || loan.loanId || loan.id) === key) || null;
}

/**
 * One-step SweetAlert confirm for approve / decline / return (no modal, auto remarks).
 * Returns { amountApproved, remarks } or null if cancelled.
 */
export async function confirmQuickLoanProcess({
    loanId,
    actionType,
    loan = null,
    apiPath = '',
    loans = [],
    requireRemarks = false,
    remarksLabel = 'Return remarks',
} = {}) {
    const Swal = window.Swal;
    if (!Swal || !['approve', 'decline', 'return'].includes(actionType)) return null;

    const match = loan || findLoanInList(loans, loanId);
    let amount = pickLoanPromisedAmount(match);
    if (actionType === 'approve' && amount <= 0 && apiPath) {
        amount = await fetchPromisedAmount(apiPath, loanId);
    }
    if (actionType === 'approve' && amount <= 0) {
        await Swal.fire({
            icon: 'error',
            title: 'Amount unavailable',
            text: 'Could not determine the approved amount for this loan.',
            confirmButtonText: 'OK',
        });
        return null;
    }

    const studentName = match?.student_name || match?.studentName || 'Student';
    const appNo = match?.loan_application_no || match?.applicationNo || '';
    const subtitle = appNo ? `${studentName} · ${appNo}` : studentName;
    const remark = QUICK_LOAN_REMARKS[actionType];

    const titles = {
        approve: 'Approve Loan',
        decline: 'Decline Loan',
        return: 'Return Loan',
    };
    const confirmLabels = {
        approve: 'Approve',
        decline: 'Decline',
        return: 'Return',
    };
    const colors = {
        approve: '#198754',
        decline: '#dc3545',
        return: '#fd7e14',
    };

    let html = `
        <div class="loan-process-summary">
            <span class="loan-process-summary__label">Loan application</span>
            <strong class="loan-process-summary__student">${escapeHtml(subtitle)}</strong>`;
    if (actionType === 'approve') {
        html += `
            <div class="loan-process-summary__amount">
                <span>Approved amount</span>
                <strong>${formatPeso(amount)}</strong>
            </div>`;
    }
    html += '</div>';

    const result = await Swal.fire({
        title: titles[actionType],
        html,
        input: requireRemarks ? 'textarea' : undefined,
        inputLabel: requireRemarks ? remarksLabel : undefined,
        inputPlaceholder: requireRemarks ? 'Explain what the student needs to revise…' : undefined,
        inputAttributes: requireRemarks ? {
            'aria-label': remarksLabel,
            maxlength: '1000',
        } : undefined,
        inputValidator: requireRemarks ? (value) => {
            if (!String(value || '').trim()) {
                return 'Return remarks are required.';
            }
            return undefined;
        } : undefined,
        showCancelButton: true,
        confirmButtonText: confirmLabels[actionType],
        confirmButtonColor: colors[actionType],
        cancelButtonColor: '#6c757d',
        cancelButtonText: 'Cancel',
        buttonsStyling: true,
        customClass: {
            popup: 'loan-process-confirmation',
            confirmButton: 'loan-process-confirmation__confirm',
            cancelButton: 'loan-process-confirmation__cancel',
        },
    });

    if (!result.isConfirmed) return null;

    return {
        amountApproved: actionType === 'approve' ? amount.toFixed(2) : '',
        remarks: requireRemarks ? String(result.value || '').trim() : remark,
    };
}

export async function showLoanProcessSuccess(message = 'Loan processed successfully') {
    const Swal = window.Swal;
    if (!Swal) return;
    await Swal.fire({
        icon: 'success',
        title: 'Success',
        text: message,
        confirmButtonText: 'OK',
    });
}

export async function showLoanProcessError(error, fallback = 'Failed to process loan. Please try again.') {
    const Swal = window.Swal;
    if (!Swal) return;
    await Swal.fire({
        icon: 'error',
        title: 'Error',
        text: error?.message || fallback,
        confirmButtonText: 'OK',
    });
}
