import TurnstileWidget from '../../shared/shared-turnstile.js';
import ApiService from '../../services/services-apiService.js';

class ForgetPasswordModule {
    constructor() {
        this.requestForm = null;
        this.verifyForm = null;
        this.backBtn = null;
        this.stepRequest = null;
        this.stepVerify = null;
        this.schoolIdInput = null;
        this.emailInput = null;
        this.otpInput = null;
        this.newPassInput = null;
        this.confirmPassInput = null;
    }

    async init() {
        this.cache();
        this.requestTurnstile = new TurnstileWidget('forgotPasswordTurnstile', 'forgot_password');
        await this.loadCSRFToken();
        this.bind();
    }

    cache() {
        this.requestForm = document.getElementById('fpRequestForm');
        this.verifyForm = document.getElementById('fpVerifyForm');
        this.backBtn = document.getElementById('fpBackBtn');
        this.stepRequest = document.getElementById('fpStepRequest');
        this.stepVerify = document.getElementById('fpStepVerify');
        this.schoolIdInput = document.getElementById('fp_school_id');
        this.emailInput = null;
        this.otpInput = document.getElementById('fp_otp');
        this.newPassInput = document.getElementById('fp_new_password');
        this.confirmPassInput = document.getElementById('fp_confirm_password');
    }

    bind() {
        this.verifyForm?.querySelectorAll('[data-password-toggle]').forEach((button) => {
            button.addEventListener('click', () => {
                const input = document.getElementById(button.dataset.passwordToggle);
                if (!input) return;
                const visible = input.type === 'password';
                input.type = visible ? 'text' : 'password';
                button.setAttribute('aria-pressed', String(visible));
                const fieldName = input === this.newPassInput ? 'new password' : 'confirm password';
                button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${fieldName}`);
                button.querySelector('i').className = `bi ${visible ? 'bi-eye' : 'bi-eye-slash'}`;
            });
        });
        if (this.requestForm) {
            this.requestForm.addEventListener('submit', (e) => this.handleRequestOTP(e));
        }
        if (this.verifyForm) {
            this.verifyForm.addEventListener('submit', (e) => this.handleReset(e));
        }
        if (this.backBtn) {
            this.backBtn.addEventListener('click', () => this.showRequest());
        }
        if (this.otpInput) {
            this.otpInput.addEventListener('input', () => {
                this.otpInput.value = this.otpInput.value.replace(/\D/g, '').slice(0, 6);
            });
        }

    }

    async loadCSRFToken() {
        try {
            const basePath = ApiService.getBaseURL();
            const response = await axios.get(`${basePath}/includes/includes-csrf-endpoint.php?action=get_token`, {
                withCredentials: true
            });
            if (response.data?.success) {
                const metaTag = document.querySelector('meta[name="csrf-token"]');
                if (metaTag) {
                    metaTag.setAttribute('content', response.data.token);
                } else {
                    const meta = document.createElement('meta');
                    meta.name = 'csrf-token';
                    meta.content = response.data.token;
                    document.head.appendChild(meta);
                }
            }
        } catch (_) {}
    }

    async handleRequestOTP(e) {
        e.preventDefault();
        const school_id = this.schoolIdInput?.value.trim();
        if (!school_id) {
            this.showInfo('Please enter your School ID.');
            return;
        }
        // Show loading state
        const submitBtn = document.getElementById('fpSubmitBtn');
        const submitBtnText = document.getElementById('fpSubmitBtnText');
        const submitBtnSpinner = document.getElementById('fpSubmitBtnSpinner');
        
        if (submitBtn) submitBtn.disabled = true;
        if (submitBtnText) submitBtnText.classList.add('d-none');
        if (submitBtnSpinner) submitBtnSpinner.classList.remove('d-none');
        
        try {
            await ApiService.refreshCSRFToken();
            const res = await this.requestTurnstile.post('/auth/auth-forget-password.php', {
                action: 'request_otp',
                school_id
            });
            if (res.success) {
                this.showSuccess('OTP sent to your email. Please check your inbox/spam.');
                this.showVerify();
            } else {
                this.showError(res.message || 'Failed to send OTP.');
            }
        } catch (err) {
            this.showError(err.response?.data?.message || 'Failed to send OTP.');
        } finally {
            // Hide loading state
            if (submitBtn) submitBtn.disabled = false;
            if (submitBtnText) submitBtnText.classList.remove('d-none');
            if (submitBtnSpinner) submitBtnSpinner.classList.add('d-none');
        }
    }

    async handleReset(e) {
        e.preventDefault();
        const school_id = this.schoolIdInput?.value.trim();
        const otp = this.otpInput?.value.trim();
        const new_password = this.newPassInput?.value || '';
        const confirm_password = this.confirmPassInput?.value || '';
        if (!otp || otp.length !== 6) {
            this.showInfo('Please enter the 6-digit OTP.');
            return;
        }
        const policyErrors = this.validatePasswordPolicy(new_password);
        if (policyErrors.length) {
            this.showError('Password does not meet requirements:\n' + policyErrors.join('\n'));
            return;
        }
        if (new_password !== confirm_password) {
            this.showInfo('Passwords do not match.');
            return;
        }
        try {
            await ApiService.refreshCSRFToken();
            const res = await ApiService.post('/auth/auth-forget-password.php', {
                action: 'reset_password',
                school_id,
                otp,
                new_password
            });
            if (res.success) {
                await this.showSuccess('Password reset successful. Redirecting to login...');
                window.location.href = 'login.html';
            } else {
                this.showError(res.message || 'Failed to reset password.');
            }
        } catch (err) {
            this.showError(err.response?.data?.message || 'Failed to reset password.');
        }
    }

    showRequest() {
        this.stepRequest?.classList.remove('d-none');
        this.stepVerify?.classList.add('d-none');
    }

    showVerify() {
        this.stepRequest?.classList.add('d-none');
        this.stepVerify?.classList.remove('d-none');
        this.otpInput?.focus();
    }

    showSuccess(text) {
        if (window.Swal) {
            return Swal.fire({ icon: 'success', title: 'Success', text, confirmButtonColor: '#0a8f1b' });
        }
    }
    showError(text) {
        if (window.Swal) {
            Swal.fire({ icon: 'error', title: 'Error', text, confirmButtonColor: '#0a8f1b' });
        }
    }
    showInfo(text) {
        if (window.Swal) {
            Swal.fire({ icon: 'info', title: 'Info', text, confirmButtonColor: '#0a8f1b' });
        }
    }

    validatePasswordPolicy(pw) {
        const errors = [];
        if (pw.length < 8) errors.push('• At least 8 characters');
        if (!/[A-Z]/.test(pw)) errors.push('• At least one uppercase letter');
        if (!/[a-z]/.test(pw)) errors.push('• At least one lowercase letter');
        if (!/[0-9]/.test(pw)) errors.push('• At least one digit');
        if (!/[^A-Za-z0-9]/.test(pw)) errors.push('• At least one special character');
        return errors;
    }
}

export default ForgetPasswordModule;


