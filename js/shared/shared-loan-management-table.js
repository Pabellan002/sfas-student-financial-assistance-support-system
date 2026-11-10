/**
 * Shared loan management table columns for staff portals.
 * Application No. | Student Name | Total Balance | Advised to Pay | Amount Can Pay | Due Date | Status | Timestamp | Actions
 * Timestamp column shows live expiry countdown.
 */

export const LOAN_MGMT_TABLE_COLSPAN = 9;
export const CSDL_LOAN_MGMT_TABLE_COLSPAN = 12;
export const ASSESSMENT_LOAN_MGMT_TABLE_COLSPAN = 11;
export const BRANCH_ADMIN_LOAN_MGMT_TABLE_COLSPAN = 10;

export function getLoanMgmtRowId(loan) {
    return loan.loan_id || loan.loanId || loan.id || '';
}

export function getLoanMgmtExpiryTimestamp(loan) {
    return loan.expiryTimestamp || loan.loan_expiry_timestamp || null;
}

export function getLoanMgmtCountdownElementId(loan) {
    const rowId = getLoanMgmtRowId(loan);
    return rowId ? `countdown-${rowId}` : '';
}

export function fmtLoanMgmtPeso(val) {
    if (val === null || val === undefined || val === '') return '-';
    const num = Number(val);
    if (Number.isNaN(num)) return '-';
    return '₱' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtLoanMgmtDate(val) {
    if (!val) return '-';
    try {
        return new Date(val).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return String(val);
    }
}

/** Plain-text countdown for exports (no HTML badges). */
export function formatLoanMgmtCountdownPlain(expiryTimestamp) {
    if (!expiryTimestamp) return '-';
    const expiry = new Date(expiryTimestamp);
    const now = new Date();
    const diff = expiry - now;
    if (Number.isNaN(diff)) return '-';

    const absDiff = Math.abs(diff);
    const days = Math.floor(absDiff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((absDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((absDiff % (1000 * 60)) / 1000);
    const prefix = diff <= 0 ? '-' : '';

    if (diff <= 0 && absDiff < 1000) return 'Overdue -0s';

    if (days > 0) return `${prefix}${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${prefix}${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${prefix}${minutes}m ${seconds}s`;
    return `${prefix}${seconds}s`;
}

/** Keep the overdue popup's countdowns live until the popup closes. */
export function startLoanMgmtModalCountdowns(modalElement, tbody, expiryTimestamps, formatCountdown) {
    const cells = tbody.querySelectorAll('[data-loan-countdown]');
    if (!modalElement || !cells.length) return () => {};

    const update = () => cells.forEach((cell, index) => {
        cell.innerHTML = formatCountdown(expiryTimestamps[index]);
    });
    update();
    const intervalId = setInterval(update, 1000);
    const stop = () => {
        clearInterval(intervalId);
        modalElement.removeEventListener('hidden.bs.modal', stop);
    };
    modalElement.addEventListener('hidden.bs.modal', stop);
    return stop;
}

export function buildLoanMgmtTableRowHtml({
    loan,
    escapeHtml,
    statusHtml,
    actionsHtml,
    actionsCellClass = '',
    formatCountdown = null,
    columnPreset = 'default',
    paymentStatusHtml = '<span class="badge bg-secondary">Not Paid</span>',
    pnStatusHtml = '<span class="badge bg-secondary">Not Set</span>',
}) {
    const applicationNo = loan.applicationNo || loan.loan_application_no || '-';
    const studentId = loan.schoolId || loan.student_school_id || '-';
    const studentName = loan.name || loan.student_name || '-';
    const totalBalance = loan.balance_total_balance ?? loan.balanceTotalBalance ?? null;
    const advisedToPay = loan.balance_advice_to_pay ?? loan.balanceAdviceToPay ?? null;
    const amountCanPay = loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount ?? null;
    const amountPaid = loan.recordedPaymentAmount ?? loan.loan_recorded_payment_amount ?? null;
    const dueDate = loan.dueDate || loan.loan_due_date || loan.dateDue;
    const expiry = getLoanMgmtExpiryTimestamp(loan);
    const countdownId = getLoanMgmtCountdownElementId(loan);

    const actionsClass = actionsCellClass ? ` ${actionsCellClass}` : '';
    let timestampCell = '<td class="text-center" data-label="Timestamp">-</td>';
    if (formatCountdown && expiry && countdownId) {
        timestampCell = `<td class="text-center" id="${countdownId}" data-label="Timestamp">${formatCountdown(expiry)}</td>`;
    }

    if (columnPreset === 'assessment') {
        return `
            <td class="text-center" data-label="Application No.">${escapeHtml(String(applicationNo))}</td>
            <td class="text-center" data-label="Student Name">${escapeHtml(String(studentName))}</td>
            <td class="text-center" data-label="Total Balance">${fmtLoanMgmtPeso(totalBalance)}</td>
            <td class="text-center" data-label="Advised to Pay">${fmtLoanMgmtPeso(advisedToPay)}</td>
            <td class="text-center" data-label="Amount Can Pay">${fmtLoanMgmtPeso(amountCanPay)}</td>
            <td class="text-center" data-label="Due Date">${fmtLoanMgmtDate(dueDate)}</td>
            <td class="text-center" data-label="Status">${statusHtml}</td>
            <td class="text-center" data-label="Payment Status">${paymentStatusHtml}</td>
            <td class="text-center" data-label="PN Status">${pnStatusHtml}</td>
            ${timestampCell}
            <td class="text-center${actionsClass}" data-label="Actions">${actionsHtml}</td>
        `;
    }

    if (columnPreset === 'branch-admin') {
        return `
            <td class="text-center" data-label="Application No.">${escapeHtml(String(applicationNo))}</td>
            <td class="text-center" data-label="Student ID">${escapeHtml(String(studentId))}</td>
            <td class="text-center" data-label="Student Name">${escapeHtml(String(studentName))}</td>
            <td class="text-center" data-label="Amount Can Pay">${fmtLoanMgmtPeso(amountCanPay)}</td>
            <td class="text-center" data-label="Status">${statusHtml}</td>
            <td class="text-center" data-label="Payment Status">${paymentStatusHtml}</td>
            <td class="text-center" data-label="PN Status">${pnStatusHtml}</td>
            <td class="text-center" data-label="Due Date">${fmtLoanMgmtDate(dueDate)}</td>
            ${timestampCell}
            <td class="text-center${actionsClass}" data-label="Actions">${actionsHtml}</td>
        `;
    }

    if (columnPreset === 'csdl') {
        return `
            <td class="text-center" data-label="Application No.">${escapeHtml(String(applicationNo))}</td>
            <td class="text-center" data-label="Student Name">${escapeHtml(String(studentName))}</td>
            <td class="text-center" data-label="Total Balance">${fmtLoanMgmtPeso(totalBalance)}</td>
            <td class="text-center" data-label="Advised to Pay">${fmtLoanMgmtPeso(advisedToPay)}</td>
            <td class="text-center" data-label="Amount Can Pay">${fmtLoanMgmtPeso(amountCanPay)}</td>
            <td class="text-center" data-label="Amount Paid">${fmtLoanMgmtPeso(amountPaid)}</td>
            <td class="text-center" data-label="Due Date">${fmtLoanMgmtDate(dueDate)}</td>
            <td class="text-center" data-label="Status">${statusHtml}</td>
            <td class="text-center" data-label="Payment Status">${paymentStatusHtml}</td>
            <td class="text-center" data-label="PN Status">${pnStatusHtml}</td>
            ${timestampCell}
            <td class="text-center${actionsClass}" data-label="Actions">${actionsHtml}</td>
        `;
    }

    return `
        <td class="text-center" data-label="Application No.">${escapeHtml(String(applicationNo))}</td>
        <td class="text-center" data-label="Student Name">${escapeHtml(String(studentName))}</td>
        <td class="text-center" data-label="Total Balance">${fmtLoanMgmtPeso(totalBalance)}</td>
        <td class="text-center" data-label="Advised to Pay">${fmtLoanMgmtPeso(advisedToPay)}</td>
        <td class="text-center" data-label="Amount Can Pay">${fmtLoanMgmtPeso(amountCanPay)}</td>
        <td class="text-center" data-label="Due Date">${fmtLoanMgmtDate(dueDate)}</td>
        <td class="text-center" data-label="Status">${statusHtml}</td>
        ${timestampCell}
        <td class="text-center${actionsClass}" data-label="Actions">${actionsHtml}</td>
    `;
}

export function mapLoanMgmtExportRow(loan, statusLabel, paymentStatusLabel = '', pnStatusLabel = '', columnPreset = 'default') {
    if (columnPreset === 'branch-admin') {
        return {
            'Application No.': loan.applicationNo || loan.loan_application_no || '',
            'Student ID': loan.studentId || loan.schoolId || loan.student_school_id || '',
            'Student Name': loan.studentName || loan.name || loan.student_name || '',
            'Amount Can Pay': fmtLoanMgmtPeso(loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount).replace(/^₱/, '') || '0.00',
            Status: statusLabel || loan.statusName || loan.loan_status_name || '',
            'Payment Status': paymentStatusLabel || loan.payment_status || loan.payment_status_name || '',
            'PN Status': pnStatusLabel || loan.pn_status || loan.pn_status_name || '',
            'Due Date': fmtLoanMgmtDate(loan.dueDate || loan.loan_due_date || loan.dateDue),
            Timestamp: formatLoanMgmtCountdownPlain(getLoanMgmtExpiryTimestamp(loan)),
        };
    }

    const row = {
        'Application No.': loan.applicationNo || loan.loan_application_no || '',
        'Student Name': loan.name || loan.student_name || '',
        'Total Balance': fmtLoanMgmtPeso(loan.balance_total_balance ?? loan.balanceTotalBalance).replace(/^₱/, '') || '0.00',
        'Advised to Pay': fmtLoanMgmtPeso(loan.balance_advice_to_pay ?? loan.balanceAdviceToPay).replace(/^₱/, '') || '0.00',
        'Amount Can Pay': fmtLoanMgmtPeso(loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount).replace(/^₱/, '') || '0.00',
        'Due Date': fmtLoanMgmtDate(loan.dueDate || loan.loan_due_date || loan.dateDue),
        Status: statusLabel || loan.statusName || loan.loan_status_name || '',
        Timestamp: formatLoanMgmtCountdownPlain(getLoanMgmtExpiryTimestamp(loan)),
    };

    if (paymentStatusLabel || pnStatusLabel) {
        row['Payment Status'] = paymentStatusLabel || loan.payment_status || loan.payment_status_name || '';
        row['PN Status'] = pnStatusLabel || loan.pn_status || loan.pn_status_name || '';
    }

    return row;
}

