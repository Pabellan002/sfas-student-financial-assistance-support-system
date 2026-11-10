import TurnstileWidget from '../../shared/shared-turnstile.js?v=20260914-settings-overlay';
import ApiService from '../../services/services-apiService.js';

class StudentsSettingsModule {
    constructor() {
        this.otpTimer = null;
        this.otpTimerSeconds = 60;
        this.passwordOtpTimer = null;
        this.passwordOtpTimerSeconds = 60;
        this.auditLogLimit = 10;
        this.auditLogsRequestId = 0;
    }

    async init() {
        this.profileTurnstile = new TurnstileWidget('profileTurnstile', 'profile_update');
        this.passwordTurnstile = new TurnstileWidget('passwordTurnstile', 'password_change');
        TurnstileWidget.bindModal('otpModal', () => 'profile_update');
        TurnstileWidget.bindModal('passwordOtpModal', () => 'password_change');
        this.patchSwalToModal();
        await this.loadProfileData();
        await this.loadSidebarProfile();
        this.setupEventListeners();
        this.setupAuditLogListeners();
    }

    normalizeDateForCompare(value) {
        const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
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

    async loadProfileData() {
        try {
            const response = await ApiService.get('/students/students-settings.php', { action: 'profile' });
            
            if (response.success && response.profile) {
                const p = response.profile;
                
                // Store original values for change detection
                this.originalContact = p.student_contact_number || '';
                this.originalPersonalEmail = (p.student_personal_email || '').trim();
                this.originalBirthdate = this.normalizeDateForCompare(p.student_date_of_birth);
                this.originalGender = p.student_gender || '';

                // Populate update form
                document.getElementById('updFirstName').value = p.student_first_name || '';
                document.getElementById('updMiddleName').value = p.student_middle_name || '';
                document.getElementById('updLastName').value = p.student_last_name || '';
                document.getElementById('updBirthdate').value = this.originalBirthdate;
                document.getElementById('updGender').value = p.student_gender || '';
                document.getElementById('updContact').value = p.student_contact_number || '';
                const schoolEmailEl = document.getElementById('updSchoolEmail');
                if (schoolEmailEl) schoolEmailEl.value = p.student_email || '';
                const personalEmailEl = document.getElementById('updPersonalEmail');
                if (personalEmailEl) personalEmailEl.value = p.student_personal_email || '';
                
                // Load profile image if exists
                if (p.student_profile_image) {
                    const profileImg = document.getElementById('studentProfileImagePreview');
                    if (profileImg) {
                        profileImg.src = '../../' + p.student_profile_image;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading profile data:', error);
        }
    }

    async loadSidebarProfile() {
        try {
            const response = await ApiService.get('/students/students-settings.php', { action: 'profile' });
            if (response.success && response.profile) {
                const p = response.profile;
                const fullName = [p.student_first_name, p.student_middle_name, p.student_last_name].filter(Boolean).join(' ');
                
                // Update sidebar profile
                const sidebarName = document.getElementById('sidebarProfileName');
                if (sidebarName) sidebarName.textContent = fullName;
                
                // Update avatars with profile image if exists
                if (p.student_profile_image) {
                    const imagePath = '../../' + p.student_profile_image;
                    const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                    const headerAvatar = document.getElementById('headerUserAvatarImg');
                    
                    if (sidebarAvatar) sidebarAvatar.src = imagePath;
                    if (headerAvatar) headerAvatar.src = imagePath;
                } else {
                    // Use default avatar if no profile image
                    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=03600f&color=fff&size=64`;
                    const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                    const headerAvatar = document.getElementById('headerUserAvatarImg');
                    
                    if (sidebarAvatar) sidebarAvatar.src = avatarUrl;
                    if (headerAvatar) headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=03600f&color=fff&size=28`;
                }
            }
        } catch (error) {
            console.error('Error loading sidebar profile:', error);
        }
    }

    validatePasswordRequirements(password) {
        const errors = [];
        
        if (password.length < 8) {
            errors.push('Be at least 8 characters long');
        }
        
        if (!/[A-Z]/.test(password)) {
            errors.push('Contain at least one uppercase letter (A-Z)');
        }
        
        if (!/[a-z]/.test(password)) {
            errors.push('Contain at least one lowercase letter (a-z)');
        }
        
        if (!/[0-9]/.test(password)) {
            errors.push('Contain at least one number (0-9)');
        }
        
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
            errors.push('Contain at least one special character (!@#$%^&*...)');
        }
        
        return errors;
    }

    setupEventListeners() {
        // Profile image upload preview
        const profileImageInput = document.getElementById('studentProfileImageInput');
        if (profileImageInput) {
            profileImageInput.addEventListener('change', (e) => {
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
                        const img = document.getElementById('studentProfileImagePreview');
                        if (img) {
                            img.src = event.target.result;
                        }
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
        
        // Update contact form
        const sendOtpBtn = document.getElementById('sendOtpProfileBtn');
        if (sendOtpBtn) {
            sendOtpBtn.addEventListener('click', () => {
                this.handleProfileUpdate();
            });
        }
        
        // OTP form
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
                    const profileImageFile = document.getElementById('studentProfileImageInput')?.files[0];
                    
                    const formData = new FormData();
                    formData.append('action', 'send_otp');
                    if (profileImageFile) {
                        formData.append('profile_image', profileImageFile);
                    }
                    
                    const result = await TurnstileWidget.forModal('otpModal', 'profile_update').postFormData('/students/students-profile-update.php', formData);
                    
                    if (result.success) {
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
                            text: result.message || 'Failed to resend OTP.',
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
                    resendOtpBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Resend Code';
                }
            });
        }
        
        // Clear timer when modal is closed
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
        
        // Password change
        const passwordForm = document.getElementById('passwordSettingsForm');
        if (passwordForm) {
            passwordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.handlePasswordChange();
            });

            // Keyboard support for form fields
            const formFields = ['oldPassword', 'newPassword', 'confirmPassword'];
            formFields.forEach((fieldId, index) => {
                const field = document.getElementById(fieldId);
                if (field) {
                    // Enter key to submit or move to next field
                    field.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            if (index === formFields.length - 1) {
                                // Last field - submit form
                                passwordForm.dispatchEvent(new Event('submit'));
                            } else {
                                // Move to next field
                                const nextField = document.getElementById(formFields[index + 1]);
                                if (nextField) {
                                    nextField.focus();
                                }
                            }
                        }
                        // Escape key to reset form
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            passwordForm.reset();
                            this.passwordTurnstile.reset();
                            document.getElementById('oldPassword')?.focus();
                        }
                    });
                }
            });
        }
        
        // Password OTP form
        const passwordOtpForm = document.getElementById('passwordOtpForm');
        if (passwordOtpForm) {
            passwordOtpForm.addEventListener('submit', (e) => {
                this.verifyPasswordOtpAndChange(e);
            });
        }
        
        // Resend password OTP button
        const resendPasswordOtpBtn = document.getElementById('resendPasswordOtpBtn');
        if (resendPasswordOtpBtn) {
            resendPasswordOtpBtn.addEventListener('click', async () => {
                resendPasswordOtpBtn.disabled = true;
                resendPasswordOtpBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending...';
                
                try {
                    const response = await TurnstileWidget.forModal('passwordOtpModal', 'password_change').post('/auth/auth-change-password.php', {
                        action: 'send_otp',
                        old_password: this.pendingPasswordChange?.oldPassword
                    });
                    
                    if (response.success) {
                        this.startPasswordOtpTimer();
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
                    resendPasswordOtpBtn.disabled = false;
                    resendPasswordOtpBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Resend Code';
                }
            });
        }
        
        // Clear password OTP modal when closed
        const passwordOtpModalEl = document.getElementById('passwordOtpModal');
        if (passwordOtpModalEl) {
            passwordOtpModalEl.addEventListener('hidden.bs.modal', () => {
                if (this.passwordOtpTimer) {
                    clearInterval(this.passwordOtpTimer);
                }
                const otpInput = document.getElementById('passwordOtpCode');
                if (otpInput) {
                    otpInput.value = '';
                }
            });
        }

        // Toggle password visibility
        const toggleOldPassword = document.getElementById('toggleOldPassword');
        if (toggleOldPassword) {
            toggleOldPassword.addEventListener('click', () => {
                const passwordInput = document.getElementById('oldPassword');
                const icon = toggleOldPassword.querySelector('i');
                if (passwordInput.type === 'password') {
                    passwordInput.type = 'text';
                    icon.classList.remove('bi-eye');
                    icon.classList.add('bi-eye-slash');
                } else {
                    passwordInput.type = 'password';
                    icon.classList.remove('bi-eye-slash');
                    icon.classList.add('bi-eye');
                }
            });
        }

        const toggleNewPassword = document.getElementById('toggleNewPassword');
        if (toggleNewPassword) {
            toggleNewPassword.addEventListener('click', () => {
                const passwordInput = document.getElementById('newPassword');
                const icon = toggleNewPassword.querySelector('i');
                if (passwordInput.type === 'password') {
                    passwordInput.type = 'text';
                    icon.classList.remove('bi-eye');
                    icon.classList.add('bi-eye-slash');
                } else {
                    passwordInput.type = 'password';
                    icon.classList.remove('bi-eye-slash');
                    icon.classList.add('bi-eye');
                }
            });
        }

        const toggleConfirmPassword = document.getElementById('toggleConfirmPassword');
        if (toggleConfirmPassword) {
            toggleConfirmPassword.addEventListener('click', () => {
                const passwordInput = document.getElementById('confirmPassword');
                const icon = toggleConfirmPassword.querySelector('i');
                if (passwordInput.type === 'password') {
                    passwordInput.type = 'text';
                    icon.classList.remove('bi-eye');
                    icon.classList.add('bi-eye-slash');
                } else {
                    passwordInput.type = 'password';
                    icon.classList.remove('bi-eye-slash');
                    icon.classList.add('bi-eye');
                }
            });
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
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Passwords do not match',
                confirmButtonText: 'OK'
            });
            return;
        }

        if (oldPassword === newPassword) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'New password must be different from old password',
                confirmButtonText: 'OK'
            });
            return;
        }

        // Validate password requirements
        const passwordErrors = this.validatePasswordRequirements(newPassword);
        if (passwordErrors.length > 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Password Requirements Not Met',
                html: '<div style="text-align: left;"><strong>Your password must:</strong><ul style="margin-top: 0.5rem; margin-bottom: 0;">' + 
                      passwordErrors.map(err => `<li>${err}</li>`).join('') + 
                      '</ul></div>',
                confirmButtonText: 'OK'
            }).then(() => {
                // Reset form on validation error
                form.reset();
                this.passwordTurnstile.reset();
            });
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending OTP...';

        try {
            // First, send OTP
            const otpResponse = await this.passwordTurnstile.post('/auth/auth-change-password.php', {
                action: 'send_otp',
                old_password: oldPassword
            });

            if (!otpResponse.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: otpResponse.message || 'Failed to send OTP',
                    confirmButtonText: 'OK'
                });
                return;
            }

            // Store password data temporarily
            this.pendingPasswordChange = {
                oldPassword,
                newPassword,
                confirmPassword
            };

            // Show OTP modal
            const passwordOtpModalEl = document.getElementById('passwordOtpModal');
            if (passwordOtpModalEl) {
                const passwordOtpModal = new bootstrap.Modal(passwordOtpModalEl);
                passwordOtpModal.show();
                this.startPasswordOtpTimer();
            }
        } catch (error) {
            console.error('Error sending OTP:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'An unexpected error occurred',
                confirmButtonText: 'OK'
            });
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Change password';
        }
    }

    async verifyPasswordOtpAndChange(e) {
        e.preventDefault();
        
        const otpCode = document.getElementById('passwordOtpCode')?.value.trim();
        if (!otpCode || otpCode.length !== 6) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid OTP',
                text: 'Please enter a valid 6-digit OTP code.',
            });
            return;
        }
        
        if (!this.pendingPasswordChange) {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Password change data not found. Please try again.',
            });
            return;
        }
        
        const { oldPassword, newPassword, confirmPassword } = this.pendingPasswordChange;
        
        try {
            const response = await ApiService.post('/auth/auth-change-password.php', {
                old_password: oldPassword,
                new_password: newPassword,
                confirm_password: confirmPassword,
                otp: otpCode
            });

            if (response.success) {
                // Close modal
                const passwordOtpModalEl = document.getElementById('passwordOtpModal');
                if (passwordOtpModalEl) {
                    const passwordOtpModal = bootstrap.Modal.getInstance(passwordOtpModalEl);
                    if (passwordOtpModal) {
                        passwordOtpModal.hide();
                    }
                }
                
                // Clear OTP input
                const otpInput = document.getElementById('passwordOtpCode');
                if (otpInput) {
                    otpInput.value = '';
                }
                
                // Clear pending data
                this.pendingPasswordChange = null;
                
                // Show success message
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: response.message || 'Password changed successfully',
                });
                
                // Reset form
                const form = document.getElementById('passwordSettingsForm');
                if (form) {
                    form.reset();
                }
                this.passwordTurnstile.reset();
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to change password',
                });
            }
        } catch (error) {
            console.error('Error changing password:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'An unexpected error occurred',
            });
        }
    }
    
    isValidPersonalEmail(value) {
        const email = String(value || '').trim();
        if (!email) return true;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
        return !email.toLowerCase().endsWith('@phinmaed.com');
    }

    async handleProfileUpdate() {
        // Validate form fields
        const firstName = document.getElementById('updFirstName')?.value.trim();
        const lastName = document.getElementById('updLastName')?.value.trim();
        const contact = document.getElementById('updContact')?.value.trim();
        const personalEmail = document.getElementById('updPersonalEmail')?.value.trim() || '';
        const birthdate = this.normalizeDateForCompare(document.getElementById('updBirthdate')?.value);
        const gender = document.getElementById('updGender')?.value || '';

        if (!contact) {
            Swal.fire({
                icon: 'error',
                title: 'Validation Error',
                text: 'Please enter your contact number.',
            });
            return;
        }

        if (!this.isValidPersonalEmail(personalEmail)) {
            Swal.fire({
                icon: 'error',
                title: 'Validation Error',
                text: 'Personal email must be a valid address and cannot be @phinmaed.com.',
            });
            return;
        }

        // Check if contact info has changed
        const profileImageFile = document.getElementById('studentProfileImageInput')?.files[0];
        const hasContactChanged = contact !== this.originalContact
            || personalEmail !== (this.originalPersonalEmail || '');
        const hasProfileChanged = birthdate !== this.originalBirthdate
            || gender !== this.originalGender;
        const hasImageChanged = profileImageFile !== undefined && profileImageFile !== null;
        
        if (!hasContactChanged && !hasProfileChanged && !hasImageChanged) {
            Swal.fire({
                icon: 'warning',
                title: 'No Changes',
                text: 'Please update your profile information or profile image before submitting.',
                confirmButtonText: 'OK',
                confirmButtonColor: '#198754'
            });
            return;
        }
        
        const submitBtn = document.getElementById('sendOtpProfileBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending OTP...';
        
        try {
            // Create FormData for file upload
            const formData = new FormData();
            formData.append('action', 'send_otp');
            if (profileImageFile) {
                formData.append('profile_image', profileImageFile);
            }
            
            // Send OTP with profile image (ApiService appends CSRF token consistently)
            const result = await this.profileTurnstile.postFormData('/students/students-profile-update.php', formData);
            
            if (result.success) {
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
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save changes';
        }
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
    
    startPasswordOtpTimer() {
        this.passwordOtpTimerSeconds = 60;
        const timerElement = document.getElementById('passwordOtpTimer');
        const timerText = document.getElementById('passwordOtpTimerText');
        const resendBtn = document.getElementById('resendPasswordOtpBtn');
        
        if (this.passwordOtpTimer) {
            clearInterval(this.passwordOtpTimer);
        }
        
        // Show timer, hide resend button
        if (timerText) timerText.classList.remove('d-none');
        if (resendBtn) resendBtn.classList.add('d-none');
        
        if (timerElement) {
            timerElement.textContent = this.passwordOtpTimerSeconds;
        }
        
        this.passwordOtpTimer = setInterval(() => {
            this.passwordOtpTimerSeconds--;
            if (timerElement) {
                timerElement.textContent = this.passwordOtpTimerSeconds;
            }
            
            if (this.passwordOtpTimerSeconds <= 0) {
                clearInterval(this.passwordOtpTimer);
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
        
        // Get form data
        const firstName = document.getElementById('updFirstName')?.value.trim();
        const middleName = document.getElementById('updMiddleName')?.value.trim();
        const lastName = document.getElementById('updLastName')?.value.trim();
        const dateOfBirth = document.getElementById('updBirthdate')?.value;
        const gender = document.getElementById('updGender')?.value;
        const contact = document.getElementById('updContact')?.value.trim();
        const personalEmail = document.getElementById('updPersonalEmail')?.value.trim() || '';

        if (!this.isValidPersonalEmail(personalEmail)) {
            Swal.fire({
                icon: 'error',
                title: 'Validation Error',
                text: 'Personal email must be a valid address and cannot be @phinmaed.com.',
            });
            return;
        }

        try {
            const response = await ApiService.post('/students/students-profile-update.php', {
                action: 'update_profile',
                otp: otpCode,
                first_name: firstName,
                middle_name: middleName,
                last_name: lastName,
                date_of_birth: dateOfBirth,
                gender: gender,
                contact_number: contact,
                personal_email: personalEmail
            });
            
            if (response.success) {
                // Clear OTP timer
                if (this.otpTimer) {
                    clearInterval(this.otpTimer);
                }
                
                // Close modal
                const otpModalEl = document.getElementById('otpModal');
                if (otpModalEl) {
                    const otpModal = bootstrap.Modal.getInstance(otpModalEl);
                    if (otpModal) {
                        otpModal.hide();
                    }
                }
                
                // Clear OTP input
                const otpInput = document.getElementById('otpCode');
                if (otpInput) {
                    otpInput.value = '';
                }
                
                // Show success message
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Profile updated successfully!',
                });
                
                // Reload profile to show updated data
                await this.loadProfileData();
                await this.loadSidebarProfile();
                this.profileTurnstile.reset();
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to update profile. Please try again.',
                });
            }
        } catch (error) {
            console.error('Error updating profile:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to update profile. Please try again.',
            });
        }
    }

    // Audit Log Methods
    setupAuditLogListeners() {
        // Load audit logs when the activity log accordion is opened
        const activityAccordion = document.getElementById('settingsCollapseActivity');
        if (activityAccordion) {
            activityAccordion.addEventListener('shown.bs.collapse', () => {
                if (!this.auditLogsLoaded) {
                    this.loadAuditLogs(1);
                    this.auditLogsLoaded = true;
                }
            });
        }
        document.getElementById('activityLogPerPage')?.addEventListener('change', (event) => {
            this.auditLogLimit = Number(event.target.value) || 10;
            this.loadAuditLogs(1);
        });
        document.getElementById('activityLogPages')?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            this.loadAuditLogs(Number(button.dataset.page));
        });
    }

    async loadAuditLogs(page = 1) {
        const requestId = ++this.auditLogsRequestId;
        const limit = this.auditLogLimit;
        const tbody = document.getElementById('activityLogBody');
        const mobileCards = document.getElementById('activityLogMobileCards');
        const paginationInfo = document.getElementById('activityLogInfo');
        const paginationPages = document.getElementById('activityLogPages');

        if (!tbody && !mobileCards) return;

        // Show loading state for both views
        const loadingHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-success" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
                <p class="text-muted mt-2 mb-0">Loading activity logs...</p>
            </div>
        `;
        
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center py-4">
                        <div class="spinner-border text-success" role="status">
                            <span class="visually-hidden">Loading...</span>
                        </div>
                        <p class="text-muted mt-2 mb-0">Loading activity logs...</p>
                    </td>
                </tr>
            `;
        }
        if (mobileCards) {
            mobileCards.innerHTML = loadingHTML;
        }

        try {
            const response = await ApiService.get('/students/students-settings.php', {
                action: 'audit_logs',
                page: page,
                limit: limit
            });
            if (requestId !== this.auditLogsRequestId) return;

            if (response.success && response.logs) {
                const logs = response.logs;
                const pagination = response.pagination;
                if (pagination.total > 0 && page > pagination.pages) {
                    return this.loadAuditLogs(Math.max(1, pagination.pages));
                }

                if (logs.length === 0) {
                    const emptyStateHTML = `
                        <div class="text-center py-4">
                            <i class="bi bi-inbox fs-1 text-muted"></i>
                            <p class="text-muted mt-2 mb-0">No activity logs found</p>
                        </div>
                    `;
                    
                    if (tbody) {
                        tbody.innerHTML = `
                            <tr>
                                <td colspan="4" class="text-center py-4">
                                    <i class="bi bi-inbox fs-1 text-muted"></i>
                                    <p class="text-muted mt-2 mb-0">No activity logs found</p>
                                </td>
                            </tr>
                        `;
                    }
                    if (mobileCards) {
                        mobileCards.innerHTML = emptyStateHTML;
                    }
                    if (paginationInfo) paginationInfo.textContent = 'Showing 0 to 0 of 0 entries';
                    if (paginationPages) paginationPages.innerHTML = '';
                    return;
                }

                // Render desktop table
                if (tbody) {
                    tbody.innerHTML = logs.map(log => this.renderAuditLogRow(log)).join('');
                }
                
                // Render mobile cards
                if (mobileCards) {
                    mobileCards.innerHTML = logs.map(log => this.renderAuditLogCard(log)).join('');
                }

                // Update pagination info
                const start = (pagination.page - 1) * pagination.limit + 1;
                const end = Math.min(pagination.page * pagination.limit, pagination.total);
                if (paginationInfo) {
                    paginationInfo.textContent = `Showing ${start} to ${end} of ${pagination.total} entries`;
                }

                // Render pagination
                if (paginationPages) {
                    paginationPages.innerHTML = this.renderPagination(pagination);
                }

            } else {
                const errorStateHTML = `
                    <div class="text-center py-4 text-danger">
                        <i class="bi bi-exclamation-triangle fs-1"></i>
                        <p class="mt-2 mb-0">Failed to load activity logs</p>
                    </div>
                `;
                
                if (tbody) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="4" class="text-center py-4 text-danger">
                                <i class="bi bi-exclamation-triangle fs-1"></i>
                                <p class="mt-2 mb-0">Failed to load activity logs</p>
                            </td>
                        </tr>
                    `;
                }
                if (mobileCards) {
                    mobileCards.innerHTML = errorStateHTML;
                }
            }
        } catch (error) {
            if (requestId !== this.auditLogsRequestId) return;
            console.error('Error loading audit logs:', error);
            const errorStateHTML = `
                <div class="text-center py-4 text-danger">
                    <i class="bi bi-exclamation-triangle fs-1"></i>
                    <p class="mt-2 mb-0">Error loading activity logs. Please try again.</p>
                </div>
            `;
            
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="4" class="text-center py-4 text-danger">
                            <i class="bi bi-exclamation-triangle fs-1"></i>
                            <p class="mt-2 mb-0">Error loading activity logs. Please try again.</p>
                        </td>
                    </tr>
                `;
            }
            if (mobileCards) {
                mobileCards.innerHTML = errorStateHTML;
            }
        }
    }
    
    renderAuditLogCard(log) {
        const date = new Date(log.audit_log_created_at);
        const formattedDate = date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
        const formattedTime = date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        // Get action badge
        const actionBadge = this.getActionBadge(log.audit_log_action);

        // Parse details
        let details = '-';
        try {
            if (log.audit_log_details) {
                const detailsObj = JSON.parse(log.audit_log_details);
                details = this.formatDetails(detailsObj, log.audit_log_action);
            }
        } catch (e) {
            details = this.cleanDetailsText(log.audit_log_details || '-');
        }

        // Format location/device
        const location = log.audit_log_ip_address || '-';
        const device = this.formatUserAgent(log.audit_log_user_agent);

        return `
            <div class="card mb-3 border-0 shadow-sm">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <div>
                            ${actionBadge}
                        </div>
                        <div class="text-end">
                            <div class="fw-semibold small">${formattedDate}</div>
                            <small class="text-muted">${formattedTime}</small>
                        </div>
                    </div>
                    <div class="mb-2">
                        <strong class="small text-muted d-block">Details:</strong>
                        <div class="small">${details}</div>
                    </div>
                    <div>
                        <div class="small"><i class="bi bi-geo-alt text-muted me-1"></i>${location}</div>
                        <div class="small mt-1"><i class="bi bi-device-ssd text-muted me-1"></i>${device}</div>
                    </div>
                </div>
            </div>
        `;
    }

    renderAuditLogRow(log) {
        const date = new Date(log.audit_log_created_at);
        const formattedDate = date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
        const formattedTime = date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        // Get action badge (now includes the text)
        const actionBadge = this.getActionBadge(log.audit_log_action);

        // Parse details
        let details = '-';
        try {
            if (log.audit_log_details) {
                const detailsObj = JSON.parse(log.audit_log_details);
                details = this.formatDetails(detailsObj, log.audit_log_action);
            }
        } catch (e) {
            // If not JSON, clean up the text
            details = this.cleanDetailsText(log.audit_log_details || '-');
        }

        // Format location/device
        const location = log.audit_log_ip_address || '-';
        const device = this.formatUserAgent(log.audit_log_user_agent);

        return `
            <tr>
                <td>
                    <div class="fw-semibold">${formattedDate}</div>
                    <small class="text-muted">${formattedTime}</small>
                </td>
                <td>
                    ${actionBadge}
                </td>
                <td>
                    <small>${details}</small>
                </td>
                <td>
                    <div><i class="bi bi-geo-alt text-muted me-1"></i><small>${location}</small></div>
                    <div class="mt-1"><i class="bi bi-device-ssd text-muted me-1"></i><small>${device}</small></div>
                </td>
            </tr>
        `;
    }

    formatAction(action) {
        const actionMap = {
            'LOGIN': 'Login',
            'LOGOUT': 'Logout',
            'CHANGE_PASSWORD': 'Password Changed',
            'UPDATE_PROFILE': 'Profile Updated',
            'APPLY_LOAN': 'Loan Application',
            'UPDATE_LOAN': 'Loan Update',
            'VIEW_BALANCE': 'Balance Viewed'
        };
        return actionMap[action] || action.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
    }

    getActionBadge(action) {
        const badgeMap = {
            'LOGIN': '<span class="badge bg-success fs-6"><i class="bi bi-box-arrow-in-right me-1"></i>Login</span>',
            'LOGOUT': '<span class="badge bg-secondary fs-6"><i class="bi bi-box-arrow-right me-1"></i>Logout</span>',
            'CHANGE_PASSWORD': '<span class="badge bg-warning fs-6"><i class="bi bi-key me-1"></i>Password Changed</span>',
            'UPDATE_PROFILE': '<span class="badge bg-info fs-6"><i class="bi bi-person me-1"></i>Profile Updated</span>',
            'APPLY_LOAN': '<span class="badge bg-primary fs-6"><i class="bi bi-file-earmark-text me-1"></i>Loan Applied</span>',
            'UPDATE_LOAN': '<span class="badge bg-primary fs-6"><i class="bi bi-pencil-square me-1"></i>Loan Updated</span>',
            'VIEW_BALANCE': '<span class="badge bg-secondary fs-6"><i class="bi bi-eye me-1"></i>Balance Viewed</span>'
        };
        return badgeMap[action] || `<span class="badge bg-secondary fs-6">${this.formatAction(action)}</span>`;
    }

    formatDetails(detailsObj, action) {
        if (typeof detailsObj === 'string') {
            return this.cleanDetailsText(detailsObj);
        }
        
        // For LOGIN/LOGOUT, show success message
        if (action === 'LOGIN') {
            return 'Signed in successfully';
        }
        if (action === 'LOGOUT') {
            return 'Signed out successfully';
        }
        
        // For password change
        if (detailsObj.password_changed) {
            return 'Password changed successfully';
        }
        
        // For profile updates
        if (detailsObj.field) {
            return `Updated ${detailsObj.field}`;
        }
        
        // For loan actions
        if (detailsObj.loan_id) {
            return `Loan #${detailsObj.loan_id}`;
        }
        
        // Default: try to clean any text
        return this.cleanDetailsText(JSON.stringify(detailsObj));
    }

    cleanDetailsText(text) {
        if (!text || text === '-') return '-';
        
        // Remove "User", "Student", "Staff" prefixes
        text = text.replace(/^(User|Student|Staff)\s+/gi, '');
        
        // Clean up common phrases
        text = text.replace(/login successful/gi, 'Signed in successfully');
        text = text.replace(/logout successful/gi, 'Signed out successfully');
        text = text.replace(/logged out successfully/gi, 'Signed out successfully');
        text = text.replace(/student login successful/gi, 'Signed in successfully');
        text = text.replace(/staff login successful/gi, 'Signed in successfully');
        
        // Capitalize first letter
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    formatUserAgent(userAgent) {
        if (!userAgent) return 'Unknown';
        
        // Simple parsing for common browsers
        if (userAgent.includes('Chrome')) return 'Chrome';
        if (userAgent.includes('Firefox')) return 'Firefox';
        if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) return 'Safari';
        if (userAgent.includes('Edge')) return 'Edge';
        if (userAgent.includes('MSIE') || userAgent.includes('Trident')) return 'Internet Explorer';
        
        // Detect mobile
        if (userAgent.includes('Mobile')) return 'Mobile Device';
        
        return 'Desktop';
    }

    renderPagination(pagination) {
        const { page, pages } = pagination;
        if (pages <= 1) return '';
        const numbers = pages <= 7
            ? Array.from({ length: pages }, (_, index) => index + 1)
            : [...new Set([1, page - 1, page, page + 1, pages])]
                .filter((number) => number >= 1 && number <= pages)
                .sort((a, b) => a - b);
        const buttons = [];
        let previous = 0;
        for (const number of numbers) {
            if (previous && number > previous + 1) buttons.push('<span class="px-1 text-muted" aria-hidden="true">…</span>');
            buttons.push(`<button type="button" class="btn btn-sm ${number === page ? 'btn-success' : 'btn-outline-secondary'}" data-page="${number}" ${number === page ? 'aria-current="page"' : ''}>${number}</button>`);
            previous = number;
        }
        return `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
    }
}

export default StudentsSettingsModule;
