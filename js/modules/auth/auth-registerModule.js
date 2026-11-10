import ApiService from '../../services/services-apiService.js';
import TurnstileWidget from '../../shared/shared-turnstile.js?v=20260914-verified-event';

const SUBMITTED_FLAG = 'register_form_submitted';
const SCHOOL_ID_PATTERN = /^\d{2}-\d{4}-\d{4,6}$/;
const PHINMAED_LOCAL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+\.coc$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_PATTERN = /^09\d{9}$/;
const FAMILY_NAME_PATTERN = /^[\p{L}\p{M} .,'\u2019-]+$/u;

class RegisterModule {
    constructor() {
        this._fieldIds = [
            'school_id',
            'first_name',
            'last_name',
            'program_id',
            'year_level_id',
            'contact_number',
            'personal_email',
            'email_local',
            'password',
            'confirm_password',
        ];
        this._touched = new Set();
        this._submitAttempted = false;
        this._schoolIdPreviewUrl = null;
        this.registrationTurnstile = null;
        this.isSubmitting = false;
    }

    async init() {
        await this.loadCSRFToken();
        this.bindPasswordToggles();
        this.bindDateOfBirth();
        await this.loadOptions();
        this.registrationTurnstile = new TurnstileWidget('registerTurnstile', 'registration');
        this.bindTurnstileVerification();
        this.bindSchoolIdScanner();
        this.bindForm();
        this.bindLiveValidation();
        if (this.shouldResetAfterSubmit()) {
            this.resetForm();
        }
    }

    shouldResetAfterSubmit() {
        try {
            return sessionStorage.getItem(SUBMITTED_FLAG) === '1';
        } catch (_) {
            return false;
        }
    }

    markSubmitted() {
        try {
            sessionStorage.setItem(SUBMITTED_FLAG, '1');
        } catch (_) {}
    }

    clearSubmittedFlag() {
        try {
            sessionStorage.removeItem(SUBMITTED_FLAG);
        } catch (_) {}
    }

    resetForm() {
        const form = document.getElementById('registerForm');
        form?.reset();
        this.resetBirthCalendar();
        this.validateDateOfBirth();
        this.clearAllFieldErrors();
        this.hideError();
        this.resetPasswordFields();
        const submitBtn = document.getElementById('registerSubmitBtn');
        submitBtn?.removeAttribute('disabled');
        this._touched.clear();
        this._submitAttempted = false;
        this.clearSchoolIdScan();
        this.registrationTurnstile?.reset();
        document.getElementById('registerSecurityCheck')?.classList.add('d-none');
        document.body.classList.remove('register-security-open');
        this.clearSubmittedFlag();
    }

    bindSchoolIdScanner() {
        const input = document.getElementById('schoolIdScanInput');
        const scanBtn = document.getElementById('schoolIdScanBtn');
        if (!input || !scanBtn) return;

        scanBtn.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) this.scanSchoolId(file);
        });
    }

    clearSchoolIdScan() {
        const input = document.getElementById('schoolIdScanInput');
        const result = document.getElementById('schoolIdScanResult');
        if (input) input.value = '';
        result?.classList.add('d-none');
        if (this._schoolIdPreviewUrl) {
            URL.revokeObjectURL(this._schoolIdPreviewUrl);
            this._schoolIdPreviewUrl = null;
        }
    }

    async checkSchoolIdAvailability(schoolId) {
        try {
            const base = ApiService.getBaseURL();
            const res = await fetch(
                `${base}/auth/auth-register.php?action=check_school_id&school_id=${encodeURIComponent(schoolId)}`,
                { credentials: 'same-origin', cache: 'no-store' }
            );
            const data = await res.json().catch(() => null);
            
            if (!data?.available) {
                const message = data?.message || 'This School ID is already registered.';
                this.setFieldError('school_id', message);
                
                await Swal.fire({
                    icon: 'error',
                    title: 'School ID Already Registered',
                    text: message,
                    confirmButtonColor: '#198754',
                });
                
                return false;
            }
            
            // School ID is available, clear any existing error
            this.clearFieldError('school_id');
            return true;
        } catch (error) {
            console.error('Failed to check school ID availability:', error);
            // Don't block registration if the check fails due to network issues
            return true;
        }
    }

    async setScannedField(id, value) {
        const input = document.getElementById(id);
        const cleanValue = String(value || '').trim();
        if (!input || !cleanValue) return false;
        input.value = cleanValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        
        // If this is the school_id field, check availability immediately
        if (id === 'school_id' && cleanValue) {
            const isAvailable = await this.checkSchoolIdAvailability(cleanValue);
            if (!isAvailable) {
                // Clear the field if not available
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return false;
            }
        }
        
        return true;
    }

    selectScannedOption(id, value) {
        const select = document.getElementById(id);
        const wanted = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!select || !wanted) return false;
        const option = [...select.options].find((item) => {
            const label = item.textContent.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            return label === wanted || label.includes(wanted) || wanted.includes(label);
        });
        if (!option || !option.value) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    async scanSchoolId(file) {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.type) || file.size > 5 * 1024 * 1024) {
            this.clearSchoolIdScan();
            this.showError('Upload a JPG, PNG, or WebP image no larger than 5MB.', 'Invalid School ID Image');
            return;
        }

        const scanner = document.getElementById('schoolIdScanner');
        const result = document.getElementById('schoolIdScanResult');
        const preview = document.getElementById('schoolIdScanPreview');
        const status = document.getElementById('schoolIdScanStatus');
        const fileName = document.getElementById('schoolIdScanFileName');
        const scanBtn = document.getElementById('schoolIdScanBtn');
        const scanBtnIcon = document.getElementById('schoolIdScanBtnIcon');
        const scanBtnText = document.getElementById('schoolIdScanBtnText');
        const scanBtnSpinner = document.getElementById('schoolIdScanBtnSpinner');

        if (this._schoolIdPreviewUrl) URL.revokeObjectURL(this._schoolIdPreviewUrl);
        this._schoolIdPreviewUrl = URL.createObjectURL(file);
        if (preview) preview.src = this._schoolIdPreviewUrl;
        if (fileName) fileName.textContent = file.name;
        if (status) status.textContent = 'Scanning school ID…';
        result?.classList.remove('d-none');
        scanner?.classList.add('is-scanning');
        scanBtn?.setAttribute('disabled', 'disabled');
        
        // Show scanning state on button
        scanBtnIcon?.classList.add('d-none');
        scanBtnText.textContent = 'Scanning ID...';
        scanBtnSpinner?.classList.remove('d-none');

        try {
            const formData = new FormData();
            formData.append('school_id_image', file);
            const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
            const base = ApiService.getBaseURL();
            const response = await fetch(`${base}/auth/auth-school-id-scan.php`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': csrf },
                body: formData,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success) {
                throw new Error(data?.message || 'The school ID could not be scanned.');
            }
            const ocrPrefill = data.scanProvider === 'ocr_space' && !!data.fields?.school_id;
            if (!data.verified && !ocrPrefill) {
                throw new Error(data.message || 'The uploaded image could not be verified as a school ID.');
            }

            const fields = data.fields || {};
            const filled = [];
            
            // Check school ID first - if it's already registered, stop here
            const schoolIdSet = await this.setScannedField('school_id', fields.school_id);
            if (!schoolIdSet) {
                // School ID validation failed, don't continue with the rest
                if (status) status.textContent = 'School ID already registered.';
                return;
            }
            filled.push('School ID');
            
            // Continue with other fields
            if (await this.setScannedField('first_name', fields.first_name)) filled.push('First name');
            if (await this.setScannedField('last_name', fields.last_name)) filled.push('Last name');
            if (this.selectScannedOption('program_id', fields.program)) filled.push('Program');
            if (this.selectScannedOption('year_level_id', fields.year_level)) filled.push('Year level');
            if (this.selectScannedOption('campus_id', fields.campus)) filled.push('Campus');

            if (status) status.textContent = ocrPrefill
                ? 'OCR read the school ID number — check it against your card.'
                : 'School ID scanned — review the autofilled details.';
            await Swal.fire({
                icon: ocrPrefill ? 'warning' : 'success',
                title: ocrPrefill ? 'ID text read by OCR' : 'School ID Scanned',
                text: ocrPrefill
                    ? 'OCR filled the visible school ID number only. Confirm every detail against your issued card; this scan does not verify the ID.'
                    : filled.length
                    ? `${filled.join(', ')} ${filled.length === 1 ? 'was' : 'were'} autofilled. Please review the information before submitting.`
                    : 'The school ID was verified, but no fields were clear enough to autofill. Please enter them manually.',
                confirmButtonColor: '#198754',
            });
        } catch (error) {
            if (status) status.textContent = 'Scan unsuccessful — you can still enter the details manually.';
            this.showError(error.message || 'Unable to scan the school ID.', 'School ID Scan Failed');
        } finally {
            scanner?.classList.remove('is-scanning');
            scanBtn?.removeAttribute('disabled');
            
            // Reset button state
            const scanBtnIcon = document.getElementById('schoolIdScanBtnIcon');
            const scanBtnText = document.getElementById('schoolIdScanBtnText');
            const scanBtnSpinner = document.getElementById('schoolIdScanBtnSpinner');
            scanBtnIcon?.classList.remove('d-none');
            if (scanBtnText) scanBtnText.textContent = 'Upload School ID';
            scanBtnSpinner?.classList.add('d-none');
        }
    }

    resetPasswordFields() {
        ['password', 'confirm_password'].forEach((id) => {
            const input = document.getElementById(id);
            if (input) input.type = 'password';
        });
        ['togglePasswordBtn', 'toggleConfirmPasswordBtn'].forEach((btnId) => {
            const icon = document.getElementById(btnId)?.querySelector('i');
            if (icon) icon.className = 'bi bi-eye-slash';
        });
    }

    async loadCSRFToken() {
        try {
            const basePath = ApiService.getBaseURL();
            const response = await axios.get(`${basePath}/includes/includes-csrf-endpoint.php?action=get_token`, {
                withCredentials: true,
            });
            if (response.data.success) {
                let metaTag = document.querySelector('meta[name="csrf-token"]');
                if (!metaTag) {
                    metaTag = document.createElement('meta');
                    metaTag.name = 'csrf-token';
                    document.head.appendChild(metaTag);
                }
                metaTag.setAttribute('content', response.data.token);
            }
        } catch (_) {}
    }

    populateSelect(id, items, valueKey, labelKey, placeholder) {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = `<option value="">${placeholder}</option>`;
        (items || []).forEach((item) => {
            const option = document.createElement('option');
            option.value = item[valueKey];
            option.textContent = item[labelKey];
            select.appendChild(option);
        });
    }

    async loadOptions() {
        try {
            const base = ApiService.getBaseURL();
            const res = await fetch(`${base}/auth/auth-register.php?action=options`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (!data?.success) throw new Error(data?.message || 'Failed to load options');
            if (data.registration_enabled === false) {
                this.showError('Online registration is not available yet. Please contact the CSDL office.', 'Registration Unavailable');
                document.getElementById('registerSubmitBtn')?.setAttribute('disabled', 'disabled');
                return;
            }
            this.populateSelect('program_id', data.programs, 'program_id', 'program_name', 'Select Program');
            this.populateSelect('year_level_id', data.year_levels, 'year_level_id', 'year_level_name', 'Select Year Level');
            this.populateSelect('campus_id', data.campuses, 'campus_id', 'campus_name', 'Select Campus');
            this.populateSelect('modality', data.modalities, 'modality_code', 'modality_name', 'Select Modality');
        } catch (error) {
            this.showError(error.message || 'Unable to load registration form.', 'Unable to Load Form');
        }
    }

    bindPasswordToggles() {
        const bindToggle = (btnId, inputId) => {
            const btn = document.getElementById(btnId);
            const input = document.getElementById(inputId);
            if (!btn || !input) return;
            btn.addEventListener('click', () => {
                const isPassword = input.type === 'password';
                input.type = isPassword ? 'text' : 'password';
                const icon = btn.querySelector('i');
                if (icon) icon.className = isPassword ? 'bi bi-eye' : 'bi bi-eye-slash';
            });
        };
        bindToggle('togglePasswordBtn', 'password');
        bindToggle('toggleConfirmPasswordBtn', 'confirm_password');
    }

    bindDateOfBirth() {
        const picker = document.getElementById('birthDatePicker');
        const toggle = document.getElementById('birthDateToggle');
        const month = document.getElementById('birthCalendarMonth');
        const year = document.getElementById('birthCalendarYear');
        const calendar = document.getElementById('birthDateCalendar');
        if (!picker || !toggle || !month || !year || !calendar) return;

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        monthNames.forEach((name, index) => month.add(new Option(name, String(index + 1))));
        for (let value = new Date().getFullYear(); value >= 1900; value--) {
            year.add(new Option(String(value), String(value)));
        }
        this.resetBirthCalendar();

        toggle.addEventListener('click', () => {
            if (calendar.classList.contains('d-none')) this.openBirthCalendar();
            else this.closeBirthCalendar();
        });
        month.addEventListener('change', () => {
            this._birthCalendarMonth = Number(month.value);
            this.renderBirthCalendar();
        });
        year.addEventListener('change', () => {
            this._birthCalendarYear = Number(year.value);
            this.renderBirthCalendar();
        });
        document.getElementById('birthPrevMonth')?.addEventListener('click', () => this.shiftBirthCalendar(-1));
        document.getElementById('birthNextMonth')?.addEventListener('click', () => this.shiftBirthCalendar(1));
        document.getElementById('birthDateClear')?.addEventListener('click', () => {
            document.getElementById('date_of_birth').value = '';
            this.validateDateOfBirth();
            this.closeBirthCalendar(true);
        });
        document.addEventListener('pointerdown', (event) => {
            if (!picker.contains(event.target)) this.closeBirthCalendar();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !calendar.classList.contains('d-none')) {
                event.preventDefault();
                this.closeBirthCalendar(true);
            }
        });
    }

    resetBirthCalendar() {
        const today = new Date();
        this._birthCalendarYear = Math.max(1900, today.getFullYear() - 20);
        this._birthCalendarMonth = today.getMonth() + 1;
        this.closeBirthCalendar();
    }

    openBirthCalendar() {
        const selected = document.getElementById('date_of_birth')?.value || '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(selected)) {
            this._birthCalendarYear = Number(selected.slice(0, 4));
            this._birthCalendarMonth = Number(selected.slice(5, 7));
        }
        this.renderBirthCalendar();
        const calendar = document.getElementById('birthDateCalendar');
        calendar?.classList.remove('d-none');
        const triggerRect = document.getElementById('birthDateToggle')?.getBoundingClientRect();
        if (calendar && triggerRect) {
            const height = calendar.getBoundingClientRect().height;
            calendar.classList.toggle('is-above', window.innerHeight - triggerRect.bottom < height + 12
                && triggerRect.top >= height + 12);
        }
        document.getElementById('birthDateToggle')?.setAttribute('aria-expanded', 'true');
    }

    closeBirthCalendar(restoreFocus = false) {
        document.getElementById('birthDateCalendar')?.classList.add('d-none');
        const toggle = document.getElementById('birthDateToggle');
        toggle?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) toggle?.focus();
    }

    shiftBirthCalendar(offset) {
        const next = new Date(this._birthCalendarYear, this._birthCalendarMonth - 1 + offset, 1);
        const today = new Date();
        if (next.getFullYear() < 1900 || next.getFullYear() > today.getFullYear()
            || (next.getFullYear() === today.getFullYear() && next.getMonth() > today.getMonth())) return;
        this._birthCalendarYear = next.getFullYear();
        this._birthCalendarMonth = next.getMonth() + 1;
        this.renderBirthCalendar();
    }

    renderBirthCalendar() {
        const month = document.getElementById('birthCalendarMonth');
        const year = document.getElementById('birthCalendarYear');
        const days = document.getElementById('birthCalendarDays');
        if (!month || !year || !days) return;

        const today = new Date();
        if (this._birthCalendarYear === today.getFullYear()
            && this._birthCalendarMonth > today.getMonth() + 1) {
            this._birthCalendarMonth = today.getMonth() + 1;
        }
        for (const option of month.options) {
            option.disabled = this._birthCalendarYear === today.getFullYear()
                && Number(option.value) > today.getMonth() + 1;
        }
        month.value = String(this._birthCalendarMonth);
        year.value = String(this._birthCalendarYear);
        const firstDay = new Date(this._birthCalendarYear, this._birthCalendarMonth - 1, 1).getDay();
        const daysInMonth = new Date(this._birthCalendarYear, this._birthCalendarMonth, 0).getDate();
        const selected = document.getElementById('date_of_birth')?.value || '';
        const fragment = document.createDocumentFragment();
        for (let blank = 0; blank < firstDay; blank++) {
            const spacer = document.createElement('span');
            spacer.setAttribute('aria-hidden', 'true');
            fragment.appendChild(spacer);
        }
        for (let number = 1; number <= daysInMonth; number++) {
            const date = new Date(this._birthCalendarYear, this._birthCalendarMonth - 1, number);
            const iso = `${this._birthCalendarYear}-${String(this._birthCalendarMonth).padStart(2, '0')}-${String(number).padStart(2, '0')}`;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'register-dob__day';
            button.textContent = String(number);
            button.setAttribute('aria-label', date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
            button.disabled = date > today;
            if (iso === selected) {
                button.classList.add('is-selected');
                button.setAttribute('aria-current', 'date');
            }
            button.addEventListener('click', () => {
                document.getElementById('date_of_birth').value = iso;
                this.validateDateOfBirth();
                this.closeBirthCalendar(true);
            });
            fragment.appendChild(button);
        }
        days.replaceChildren(fragment);
        document.getElementById('birthPrevMonth').disabled = this._birthCalendarYear === 1900 && this._birthCalendarMonth === 1;
        document.getElementById('birthNextMonth').disabled = this._birthCalendarYear === today.getFullYear()
            && this._birthCalendarMonth === today.getMonth() + 1;
    }

    validateDateOfBirth() {
        const date = document.getElementById('date_of_birth');
        const value = document.getElementById('birthDateValue');
        const toggle = document.getElementById('birthDateToggle');
        const error = document.getElementById('birthDateError');
        if (!date || !value || !toggle || !error) return true;

        let message = '';
        if (date.value) {
            const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value);
            const today = new Date();
            const selected = match && new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
            if (!match || Number(match[1]) < 1900 || selected.getFullYear() !== Number(match[1])
                || selected.getMonth() + 1 !== Number(match[2]) || selected.getDate() !== Number(match[3])
                || selected > today) {
                message = 'Choose a valid date of birth.';
            } else {
                value.textContent = selected.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            }
        }
        if (!date.value || message) value.textContent = 'Select date of birth';
        toggle.classList.toggle('is-invalid', Boolean(message));
        toggle.classList.toggle('has-value', Boolean(date.value) && !message);
        if (message) toggle.setAttribute('aria-invalid', 'true');
        else toggle.removeAttribute('aria-invalid');
        error.textContent = message;
        error.classList.toggle('d-none', !message);
        return !message;
    }

    markTouched(fieldId) {
        this._touched.add(fieldId);
    }

    shouldCheckField(fieldId, value = '') {
        if (this._submitAttempted || this._touched.has(fieldId)) return true;
        return String(value || '').trim() !== '';
    }

    bindLiveValidation() {
        this._fieldIds.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;

            // Keep the contact field numeric, including when a value is pasted.
            if (id === 'contact_number') {
                el.addEventListener('input', () => {
                    const numericValue = el.value.replace(/\D/g, '').slice(0, 11);
                    if (el.value !== numericValue) {
                        el.value = numericValue;
                    }
                });
            }

            const run = () => {
                this.validateField(id);
                if (id === 'password' || id === 'confirm_password') {
                    this.validateField('confirm_password');
                }
                if (id === 'email_local' || id === 'personal_email') {
                    this.validateEmailFields();
                }
                this.syncFormErrorBanner();
            };

            el.addEventListener('input', run);
            el.addEventListener('change', () => {
                this.markTouched(id);
                run();
            });
            el.addEventListener('blur', () => {
                this.markTouched(id);
                run();
            });
        });
    }

    syncFormErrorBanner() {
        const hasInvalid = document.querySelector('#registerForm .is-invalid');
        if (!hasInvalid) {
            this.hideError();
        }
    }

    getFieldContainer(fieldId) {
        const el = document.getElementById(fieldId);
        if (!el) return null;
        if (el.closest('.input-group')) {
            return el.closest('.input-group')?.parentElement || el.parentElement;
        }
        return el.parentElement;
    }

    setFieldError(fieldId, message) {
        const el = document.getElementById(fieldId);
        if (!el) return;
        el.classList.add('is-invalid');
        el.setAttribute('aria-invalid', 'true');

        const container = this.getFieldContainer(fieldId);
        if (!container) return;

        let feedback = container.querySelector(`.register-field-error[data-for="${fieldId}"]`);
        if (!feedback) {
            feedback = document.createElement('div');
            feedback.className = 'register-field-error';
            feedback.dataset.for = fieldId;
            container.appendChild(feedback);
        }
        feedback.textContent = message;
    }

    clearFieldError(fieldId) {
        const el = document.getElementById(fieldId);
        if (el) {
            el.classList.remove('is-invalid');
            el.removeAttribute('aria-invalid');
        }
        const container = this.getFieldContainer(fieldId);
        container?.querySelector(`.register-field-error[data-for="${fieldId}"]`)?.remove();
    }

    clearAllFieldErrors() {
        this._fieldIds.forEach((id) => this.clearFieldError(id));
    }

    validatePhinmaEdLocalPart(local) {
        const value = String(local || '').trim().toLowerCase();
        if (!value || value.includes('@')) return false;
        return PHINMAED_LOCAL_PATTERN.test(value);
    }

    normalizeMobile(value) {
        const digits = String(value || '').replace(/\D/g, '');
        if (!digits) return '';
        if (/^9\d{9}$/.test(digits)) return `0${digits}`;
        if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
        return digits;
    }

    validatePassword(password) {
        const errors = [];
        if (password.length < 8) errors.push('at least 8 characters');
        if (!/[A-Z]/.test(password)) errors.push('one uppercase letter');
        if (!/[a-z]/.test(password)) errors.push('one lowercase letter');
        if (!/[0-9]/.test(password)) errors.push('one number');
        if (!/[^A-Za-z0-9]/.test(password)) errors.push('one special character');
        return errors;
    }

    validateEmailFields({ force = false } = {}) {
        const emailLocal = document.getElementById('email_local')?.value?.trim() || '';
        const personalEmail = document.getElementById('personal_email')?.value?.trim() || '';
        const check = force || this._submitAttempted
            || this._touched.has('email_local')
            || this._touched.has('personal_email')
            || emailLocal !== ''
            || personalEmail !== '';

        if (!check) {
            this.clearFieldError('email_local');
            this.clearFieldError('personal_email');
            return true;
        }

        let ok = true;

        if (!emailLocal && !personalEmail) {
            this.setFieldError('email_local', 'Enter a school email and/or personal email.');
            this.setFieldError('personal_email', 'Enter a school email and/or personal email.');
            return false;
        }

        this.clearFieldError('email_local');
        this.clearFieldError('personal_email');

        if (emailLocal && !this.validatePhinmaEdLocalPart(emailLocal)) {
            this.setFieldError('email_local', 'Use format firstname.lastname.coc before @phinmaed.com.');
            ok = false;
        }

        if (personalEmail) {
            if (!EMAIL_PATTERN.test(personalEmail)) {
                this.setFieldError('personal_email', 'Enter a valid email address.');
                ok = false;
            } else if (personalEmail.toLowerCase().endsWith('@phinmaed.com')) {
                this.setFieldError('personal_email', 'Use a personal email address. Enter @phinmaed.com under School Email.');
                ok = false;
            }
        }

        return ok;
    }

    validateField(fieldId, { force = false } = {}) {
        const el = document.getElementById(fieldId);
        if (!el) return true;

        const rawValue = el.value ?? '';
        const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
        const check = force || this.shouldCheckField(fieldId, value);

        if (!check) {
            this.clearFieldError(fieldId);
            return true;
        }

        switch (fieldId) {
            case 'school_id':
                if (!value) {
                    this.setFieldError(fieldId, 'School ID is required.');
                    return false;
                }
                if (!SCHOOL_ID_PATTERN.test(value)) {
                    this.setFieldError(fieldId, 'Use format 02-2020-00001.');
                    return false;
                }
                break;

            case 'first_name':
                if (!value) {
                    this.setFieldError(fieldId, 'First name is required.');
                    return false;
                }
                break;

            case 'last_name':
                if (!value) {
                    this.setFieldError(fieldId, 'Last name is required.');
                    return false;
                }
                break;

            case 'program_id':
                if (!value) {
                    this.setFieldError(fieldId, 'Please select a program.');
                    return false;
                }
                break;

            case 'year_level_id':
                if (!value) {
                    this.setFieldError(fieldId, 'Please select a year level.');
                    return false;
                }
                break;

            case 'email_local':
            case 'personal_email':
                return this.validateEmailFields({ force });

            case 'contact_number':
                if (!value) {
                    this.clearFieldError(fieldId);
                    return true;
                }
                if (!MOBILE_PATTERN.test(this.normalizeMobile(value))) {
                    this.setFieldError(fieldId, 'Use format 9XXXXXXXXX or 09XXXXXXXXX.');
                    return false;
                }
                break;

            case 'password': {
                if (!value) {
                    this.setFieldError(fieldId, 'Password is required.');
                    return false;
                }
                const passwordIssues = this.validatePassword(value);
                if (passwordIssues.length) {
                    this.setFieldError(fieldId, `Password needs ${passwordIssues.join(', ')}.`);
                    return false;
                }
                break;
            }

            case 'confirm_password': {
                const password = document.getElementById('password')?.value || '';
                if (!value) {
                    this.setFieldError(fieldId, 'Please confirm your password.');
                    return false;
                }
                if (password !== value) {
                    this.setFieldError(fieldId, 'Passwords do not match.');
                    return false;
                }
                break;
            }

            default:
                break;
        }

        this.clearFieldError(fieldId);
        return true;
    }

    validateForm() {
        this._submitAttempted = true;
        this._fieldIds.forEach((id) => this.markTouched(id));

        let ok = true;
        this._fieldIds.forEach((id) => {
            if (id === 'email_local' || id === 'personal_email') return;
            if (!this.validateField(id, { force: true })) {
                ok = false;
            }
        });
        if (!this.validateEmailFields({ force: true })) {
            ok = false;
        }
        if (!this.validateDateOfBirth()) {
            ok = false;
        }
        if (this.collectFamilyDetails() === null) {
            ok = false;
        }
        return ok;
    }

    showFormError(message) {
        const box = document.getElementById('registerError');
        if (!box) return;
        box.textContent = message;
        box.classList.remove('d-none');
        box.setAttribute('aria-hidden', 'false');
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    showError(message, title = 'Error') {
        this.showFormError(message);
        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'error',
                title,
                text: message,
                confirmButtonColor: '#198754',
            });
        }
    }

    hideError() {
        const box = document.getElementById('registerError');
        if (!box) return;
        box.classList.add('d-none');
        box.textContent = '';
        box.setAttribute('aria-hidden', 'true');
    }

    bindForm() {
        const form = document.getElementById('registerForm');
        if (!form) return;
        form.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    collectFamilyDetails() {
        const members = [];
        let valid = true;
        const validName = (value) => {
            const words = value.trim().split(/\s+/);
            return value.length <= 200 && FAMILY_NAME_PATTERN.test(value)
                && words.length >= 2 && words.every((word) => /\p{L}/u.test(word))
                && (value.match(/\p{L}/gu) || []).length >= 4;
        };
        document.querySelectorAll('#registerForm [data-family-member]').forEach((row) => {
            const nameInput = row.querySelector('[data-family-name]');
            const contactInput = row.querySelector('[data-family-contact]');
            const name = nameInput.value.trim();
            const contact = contactInput.value.trim();
            [nameInput, contactInput].forEach((input) => input.classList.remove('is-invalid'));
            if (!name && !contact) return;
            if (!validName(name)) {
                nameInput.classList.add('is-invalid');
                valid = false;
            }
            if (!MOBILE_PATTERN.test(this.normalizeMobile(contact))) {
                contactInput.classList.add('is-invalid');
                valid = false;
            } else {
                contactInput.value = this.normalizeMobile(contact);
            }
            members.push({ relationship_id: Number(row.dataset.relationshipId), name, contact: this.normalizeMobile(contact) });
        });
        if (!members.length) {
            document.querySelector('#registerFamilyFixed [data-family-name]')?.classList.add('is-invalid');
            valid = false;
        }
        return valid ? members : null;
    }

    bindTurnstileVerification() {
        const container = document.getElementById('registerTurnstile');
        if (!container) return;
        container.addEventListener('turnstile:verified', () => {
            document.getElementById('registerSecurityCheck')?.classList.add('d-none');
            document.body.classList.remove('register-security-open');
            this.submitRegistration();
        });
    }

    async handleSubmit(e) {
        e.preventDefault();
        this.hideError();

        if (!this.validateForm()) {
            this.showFormError('Please fix the highlighted fields before submitting.');
            const firstInvalid = document.querySelector('#registerForm .is-invalid');
            firstInvalid?.focus();
            return;
        }

        if (!this.registrationTurnstile) {
            this.showError('Security verification is unavailable. Please refresh the page.', 'Verification Unavailable');
            return;
        }

        if (this.registrationTurnstile.token) {
            await this.submitRegistration();
            return;
        }

        const securityCheck = document.getElementById('registerSecurityCheck');
        securityCheck?.classList.remove('d-none');
        document.body.classList.add('register-security-open');
        await this.registrationTurnstile.renderIfVisible();
    }

    async submitRegistration() {
        if (this.isSubmitting) return;
        if (!this.validateForm()) {
            this.showFormError('Please fix the highlighted fields before submitting.');
            return;
        }

        const submitBtn = document.getElementById('registerSubmitBtn');
        const submitText = document.getElementById('registerSubmitText');
        this.isSubmitting = true;
        submitBtn?.setAttribute('disabled', 'disabled');
        if (submitText) submitText.textContent = 'Submitting...';

        try {
            const formData = new FormData(document.getElementById('registerForm'));
            const payload = Object.fromEntries(formData.entries());
            payload.family_details = this.collectFamilyDetails();
            const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';

            if (!this.registrationTurnstile) {
                throw new Error('Security verification is unavailable. Please refresh the page.');
            }

            const data = await this.registrationTurnstile.run(async (token) => {
                payload['cf-turnstile-response'] = token;
                const base = ApiService.getBaseURL();
                const res = await fetch(`${base}/auth/auth-register.php`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf,
                    },
                    body: JSON.stringify(payload),
                });
                const responseData = await res.json();
                if (!res.ok || !responseData?.success) {
                    throw new Error(responseData?.message || 'Registration failed.');
                }
                return responseData;
            });

            this.markSubmitted();

            await Swal.fire({
                icon: 'success',
                title: 'Registration Submitted',
                text: 'Your registration was sent. You can sign in once CSDL approves it. Wait for Assessment to set up your balance before applying for a loan.',
                confirmButtonColor: '#198754',
                confirmButtonText: 'Go to Sign In',
            });

            window.location.replace('login.html');
        } catch (error) {
            this.showError(error.message || 'Registration failed. Please try again.', 'Registration Failed');
        } finally {
            this.isSubmitting = false;
            submitBtn?.removeAttribute('disabled');
            if (submitText) submitText.textContent = 'Submit';
        }
    }
}

export default RegisterModule;
