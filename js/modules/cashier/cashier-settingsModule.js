import TurnstileWidget from '../../shared/shared-turnstile.js?v=20260901-turnstile-responsive';
import ApiService from '../../services/services-apiService.js';

class FinanceSettingsModule {
    constructor() {
        this.otpTimer = null;
        this.otpTimerSeconds = 60;
        this.pendingPasswordChange = null;
        this.originalContact = '';
        this.originalEmail = '';
        this.originalBirthdate = '';
        this.originalGender = '';
    }
    
    async init() {
        this.profileTurnstile = new TurnstileWidget('profileTurnstile', 'profile_update');
        this.passwordTurnstile = new TurnstileWidget('passwordTurnstile', 'password_change');
        TurnstileWidget.bindModal('otpModal', () => this.pendingPasswordChange ? 'password_change' : 'profile_update');
        this.patchSwalToModal();
        await this.loadAccountInfo();
        await this.loadSidebarProfile();
        this.setupEventListeners();
    }

    patchSwalToModal() {
        if (!window.Swal || window.Swal.__settingsModalPatched) return;
        const originalFire = window.Swal.fire.bind(window.Swal);
        window.Swal.fire = (options, ...rest) => {
            if (options && typeof options === 'object' && !Array.isArray(options)) {
                const normalized = { ...options };
                delete normalized.toast;
                delete normalized.position;
                delete normalized.timer;
                if (normalized.showConfirmButton === false) {
                    delete normalized.showConfirmButton;
                }
                if (!normalized.confirmButtonText) {
                    normalized.confirmButtonText = 'OK';
                }
                return originalFire(normalized, ...rest);
            }
            return originalFire(options, ...rest);
        };
        window.Swal.__settingsModalPatched = true;
    }

    normalizeDateForCompare(v) {
        if (!v) return '';
        const s = String(v).trim();
        if (!s) return '';
        const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : s;
    }

    resetSendOtpProfileBtn() {
        const sendOtpBtn = document.getElementById('sendOtpProfileBtn');
        if (sendOtpBtn) {
            sendOtpBtn.disabled = false;
            sendOtpBtn.textContent = 'Save changes';
        }
    }
    
    async loadAccountInfo() {
        try {
            const response = await ApiService.get('/cashier/cashier-settings.php', { action: 'get_info' });
            
            if (response.success && response.employee) {
                const p = response.employee;
                
                // Store original values for change detection
                this.originalContact = p.employee_contact_number || '';
                this.originalEmail = p.employee_email || '';
                this.originalBirthdate = this.normalizeDateForCompare(p.employee_date_of_birth);
                this.originalGender = p.employee_gender || '';
                
                // Populate form fields with "No data" fallback
                document.getElementById('employeeId').value = p.employee_school_id || 'No data';
                document.getElementById('updFirstName').value = p.employee_first_name || 'No data';
                document.getElementById('updMiddleName').value = p.employee_middle_name || 'No data';
                document.getElementById('updLastName').value = p.employee_last_name || 'No data';
                document.getElementById('updBirthdate').value = this.originalBirthdate;
                document.getElementById('updGender').value = p.employee_gender || '';
                document.getElementById('updContact').value = p.employee_contact_number || '';
                document.getElementById('updEmail').value = p.employee_email || '';
                
                // Load profile image if exists
                if (p.employee_profile_image) {
                    const profileImg = document.getElementById('profileImagePreview');
                    if (profileImg) {
                        profileImg.src = '../../' + p.employee_profile_image;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading account info:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to load account information', confirmButtonText: 'OK' });
        }
    }
    
    async loadSidebarProfile() {
        try {
            const response = await ApiService.get('/cashier/cashier-settings.php', { action: 'profile' });
            if (response.success && response.profile) {
                const p = response.profile;
                const fullName = [p.employee_first_name, p.employee_middle_name, p.employee_last_name].filter(Boolean).join(' ');
                
                const sidebarName = document.getElementById('sidebarProfileName');
                if (sidebarName) sidebarName.textContent = fullName;
                
                // Check if profile image exists
                let avatarUrl;
                if (p.employee_profile_image) {
                    avatarUrl = '../../' + p.employee_profile_image;
                } else {
                    avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=03600f&color=fff&size=64`;
                }
                
                const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                const headerAvatar = document.getElementById('headerUserAvatarImg');
                
                if (sidebarAvatar) sidebarAvatar.src = avatarUrl;
                if (headerAvatar) {
                    if (p.employee_profile_image) {
                        headerAvatar.src = '../../' + p.employee_profile_image;
                    } else {
                        headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=03600f&color=fff&size=28`;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading sidebar profile:', error);
        }
    }
    
    setupEventListeners() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };
        
        // Profile image upload preview
        on('#profileImageInput', 'change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file size (max 2MB)
                if (file.size > 2 * 1024 * 1024) {
                    Swal.fire({
                        icon: 'error',
                        title: 'File Too Large',
                        text: 'Profile image must be less than 2MB',
                    });
                    e.target.value = '';
                    return;
                }
                
                // Validate file type
                const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
                if (!allowedTypes.includes(file.type)) {
                    Swal.fire({
                        icon: 'error',
                        title: 'Invalid File Type',
                        text: 'Please upload a JPG or PNG image',
                    });
                    e.target.value = '';
                    return;
                }
                
                // Preview image
                const reader = new FileReader();
                reader.onload = (event) => {
                    const img = document.getElementById('profileImagePreview');
                    if (img) {
                        img.src = event.target.result;
                    }
                };
                reader.readAsDataURL(file);
            }
        });
        
        on('#toggleOldPassword', 'click', () => { this.togglePasswordVisibility('oldPassword', 'toggleOldPassword'); });
        on('#toggleNewPassword', 'click', () => { this.togglePasswordVisibility('newPassword', 'toggleNewPassword'); });
        on('#toggleConfirmPassword', 'click', () => { this.togglePasswordVisibility('confirmPassword', 'toggleConfirmPassword'); });
        
        const passwordForm = document.getElementById('passwordSettingsForm');
        if (passwordForm) {
            passwordForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handlePasswordChange();
            });
        }
        
        const sendOtpBtn = document.getElementById('sendOtpProfileBtn');
        if (sendOtpBtn) {
            sendOtpBtn.addEventListener('click', () => {
                sendOtpBtn.disabled = true;
                sendOtpBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending OTP...';
                this.handleProfileUpdate();
            });
        }
        
        const otpForm = document.getElementById('otpForm');
        if (otpForm) {
            otpForm.addEventListener('submit', (e) => {
                this.verifyOtpAndUpdate(e);
            });
        }
        
        // Resend OTP button
        const resendOtpBtn = document.getElementById('resendOtpBtn');
        if (resendOtpBtn) {
            resendOtpBtn.addEventListener('click', async () => {
                resendOtpBtn.disabled = true;
                resendOtpBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending...';
                
                try {
                    const verification = TurnstileWidget.forModal('otpModal', this.pendingPasswordChange ? 'password_change' : 'profile_update');
                    const response = await verification.post(this.pendingPasswordChange ? '/auth/auth-change-password.php' : '/cashier/cashier-settings.php', {
                        action: 'send_otp',
                        ...(this.pendingPasswordChange ? { old_password: this.pendingPasswordChange.oldPassword } : {})
                    });
                    
                    if (response.success) {
                        this.startOtpTimer();
                        Swal.fire({
                            icon: 'success',
                            title: 'OTP Resent',
                            text: 'A new OTP code has been sent to your email.',
                        });
                    } else {
                        Swal.fire({
                            icon: 'error',
                            title: 'Error',
                            text: response.message || 'Failed to resend OTP.',
                        });
                    }
                } catch (error) {
                    console.error('Error resending OTP:', error);
                    Swal.fire({
                        icon: 'error',
                        title: 'Error',
                        text: error.response?.data?.message || 'Failed to resend OTP. Please try again.',
                    });
                } finally {
                    resendOtpBtn.disabled = false;
                    resendOtpBtn.innerHTML = '<i class=""></i>Resend Code';
                }
            });
        }
        
        const otpModalEl = document.getElementById('otpModal');
        if (otpModalEl) {
            otpModalEl.addEventListener('hidden.bs.modal', () => {
                if (this.otpTimer) {
                    clearInterval(this.otpTimer);
                }
                const otpInput = document.getElementById('otpCode');
                if (otpInput) {
                    otpInput.value = '';
                }
            });
        }
    }
    
    togglePasswordVisibility(inputId, buttonId) {
        const input = document.getElementById(inputId);
        const button = document.getElementById(buttonId);
        if (input && button) {
            const icon = button.querySelector('i');
            if (input.type === 'password') {
                input.type = 'text';
                if (icon) icon.classList.replace('bi-eye', 'bi-eye-slash');
            } else {
                input.type = 'password';
                if (icon) icon.classList.replace('bi-eye-slash', 'bi-eye');
            }
        }
    }
    
    async handlePasswordChange() {
        const form = document.getElementById('passwordSettingsForm');
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }

        const oldPassword = document.getElementById('oldPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        if (newPassword !== confirmPassword) {
            Swal.fire({ icon: 'error', title: 'Error', text: 'Passwords do not match', confirmButtonText: 'OK' });
            return;
        }

        if (oldPassword === newPassword) {
            Swal.fire({ icon: 'error', title: 'Error', text: 'New password must be different from old password', confirmButtonText: 'OK' });
            return;
        }

        const passwordErrors = this.validatePasswordRequirements(newPassword);
        if (passwordErrors.length > 0) {
            Swal.fire({ icon: 'error', title: 'Invalid Password', html: `Password does not meet requirements:<br><ul class="text-start mt-2"><li>${passwordErrors.join('</li><li>')}</li></ul>`, confirmButtonText: 'OK' });
            return;
        }

        // Get submit button and add animation
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending OTP...';
        }

        try {
            // Send OTP with old password for validation
            const response = await this.passwordTurnstile.post('/auth/auth-change-password.php', {
                action: 'send_otp',
                old_password: oldPassword
            });
            
            if (response.success) {
                // Store password values for later use
                this.pendingPasswordChange = {
                    oldPassword,
                    newPassword,
                    confirmPassword
                };
                
                // Show OTP modal
                const otpModalEl = document.getElementById('otpModal');
                if (otpModalEl) {
                    const otpModal = new bootstrap.Modal(otpModalEl);
                    otpModal.show();
                    this.startOtpTimer();
                }
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to send OTP. Please try again.',
                });
            }
        } catch (error) {
            console.error('Error sending OTP:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to send OTP. Please try again.',
            });
        } finally {
            // Restore button state
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    }
    
    async handleContactUpdate() {
        const contactNumber = document.getElementById('updContact')?.value.trim();
        const email = document.getElementById('updEmail')?.value.trim();
        const birthdate = this.normalizeDateForCompare(document.getElementById('updBirthdate')?.value);
        const gender = document.getElementById('updGender')?.value;
        const profileImageFile = document.getElementById('profileImageInput')?.files[0];
        
        if (!email || !contactNumber) {
            Swal.fire({
                icon: 'error',
                title: 'Validation Error',
                text: 'Please fill in all required fields (Email and Contact Number).',
            });
            this.resetSendOtpProfileBtn();
            return;
        }
        
        // Check if any changes were made
        const hasContactChanged = contactNumber !== this.originalContact;
        const hasEmailChanged = email !== this.originalEmail;
        const hasBirthdateChanged = birthdate !== this.originalBirthdate;
        const hasGenderChanged = gender !== this.originalGender;
        const hasImageChanged = profileImageFile !== undefined && profileImageFile !== null;
        
        if (!hasContactChanged && !hasEmailChanged && !hasBirthdateChanged && !hasGenderChanged && !hasImageChanged) {
            Swal.fire({
                icon: 'warning',
                title: 'No Changes',
                text: 'Please update your information before submitting.',
                confirmButtonText: 'OK',
                confirmButtonColor: '#198754'
            });
            
            this.resetSendOtpProfileBtn();
            return;
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            Swal.fire({ icon: 'error', title: 'Invalid Email', text: 'Please enter a valid email address', confirmButtonText: 'OK' });
            this.resetSendOtpProfileBtn();
            return;
        }

        // Validate contact number (11 digits, starts with 09)
        const phoneRegex = /^09\d{9}$/;
        if (!phoneRegex.test(contactNumber)) {
            Swal.fire({ icon: 'error', title: 'Invalid Contact Number', text: 'Contact number must be 11 digits and start with 09', confirmButtonText: 'OK' });
            this.resetSendOtpProfileBtn();
            return;
        }
        
        try {
            // Get CSRF token first
            const csrfToken = await ApiService.refreshCSRFToken();
            
            // Create FormData for file upload
            const formData = new FormData();
            formData.append('action', 'send_otp');
            if (profileImageFile) {
                formData.append('profile_image', profileImageFile);
            }
            if (csrfToken) {
                formData.append('csrf_token', csrfToken);
            }
            
            // Verify Turnstile before sending the profile upload and OTP request.
            const result = await this.profileTurnstile.postFormData('/cashier/cashier-settings.php', formData);
            
            if (result.success) {
                this.pendingPasswordChange = null;
                const otpModalEl = document.getElementById('otpModal');
                if (otpModalEl) {
                    const otpModal = new bootstrap.Modal(otpModalEl);
                    otpModal.show();
                    this.startOtpTimer();
                }
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: result.message || 'Failed to send OTP. Please try again.',
                });
            }
        } catch (error) {
            console.error('Error sending OTP:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to send OTP. Please try again.',
            });
        } finally {
            this.resetSendOtpProfileBtn();
        }
    }
    
    async handleProfileUpdate() {
        await this.handleContactUpdate();
    }
    
    startOtpTimer() {
        this.otpTimerSeconds = 60;
        const timerElement = document.getElementById('otpTimer');
        const timerText = document.getElementById('otpTimerText');
        const resendBtn = document.getElementById('resendOtpBtn');
        
        if (this.otpTimer) {
            clearInterval(this.otpTimer);
        }
        
        // Show timer, hide resend button
        if (timerText) timerText.classList.remove('d-none');
        if (resendBtn) resendBtn.classList.add('d-none');
        
        if (timerElement) {
            timerElement.textContent = this.otpTimerSeconds;
        }
        
        this.otpTimer = setInterval(() => {
            this.otpTimerSeconds--;
            if (timerElement) {
                timerElement.textContent = this.otpTimerSeconds;
            }
            
            if (this.otpTimerSeconds <= 0) {
                clearInterval(this.otpTimer);
                // Hide timer, show resend button
                if (timerText) timerText.classList.add('d-none');
                if (resendBtn) resendBtn.classList.remove('d-none');
            }
        }, 1000);
    }
    
    async verifyOtpAndUpdate(e) {
        e.preventDefault();
        
        const otpCode = document.getElementById('otpCode')?.value.trim();
        if (!otpCode || otpCode.length !== 6) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid OTP',
                text: 'Please enter a valid 6-digit OTP code.',
            });
            return;
        }
        
        // Check if this is for password change or contact update
        if (this.pendingPasswordChange) {
            await this.verifyPasswordChangeOTP(otpCode);
        } else {
            await this.verifyContactUpdateOTP(otpCode);
        }
    }
    
    async verifyPasswordChangeOTP(otpCode) {
        const { oldPassword, newPassword, confirmPassword } = this.pendingPasswordChange;
        
        try {
            const response = await ApiService.post('/auth/auth-change-password.php', {
                old_password: oldPassword,
                new_password: newPassword,
                confirm_password: confirmPassword,
                otp: otpCode
            });
            
            if (response.success) {
                if (this.otpTimer) {
                    clearInterval(this.otpTimer);
                }
                
                const otpModalEl = document.getElementById('otpModal');
                if (otpModalEl) {
                    const otpModal = bootstrap.Modal.getInstance(otpModalEl);
                    if (otpModal) {
                        otpModal.hide();
                    }
                }
                
                const otpInput = document.getElementById('otpCode');
                if (otpInput) {
                    otpInput.value = '';
                }
                
                // Clear pending password change
                this.pendingPasswordChange = null;
                
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Password changed successfully!',
                });
                
                const passwordForm = document.getElementById('passwordSettingsForm');
                if (passwordForm) {
                    passwordForm.reset();
                }
                this.passwordTurnstile.reset();
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to change password. Please try again.',
                });
            }
        } catch (error) {
            console.error('Error changing password:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to change password. Please try again.',
            });
        }
    }
    
    async verifyContactUpdateOTP(otpCode) {
        const dateOfBirth = document.getElementById('updBirthdate')?.value;
        const gender = document.getElementById('updGender')?.value;
        const contactNumber = document.getElementById('updContact')?.value.trim();
        const email = document.getElementById('updEmail')?.value.trim();
        
        try {
            const response = await ApiService.post('/cashier/cashier-settings.php', {
                action: 'update_contact',
                otp: otpCode,
                date_of_birth: dateOfBirth,
                gender: gender,
                email: email,
                contact_number: contactNumber
            });
            
            if (response.success) {
                if (this.otpTimer) {
                    clearInterval(this.otpTimer);
                }
                
                const otpModalEl = document.getElementById('otpModal');
                if (otpModalEl) {
                    const otpModal = bootstrap.Modal.getInstance(otpModalEl);
                    if (otpModal) {
                        otpModal.hide();
                    }
                }
                
                const otpInput = document.getElementById('otpCode');
                if (otpInput) {
                    otpInput.value = '';
                }
                
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Contact information updated successfully!',
                });
                
                await this.loadAccountInfo();
                await this.loadSidebarProfile();
                this.profileTurnstile.reset();
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to update contact information. Please try again.',
                });
            }
        } catch (error) {
            console.error('Error updating contact information:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to update contact information. Please try again.',
            });
        }
    }
    
    validatePasswordRequirements(password) {
        const errors = [];
        if (password.length < 8) errors.push('At least 8 characters long');
        if (!/[A-Z]/.test(password)) errors.push('Contains at least one uppercase letter (A-Z)');
        if (!/[a-z]/.test(password)) errors.push('Contains at least one lowercase letter (a-z)');
        if (!/[0-9]/.test(password)) errors.push('Contains at least one number (0-9)');
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) errors.push('Contains at least one special character (!@#$%^&*...)');
        return errors;
    }
}

export default FinanceSettingsModule;
