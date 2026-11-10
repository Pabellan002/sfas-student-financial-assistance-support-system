export function pickLoanPromisedAmount(loan) {
    if (!loan) return 0;
    return parseFloat(
        loan.loan_promised_amount
        ?? loan.promisedAmount
        ?? loan.loan_amount_can_pay
        ?? loan.amount
        ?? 0
    );
}

export function formatPeso(amount) {
    const num = parseFloat(amount || 0);
    return `₱${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function fetchPromisedAmount(apiPath, loanId) {
    const res = await fetch(`../../api/${apiPath}?action=details&loanId=${encodeURIComponent(loanId)}`, {
        credentials: 'same-origin',
        cache: 'no-store'
    });
    const json = await res.json();
    if (!json.success || !json.loan) return 0;
    return pickLoanPromisedAmount(json.loan);
}

export async function setApproveAmountDisplay({
    loanId,
    loans = [],
    apiPath,
    show
}) {
    const container = document.getElementById('amountApprovedContainer');
    const display = document.getElementById('amountApprovedDisplay');
    const hidden = document.getElementById('amountApproved');
    if (!container || !display || !hidden) return;

    if (!show) {
        container.style.display = 'none';
        hidden.value = '';
        display.textContent = '—';
        return;
    }

    container.style.display = 'block';
    const match = loans.find((loan) => String(loan.loan_id || loan.loanId) === String(loanId));
    let amount = pickLoanPromisedAmount(match);
    if (amount <= 0 && apiPath) {
        amount = await fetchPromisedAmount(apiPath, loanId);
    }
    display.textContent = formatPeso(amount);
    hidden.value = amount > 0 ? amount.toFixed(2) : '';
}
