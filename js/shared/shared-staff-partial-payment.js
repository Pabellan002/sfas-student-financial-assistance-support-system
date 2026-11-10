import ApiService from '../services/services-apiService.js';

export default class StaffPartialPaymentController {
    constructor({ apiPath, hasPermission, getLoans, onUpdated }) {
        this.apiPath = apiPath;
        this.hasPermission = hasPermission;
        this.getLoans = getLoans;
        this.onUpdated = onUpdated;
        this.bound = false;
        this.currentAmountCanPay = 0;
    }

    bind() {
        if (this.bound) return;
        this.bound = true;
        document.getElementById('submitPartialPaymentBtn')?.addEventListener('click', () => this.submit());
        document.getElementById('partialPaymentAmount')?.addEventListener('input', () => this.updateNewAmountPreview());
    }

    open(loanId) {
        if (!this.hasPermission() || !loanId) return;
        this.bind();
        const loan = this.getLoans().find((item) => Number(item.loan_id || item.loanId || item.id) === Number(loanId)) || {};
        const form = document.getElementById('partialPaymentForm');
        form?.reset();
        form?.classList.remove('was-validated');
        document.getElementById('partialPaymentLoanId').value = String(loanId);
        document.getElementById('partialPaymentStudent').textContent = loan.name || loan.student_name || loan.studentName || 'Student';
        document.getElementById('partialPaymentApplication').textContent = loan.applicationNo || loan.loan_application_no || '-';
        const amountCanPay = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount ?? 0);
        this.currentAmountCanPay = Number.isFinite(amountCanPay) ? amountCanPay : 0;
        document.getElementById('partialPaymentAmountCanPay').textContent = `₱${(Number.isFinite(amountCanPay) ? amountCanPay : 0).toLocaleString('en-PH', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
        const totalBalance = Number(loan.totalBalance ?? loan.balance_total_balance ?? 0);
        const amountInput = document.getElementById('partialPaymentAmount');
        if (amountInput) {
            if (Number.isFinite(totalBalance) && totalBalance > 0) {
                amountInput.max = Math.max(0, totalBalance - this.currentAmountCanPay).toFixed(2);
            } else {
                amountInput.removeAttribute('max');
            }
        }
        this.updateNewAmountPreview();
        const modal = document.getElementById('partialPaymentModal');
        if (modal) bootstrap.Modal.getOrCreateInstance(modal).show();
        window.setTimeout(() => document.getElementById('partialPaymentAmount')?.focus(), 250);
    }

    updateNewAmountPreview() {
        const additionalAmount = Number(document.getElementById('partialPaymentAmount')?.value || 0);
        const newAmount = this.currentAmountCanPay + (Number.isFinite(additionalAmount) && additionalAmount > 0 ? additionalAmount : 0);
        const preview = document.getElementById('partialPaymentNewAmount');
        if (preview) {
            preview.textContent = `₱${newAmount.toLocaleString('en-PH', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}`;
        }
    }

    async submit() {
        if (!this.hasPermission()) return;
        const form = document.getElementById('partialPaymentForm');
        const loanId = Number(document.getElementById('partialPaymentLoanId')?.value || 0);
        const amount = Number(document.getElementById('partialPaymentAmount')?.value || 0);
        if (!loanId || !(amount > 0) || !form?.checkValidity()) {
            form?.classList.add('was-validated');
            form?.reportValidity();
            return;
        }

        const button = document.getElementById('submitPartialPaymentBtn');
        if (button) button.disabled = true;
        try {
            const data = new FormData();
            data.append('action', 'process');
            data.append('loanId', String(loanId));
            data.append('processType', 'partial');
            data.append('partialPaymentAmount', amount.toFixed(2));
            const response = await ApiService.postFormData(this.apiPath, data);
            if (!response?.success) throw new Error(response?.message || 'Unable to save the additional partial amount.');
            bootstrap.Modal.getInstance(document.getElementById('partialPaymentModal'))?.hide();
            await this.onUpdated();
            await window.Swal?.fire({ icon: 'success', title: 'Partial Payment', text: response.message || 'Additional partial amount saved successfully.' });
        } catch (error) {
            window.Swal?.fire({ icon: 'error', title: 'Unable to submit partial payment', text: error.message || 'Please try again.' });
        } finally {
            if (button) button.disabled = false;
        }
    }
}
