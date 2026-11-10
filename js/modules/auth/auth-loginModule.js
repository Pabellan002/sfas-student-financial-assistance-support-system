import AppPaths from '../../services/services-appPaths.js';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';

export const finishAuthGate = () => {
    document.querySelectorAll('[data-auth-gated-content]').forEach((element) => {
        element.hidden = false;
    });
    document.body?.classList.remove('auth-gate-pending');
    // A timeout redirect can carry a horizontal scroll position from a wide dashboard.
    if (window.scrollX !== 0) {
        window.scrollTo(0, window.scrollY);
    }
    const overlay = document.getElementById('authGateOverlay');
    if (overlay) {
        overlay.hidden = true;
        overlay.classList.add('d-none');
        overlay.setAttribute('aria-hidden', 'true');
    }
};

class LoginModule {
    constructor() {
        this.loginForm = null;
        this.turnstileWidgetId = null;
        this.turnstileToken = '';
        this.isSubmitting = false;
        this._redirected = false;
    }

    async init() {
      this.setupElements();
      await this.loadCSRFToken();
      await this.redirectIfAlreadyLoggedIn();
        this.setupIdleCsrfRefresh();
        this.showPostLoginStateMessage();
        this.setupEventListeners();
        this.setupTurnstile();
        this.setupAccountStatusFeature();
    }

  async redirectIfAlreadyLoggedIn() {
      if (this._redirected) return;
      if (this._passwordChangePromise) return this._passwordChangePromise;
      if (this._sessionCheckPromise) return this._sessionCheckPromise;
      this._sessionCheckPromise = this.checkExistingSession();
      try {
          return await this._sessionCheckPromise;
      } finally {
          this._sessionCheckPromise = null;
      }
  }

  async checkExistingSession() {
      try {
          const base = ApiService.getBaseURL();
          const url = `${base}/auth/auth-check-session.php?peek=1&_=${Date.now()}`;
          const res = await fetch(url, {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: {
                  'X-Session-Peek': '1',
                  'Cache-Control': 'no-cache, no-store, max-age=0',
                  'Pragma': 'no-cache'
              }
          });
          const data = await res.json();
          if (data?.success && (data.authenticated === true || data.active === true) && data.user) {
              // If password change is required, don't redirect - stay on login and show modal
              if (data.requires_password_change === true) {
                  await this.promptPasswordChange(data.user, data.password_change_reason);
                  return;
              }
              
              this._redirected = true;
              const target = this.getDashboardUrl(data.user.role_id, data.user.type);
              window.location.replace(target);
          }
      } catch (_) {
          // fail silently, stay on login
      }
  }

  async verifySessionReady(maxAttempts = 3) {
      const base = ApiService.getBaseURL();
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          try {
              const res = await fetch(`${base}/auth/auth-check-session.php?peek=1&_=${Date.now()}`, {
                  method: 'GET',
                  credentials: 'same-origin',
                  cache: 'no-store',
                  headers: {
                      'X-Session-Peek': '1',
                      'Cache-Control': 'no-cache, no-store, max-age=0',
                      'Pragma': 'no-cache',
                  },
              });
              const data = await res.json();
              if (data?.success && data.active === true && data.user) {
                  return true;
              }
          } catch (_) {
              // retry
          }
          if (attempt < maxAttempts - 1) {
              await new Promise((resolve) => setTimeout(resolve, 250));
          }
      }
      return false;
  }

    async loadCSRFToken() {
        try {
            const basePath = ApiService.getBaseURL();
            const response = await axios.get(`${basePath}/includes/includes-csrf-endpoint.php?action=get_token`, {
                withCredentials: true
            });
            if (response.data.success) {
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
        } catch (error) {
            
        }
    }

    setupIdleCsrfRefresh() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.loadCSRFToken();
            }
        });
    }

    setupElements() {
        this.loginForm = document.getElementById('loginForm');
        this.turnstileContainer = document.getElementById('loginTurnstile');
        this.turnstileStatus = document.getElementById('turnstileStatus');
        this.loginButton = document.getElementById('loginButton');
        this.loginButtonText = document.getElementById('loginButtonText');
        this.loginSpinner = document.getElementById('loginSpinner');
        this.loginButtonIcon = this.loginButton?.querySelector('.bi-box-arrow-in-right') || null;
        this.togglePassword = document.getElementById('togglePassword');
        this.schoolIdInput = document.getElementById('school_id');
        this.passwordInput = document.getElementById('password');
    }

    setupEventListeners() {
        if (this.loginForm) {
            this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        }

        if (this.togglePassword) {
            this.togglePassword.addEventListener('click', () => this.togglePasswordVisibility());
            this.togglePassword.setAttribute('role', 'button');
            this.togglePassword.setAttribute('tabindex', '0');
            this.togglePassword.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.togglePasswordVisibility();
                }
            });
        }

        // Quickview keyboard support
        const accountStatusBtn = document.getElementById('accountStatusBtn');
        const accountStatusPopup = document.getElementById('accountStatusPopup');
        const closeStatusPopup = document.getElementById('closeStatusPopup');
        const statusSchoolId = document.getElementById('statusSchoolId');
        const checkStatusBtn = document.getElementById('checkStatusBtn');

        if (accountStatusBtn) {
            accountStatusBtn.setAttribute('aria-haspopup', 'dialog');
            accountStatusBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    accountStatusBtn.click();
                }
            });
        }

        if (statusSchoolId) {
            statusSchoolId.setAttribute('inputmode', 'text');
            statusSchoolId.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && checkStatusBtn) {
                    e.preventDefault();
                    checkStatusBtn.click();
                }
                if (e.key === 'Escape' && accountStatusPopup) {
                    accountStatusPopup.classList.add('d-none');
                    if (accountStatusBtn) accountStatusBtn.focus();
                }
            });
            // Real-time validation feedback
            statusSchoolId.addEventListener('input', () => {
                this.validateSchoolIdFormat(statusSchoolId);
            });
        }

        if (closeStatusPopup) {
            closeStatusPopup.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    closeStatusPopup.click();
                }
            });
        }

        // Global ESC to close quickview if open
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && accountStatusPopup && !accountStatusPopup.classList.contains('d-none')) {
                accountStatusPopup.classList.add('d-none');
                if (accountStatusBtn) accountStatusBtn.focus();
            }
        });

    }

    setupTurnstile() {
        if (!this.turnstileContainer) return;

        const unavailable = () => this.updateTurnstileState('', 'Security verification could not load. Check your connection or browser extensions, then refresh the page.', true);
        const renderWidget = () => {
            if (this.turnstileWidgetId !== null) return;
            try {
                this.turnstileWidgetId = window.turnstile.render(this.turnstileContainer, {
                    sitekey: this.turnstileContainer.dataset.sitekey,
                    action: 'login',
                    theme: 'light',
                    size: this.turnstileContainer.clientWidth < 300 ? 'compact' : 'flexible',
                    tabindex: 3,
                    'refresh-expired': 'manual',
                    'refresh-timeout': 'manual',
                    callback: (token) => this.updateTurnstileState(token, ''),
                    'expired-callback': () => this.resetTurnstile(),
                    'timeout-callback': () => this.resetTurnstile('Verification timed out. Please try the new check.'),
                    'error-callback': () => {
                        this.updateTurnstileState('', 'Security verification failed. Retrying automatically; if it continues, refresh the page.', true);
                        return true;
                    }
                });
            } catch (_) {
                unavailable();
            }
        };

        if (window.turnstile) {
            renderWidget();
            return;
        }

        // Load from Cloudflare directly; its API script must not be proxied or cached locally.
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        const loadTimeout = setTimeout(unavailable, 15000);
        script.addEventListener('load', () => {
            clearTimeout(loadTimeout);
            if (window.turnstile) renderWidget();
            else unavailable();
        });
        script.addEventListener('error', () => {
            clearTimeout(loadTimeout);
            unavailable();
        });
        document.head.appendChild(script);
    }

    updateTurnstileState(token, message, isError = false) {
        this.turnstileToken = token;
        if (this.loginButton) this.loginButton.disabled = this.isSubmitting || !token;
        if (this.turnstileStatus) {
            this.turnstileStatus.textContent = message;
            this.turnstileStatus.classList.toggle('d-none', !message);
            this.turnstileStatus.classList.toggle('text-danger', isError);
            this.turnstileStatus.classList.toggle('text-success', Boolean(token));
            this.turnstileStatus.classList.toggle('text-muted', !isError && !token);
        }
    }

    resetTurnstile(message = '') {
        this.updateTurnstileState('', message);
        if (window.turnstile && this.turnstileWidgetId !== null) {
            window.turnstile.reset(this.turnstileWidgetId);
        }
    }

    togglePasswordVisibility() {
        const passwordInput = document.getElementById('password');
        const toggleIcon = this.togglePassword.querySelector('i');

        if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
            toggleIcon.classList.remove('bi-eye-slash-fill');
            toggleIcon.classList.add('bi-eye-fill');
        } else {
            passwordInput.type = 'password';
            toggleIcon.classList.remove('bi-eye-fill');
            toggleIcon.classList.add('bi-eye-slash-fill');
        }
    }

    showError(message) {
        if (window.Swal) {
            Swal.fire({ icon: 'error', title: 'Sign in', text: message, confirmButtonColor: '#0a8f1b' });
        } else {
            window.alert(message);
        }
    }

    showPostLoginStateMessage() {
        try {
            const url = new URL(window.location.href);
            let handled = false;
            if (url.searchParams.get('signed_out') === '1') {
                url.searchParams.delete('signed_out');
                handled = true;
            }
            if (url.searchParams.get('session_expired') === '1') {
                url.searchParams.delete('session_expired');
                handled = true;
            }
            if (url.searchParams.get('signed_in_elsewhere') === '1') {
                url.searchParams.delete('signed_in_elsewhere');
                handled = true;
            }
            if (handled) {
                window.history.replaceState({}, document.title, url.pathname + (url.search ? url.search : '') + url.hash);
            }
        } catch (_) {
            // Ignore URL parsing issues.
        }
    }

    setLoading(loading) {
        this.isSubmitting = loading;
        if (this.loginButton) {
            this.loginButton.disabled = loading || !this.turnstileToken;
            this.loginButton.classList.toggle('is-loading', loading);
        }
        if (this.loginButtonText) {
            this.loginButtonText.textContent = loading ? 'Signing in...' : 'Sign In';
        }
        if (this.loginSpinner) {
            if (loading) {
                this.loginSpinner.classList.remove('d-none');
            } else {
                this.loginSpinner.classList.add('d-none');
            }
        }
        if (this.loginButtonIcon) {
            this.loginButtonIcon.classList.toggle('d-none', loading);
        }
        if (this.schoolIdInput) this.schoolIdInput.disabled = loading;
        if (this.passwordInput) this.passwordInput.disabled = loading;
    }

    getLoginAlertMeta(message) {
        const msg = String(message || '').toLowerCase();
        if (msg.includes('registration is pending') || msg.includes('pending approval')) {
            return { icon: 'info', title: 'Registration Pending' };
        }
        if (msg.includes('registration was not approved') || msg.includes('rejected')) {
            return { icon: 'warning', title: 'Registration Not Approved' };
        }
        return { icon: 'error', title: 'Login failed' };
    }

    async handleLogin(e) {
        e.preventDefault();
        if (this.isSubmitting) return;

        const schoolId = document.getElementById('school_id')?.value.trim();
        const password = document.getElementById('password')?.value;
        const turnstileToken = this.turnstileToken;

        if (!schoolId || !password) {
            this.showError('School ID and password are required');
            return;
        }

        if (!turnstileToken) {
            this.showError('Please complete security verification before signing in.');
            return;
        }

        this.setLoading(true);

        try {
            await ApiService.refreshCSRFToken();
            const response = await ApiService.post('/auth/auth-login.php', {
                school_id: schoolId,
                password: password,
                'cf-turnstile-response': turnstileToken
            });

            if (response && typeof response === 'object' && response.success) {
                // Check if password change is required (for employees or students with default password)
                if (response.requires_password_change && (response.user.type === 'employee' || response.user.type === 'student')) {
                    await this.promptPasswordChange(response.user, response.password_change_reason);
                    return;
                }

                const redirectUrl = this.getDashboardUrl(response.user.role_id, response.user.type);
                const sessionReady = await this.verifySessionReady();
                if (sessionReady) {
                    window.location.replace(redirectUrl);
                    return;
                }
                this.setLoading(false);
                this.showError('Sign-in succeeded but your session could not be confirmed. Please sign in once more.');
                return;
            } else {
                let errorMsg = 'Login failed. Please check your credentials.';
                if (typeof response === 'string') {
                    try {
                        const parsed = JSON.parse(response.split('}').pop() + '}');
                        if (parsed.success === true) {
                            window.location.href = this.getDashboardUrl(parsed.user.role_id, parsed.user.type);
                            return;
                        }
                        errorMsg = parsed.message || errorMsg;
                    } catch (e) {
                        const jsonMatch = response.match(/\{.*\}/s);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                if (parsed.success === true) {
                                    window.location.href = this.getDashboardUrl(parsed.user.role_id, parsed.user.type);
                                    return;
                                }
                                errorMsg = parsed.message || errorMsg;
                            } catch (e2) {
                                
                            }
                        }
                    }
                } else if (response && typeof response === 'object') {
                    errorMsg = response.message || errorMsg;
                }
                if (window.Swal) {
                    const alertMeta = this.getLoginAlertMeta(errorMsg);
                    Swal.fire({
                        icon: alertMeta.icon,
                        title: alertMeta.title,
                        text: errorMsg,
                        confirmButtonColor: '#0a8f1b'
                    });
                } else {
                    this.showError(errorMsg);
                }
            }
        } catch (error) {
            let errorMessage = 'An error occurred. Please try again.';

            if (error.response?.data) {
                const errorData = error.response.data;
                errorMessage = errorData.message || errorMessage;
                
                if (error.response.status === 403) {
                    if (errorData.error_code === 'CSRF_INVALID') {
                        await ApiService.refreshCSRFToken();
                        errorMessage = 'Session expired. Please refresh the page and try again.';
                        if (window.Swal) {
                            Swal.fire({ icon: 'warning', title: 'Session expired', text: errorMessage, confirmButtonColor: '#0a8f1b' });
                        } else {
                            this.showError(errorMessage);
                        }
                        setTimeout(() => {
                            window.location.reload();
                        }, 2000);
                        return;
                    } else {
                        errorMessage = errorData.message || 'Access forbidden. Please refresh the page.';
                    }
                }

                if (error.response.status === 429) {
                    const resetTime = errorData.reset_time ? new Date(errorData.reset_time * 1000) : null;
                    if (resetTime) {
                        const minutes = Math.ceil((resetTime - new Date()) / 60000);
                        errorMessage = `${errorMessage} Try again in ${minutes} minute(s).`;
                    }
                }
            } else if (error.response?.status === 403) {
                errorMessage = 'Access forbidden. Please refresh the page and try again.';
            }

            if (window.Swal) {
                const alertMeta = this.getLoginAlertMeta(errorMessage);
                Swal.fire({
                    icon: alertMeta.icon,
                    title: alertMeta.title,
                    text: errorMessage,
                    confirmButtonColor: '#0a8f1b'
                });
            } else {
                this.showError(errorMessage);
            }
        } finally {
            // Siteverify tokens are single-use, including when credentials are rejected.
            this.resetTurnstile();
            this.setLoading(false);
        }
    }

    getDashboardUrl(roleId, userType) {
        const roleRoutes = {
            96: 'students',
            97: 'coo',
            98: 'branch-admin',
            99: 'cashier',
            100: 'csdl',
            101: 'assessment'
        };

        const role = roleRoutes[roleId] || roleRoutes[96];
        return AppPaths.page(`views/${role}/${role}-dashboard.html`);
    }

    setupAccountStatusFeature() {
        const accountStatusBtn = document.getElementById('accountStatusBtn');
        const accountStatusPopup = document.getElementById('accountStatusPopup');
        const closeStatusPopup = document.getElementById('closeStatusPopup');
        const checkStatusBtn = document.getElementById('checkStatusBtn');
        const statusSchoolId = document.getElementById('statusSchoolId');
        const accountStatusResult = document.getElementById('accountStatusResult');

        if (accountStatusBtn && accountStatusPopup) {
            accountStatusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = accountStatusPopup.classList.contains('d-none');
                accountStatusPopup.classList.toggle('d-none');

                if (isHidden) {
                    this.loadFAQs();
                }
            });
        }

        if (accountStatusPopup) {
            accountStatusPopup.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        if (closeStatusPopup) {
            closeStatusPopup.addEventListener('click', (e) => {
                e.stopPropagation();
                if (accountStatusPopup) accountStatusPopup.classList.add('d-none');
            });
        }

        document.addEventListener('click', () => {
            if (accountStatusPopup && !accountStatusPopup.classList.contains('d-none')) {
                accountStatusPopup.classList.add('d-none');
            }
        });

        // Handle tab switching
        const faqTab = document.getElementById('faq-tab');
        const statusTab = document.getElementById('status-tab');
        const registrationStatusTab = document.getElementById('registration-status-tab');
        
        if (faqTab) {
            faqTab.addEventListener('shown.bs.tab', () => {
                this.loadFAQs();
            });
        }
        
        if (statusTab) {
            statusTab.addEventListener('shown.bs.tab', () => {
                if (accountStatusResult) {
                    accountStatusResult.classList.add('d-none');
                }
                if (statusSchoolId) {
                    statusSchoolId.value = '';
                }
            });
        }

        if (registrationStatusTab) {
            registrationStatusTab.addEventListener('shown.bs.tab', () => {
                const registrationStatusResult = document.getElementById('registrationStatusResult');
                const regStatusSchoolId = document.getElementById('regStatusSchoolId');
                if (registrationStatusResult) {
                    registrationStatusResult.classList.add('d-none');
                }
                if (regStatusSchoolId) {
                    regStatusSchoolId.value = '';
                }
            });
        }

        this.setupRegistrationStatusCheck();

        if (checkStatusBtn && statusSchoolId) {
            checkStatusBtn.addEventListener('click', async () => {
                const schoolId = statusSchoolId.value.trim();
                if (!schoolId) {
                    if (window.Swal) {
                        Swal.fire({ icon: 'info', title: 'Student ID required', text: 'Please enter a valid School ID.', confirmButtonColor: '#0a8f1b' });
                    } else {
                        alert('Please enter a Student ID');
                    }
                    return;
                }

                // Validate school ID format: XX-YYYY-NNNN (2 digits, 4 digits, 4-6 digits)
                if (!this.validateSchoolIdFormat(statusSchoolId)) {
                    if (window.Swal) {
                        Swal.fire({ 
                            icon: 'error', 
                            title: 'Invalid School ID format', 
                            text: 'School ID must follow the format: XX-YYYY-NNNN (e.g., 01-2020-00062)', 
                            confirmButtonColor: '#0a8f1b' 
                        });
                    } else {
                        alert('Invalid School ID format. Must be: XX-YYYY-NNNN');
                    }
                    statusSchoolId.focus();
                    return;
                }

                try {
                    const response = await ApiService.get('/auth/auth-check-application-status.php', {
                        school_id: schoolId
                    });

                    if (accountStatusResult) {
                        accountStatusResult.classList.remove('d-none');
                        const statusContent = document.getElementById('statusContent');
                        if (statusContent) {
                            const badgeClass = this.getStatusBadgeClass(response.status);
                            if (response.success) {
                                const applicationDate = this.formatLoanStatusDate(response.application_date);
                                const lastUpdated = this.formatLoanStatusDate(response.updated_at);
                                statusContent.innerHTML = `
                                    <div class="card border-0 shadow-sm">
                                        <div class="card-body p-3">
                                            <div class="d-flex align-items-center justify-content-between mb-2">
                                                <div class="fw-semibold">Application Status</div>
                                                <span class="badge ${badgeClass}">${escapeHtml(response.status || 'N/A')}</span>
                                            </div>
                                            <ul class="list-group list-group-flush small">
                                                <li class="list-group-item px-0 d-flex justify-content-between">
                                                    <span class="text-muted">Application No</span>
                                                    <span class="fw-medium">${escapeHtml(response.application_no || 'N/A')}</span>
                                                </li>
                                                <li class="list-group-item px-0 d-flex justify-content-between">
                                                    <span class="text-muted">Balance</span>
                                                    <span class="fw-medium">₱${escapeHtml(response.balance || '0.00')}</span>
                                                </li>
                                                <li class="list-group-item px-0 d-flex justify-content-between">
                                                    <span class="text-muted">Amount to Pay</span>
                                                    <span class="fw-medium">₱${escapeHtml(response.amount || '0.00')}</span>
                                                </li>
                                                <li class="list-group-item px-0 d-flex justify-content-between">
                                                    <span class="text-muted">Application Date</span>
                                                    <span class="fw-medium">${applicationDate}</span>
                                                </li>
                                                <li class="list-group-item px-0 d-flex justify-content-between">
                                                    <span class="text-muted">Last Updated</span>
                                                    <span class="fw-medium">${lastUpdated}</span>
                                                </li>
                                            </ul>
                                        </div>
                                    </div>
                                `;
                            } else {
                                statusContent.innerHTML = `
                                    <div class="alert alert-warning mb-0" role="alert">
                                        ${escapeHtml(response.message || 'No application found')}
                                    </div>
                                `;
                            }
                        }
                    }
                } catch (error) {
                    if (accountStatusResult) {
                        accountStatusResult.classList.remove('d-none');
                        const statusContent = document.getElementById('statusContent');
                        if (statusContent) {
                            statusContent.innerHTML = `
                                <div class="text-danger small">
                                    Error checking application status
                                </div>
                            `;
                        }
                    }
                }
            });
        }
    }

    setupRegistrationStatusCheck() {
        const checkRegStatusBtn = document.getElementById('checkRegStatusBtn');
        const regStatusSchoolId = document.getElementById('regStatusSchoolId');
        const registrationStatusResult = document.getElementById('registrationStatusResult');

        if (!checkRegStatusBtn || !regStatusSchoolId) return;

        checkRegStatusBtn.addEventListener('click', async () => {
            const schoolId = regStatusSchoolId.value.trim();
            if (!schoolId) {
                if (window.Swal) {
                    Swal.fire({ icon: 'info', title: 'Student ID required', text: 'Please enter a valid School ID.', confirmButtonColor: '#0a8f1b' });
                } else {
                    alert('Please enter a Student ID');
                }
                return;
            }

            if (!this.validateSchoolIdFormat(regStatusSchoolId)) {
                if (window.Swal) {
                    Swal.fire({
                        icon: 'error',
                        title: 'Invalid School ID format',
                        text: 'School ID must follow the format: XX-YYYY-NNNN (e.g., 01-2020-00062)',
                        confirmButtonColor: '#0a8f1b',
                    });
                } else {
                    alert('Invalid School ID format. Must be: XX-YYYY-NNNN');
                }
                regStatusSchoolId.focus();
                return;
            }

            try {
                const response = await ApiService.get('/auth/auth-check-registration-status.php', {
                    school_id: schoolId,
                });

                if (registrationStatusResult) {
                    registrationStatusResult.classList.remove('d-none');
                    const registrationStatusContent = document.getElementById('registrationStatusContent');
                    if (!registrationStatusContent) return;

                    if (response.success) {
                        const badgeClass = this.getRegistrationBadgeClass(response.status_key || response.status);
                        const submittedAt = this.formatLoanStatusDate(response.submitted_at);
                        const updatedAt = this.formatLoanStatusDate(response.updated_at);
                        registrationStatusContent.innerHTML = `
                            <div class="card border-0 shadow-sm">
                                <div class="card-body p-3">
                                    <div class="d-flex align-items-center justify-content-between mb-2">
                                        <div class="fw-semibold">Registration Status</div>
                                        <span class="badge ${badgeClass}">${escapeHtml(response.status || 'N/A')}</span>
                                    </div>
                                    <p class="small text-muted mb-3">${escapeHtml(response.message || '')}</p>
                                    <ul class="list-group list-group-flush small">
                                        <li class="list-group-item px-0 d-flex justify-content-between">
                                            <span class="text-muted">Student</span>
                                            <span class="fw-medium text-end">${escapeHtml(response.student_name || 'N/A')}</span>
                                        </li>
                                        <li class="list-group-item px-0 d-flex justify-content-between">
                                            <span class="text-muted">School ID</span>
                                            <span class="fw-medium">${escapeHtml(response.school_id || schoolId)}</span>
                                        </li>
                                        <li class="list-group-item px-0 d-flex justify-content-between">
                                            <span class="text-muted">Program</span>
                                            <span class="fw-medium text-end">${escapeHtml(response.program || 'N/A')}</span>
                                        </li>
                                        <li class="list-group-item px-0 d-flex justify-content-between">
                                            <span class="text-muted">Campus</span>
                                            <span class="fw-medium text-end">${escapeHtml(response.campus || 'N/A')}</span>
                                        </li>
                                        <li class="list-group-item px-0 d-flex justify-content-between">
                                            <span class="text-muted">Submitted</span>
                                            <span class="fw-medium">${submittedAt}</span>
                                        </li>
                                        <li class="list-group-item px-0 d-flex justify-content-between">
                                            <span class="text-muted">Last Updated</span>
                                            <span class="fw-medium">${updatedAt}</span>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        `;
                    } else {
                        registrationStatusContent.innerHTML = `
                            <div class="alert alert-warning mb-0" role="alert">
                                ${escapeHtml(response.message || 'No registration found')}
                            </div>
                        `;
                    }
                }
            } catch (error) {
                if (registrationStatusResult) {
                    registrationStatusResult.classList.remove('d-none');
                    const registrationStatusContent = document.getElementById('registrationStatusContent');
                    if (registrationStatusContent) {
                        registrationStatusContent.innerHTML = `
                            <div class="text-danger small">
                                Error checking registration status
                            </div>
                        `;
                    }
                }
            }
        });
    }

    formatLoanStatusDate(dateString) {
        if (!dateString) return 'N/A';
        const raw = String(dateString).trim();
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            const dt = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
            if (!Number.isNaN(dt.getTime())) {
                return escapeHtml(dt.toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                }));
            }
        }
        const ts = Date.parse(raw);
        if (!Number.isNaN(ts)) {
            return escapeHtml(new Date(ts).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric'
            }));
        }
        return escapeHtml(raw);
    }

    getStatusBadgeClass(status) {
        const s = (status || '').toLowerCase();
        if (s.includes('approved') || s.includes('completed')) return 'text-bg-success';
        if (s.includes('declined') || s.includes('returned') || s.includes('not approved') || s.includes('rejected')) return 'text-bg-danger';
        if (s.includes('review') || s.includes('pending')) return 'text-bg-warning';
        if (s.includes('endorsed')) return 'text-bg-info';
        return 'text-bg-secondary';
    }

    getRegistrationBadgeClass(statusKey) {
        const key = (statusKey || '').toLowerCase();
        if (key === 'approved') return 'text-bg-success';
        if (key === 'rejected') return 'text-bg-danger';
        if (key === 'pending' || key === 'pending_finance') return 'text-bg-warning';
        return 'text-bg-secondary';
    }

    validateSchoolIdFormat(inputElement) {
        if (!inputElement) return false;
        const schoolId = inputElement.value.trim();
        const schoolIdPattern = /^\d{2}-\d{4}-\d{4,6}$/;
        
        // Border-only feedback (no Bootstrap is-valid icon inside the field)
        inputElement.classList.remove('border-success', 'border-danger', 'is-valid', 'is-invalid');
        
        if (schoolId === '') {
            return false;
        }
        
        if (schoolIdPattern.test(schoolId)) {
            inputElement.classList.add('border-success');
            return true;
        }

        inputElement.classList.add('border-danger');
        return false;
    }

    loadFAQs() {
        const faqAccordion = document.getElementById('faqAccordion');
        if (!faqAccordion) return;

        // Check if FAQs are already loaded
        if (faqAccordion.children.length > 0) {
            return;
        }

        const faqs = [
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
                answer: 'Approved loan amounts must be paid on or before the due date, which is typically within 30 days from the approval date. The exact due date will be specified in your loan approval notification.'
            },
            {
                id: 'faq8b',
                question: 'How do I check my registration status?',
                answer: 'Click the Quick Help button (info icon) at the bottom right of the login page, open the Registration tab, and enter your School ID to check your registration. You can sign in after CSDL approval, but must wait for Assessment to set up your balance before applying for a loan.'
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
                answer: 'You can check your loan status by clicking the "Quick Help" button (info icon) at the bottom right of the login page, then navigate to the "Loan Status" tab. Enter your Student ID to view your current application status and details.'
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
                answer: 'Click on the "Forgot Password?" link below the login form. You will be guided through the password recovery process. Make sure you have access to your registered email or contact the system administrator for assistance.'
            },
            {
                id: 'faq16',
                question: 'Can I apply for multiple loans?',
                answer: 'You can apply for a loan for each application period. However, you must ensure that any previous loans are paid or in good standing. The system will show your current loan status when you apply.'
            }
        ];

        // Clear existing FAQs
        faqAccordion.innerHTML = '';

        // Render FAQs
        faqs.forEach((faq, index) => {
            const accordionItem = document.createElement('div');
            accordionItem.className = 'accordion-item';
            accordionItem.innerHTML = `
                <h2 class="accordion-header" id="heading${faq.id}">
                    <button class="accordion-button ${index === 0 ? '' : 'collapsed'}" type="button" data-bs-toggle="collapse" data-bs-target="#collapse${faq.id}" aria-expanded="${index === 0 ? 'true' : 'false'}" aria-controls="collapse${faq.id}">
                        ${escapeHtml(faq.question)}
                    </button>
                </h2>
                <div id="collapse${faq.id}" class="accordion-collapse collapse ${index === 0 ? 'show' : ''}" aria-labelledby="heading${faq.id}" data-bs-parent="#faqAccordion">
                    <div class="accordion-body">
                        ${escapeHtml(faq.answer)}
                    </div>
                </div>
            `;
            faqAccordion.appendChild(accordionItem);
        });
    }

    async promptPasswordChange(user, reason = 'default') {
        if (this._passwordChangePromise) return this._passwordChangePromise;
        // Release the overlay before waiting for input in the modal beneath it.
        finishAuthGate();
        if (!window.Swal) {
            this.showError('The password change form could not load. Please refresh the page to continue.');
            return;
        }
        this._passwordChangePromise = this.showPasswordChangeDialog(user, reason);
        try {
            return await this._passwordChangePromise;
        } finally {
            this._passwordChangePromise = null;
        }
    }

    async showPasswordChangeDialog(user, reason) {

        const isExpired = reason === 'expired';
        const explanation = isExpired
            ? 'Your password has reached the 30-day limit. Please create a different password to continue.'
            : 'You are using the default password. Please set a strong password for security.';

        const { isConfirmed, value: passwordChangeResponse } = await Swal.fire({
            title: 'Change Your Password',
            html: `
                <p class="text-start mb-3">${explanation}</p>
                <div class="mb-3 text-start">
                    <label class="form-label small" for="swal-new-password">New Password</label>
                    <div class="input-group">
                        <input id="swal-new-password" type="password" class="form-control" placeholder="Enter new password" autocomplete="new-password" enterkeyhint="done">
                        <button type="button" class="btn btn-outline-secondary" id="swal-toggle-new-password" aria-label="Show new password" aria-pressed="false" style="border-left: none;">
                            <i class="bi bi-eye-slash" id="swal-toggle-new-password-icon"></i>
                        </button>
                    </div>
                </div>
                <div class="mb-3 text-start">
                    <label class="form-label small" for="swal-confirm-password">Confirm Password</label>
                    <div class="input-group">
                        <input id="swal-confirm-password" type="password" class="form-control" placeholder="Confirm new password" autocomplete="new-password" enterkeyhint="done">
                        <button type="button" class="btn btn-outline-secondary" id="swal-toggle-confirm-password" aria-label="Show confirm password" aria-pressed="false" style="border-left: none;">
                            <i class="bi bi-eye-slash" id="swal-toggle-confirm-password-icon"></i>
                        </button>
                    </div>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: false,
            allowOutsideClick: () => !Swal.isLoading(),
            allowEscapeKey: () => !Swal.isLoading(),
            allowEnterKey: false,
            confirmButtonText: 'Change Password',
            showLoaderOnConfirm: true,
            confirmButtonColor: '#0a8f1b',
            didOpen: () => {
                const newPasswordInput = document.getElementById('swal-new-password');
                const confirmPasswordInput = document.getElementById('swal-confirm-password');
                const toggleNewBtn = document.getElementById('swal-toggle-new-password');
                const toggleConfirmBtn = document.getElementById('swal-toggle-confirm-password');
                const toggleNewIcon = document.getElementById('swal-toggle-new-password-icon');
                const toggleConfirmIcon = document.getElementById('swal-toggle-confirm-password-icon');
                
                if (newPasswordInput) newPasswordInput.focus();

                Swal.getPopup()?.addEventListener('keydown', (event) => {
                    if (event.key === 'Tab') {
                        const controls = [newPasswordInput, toggleNewBtn, confirmPasswordInput, toggleConfirmBtn, Swal.getConfirmButton()]
                            .filter((element) => element && !element.disabled);
                        if (!controls.length) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const current = controls.indexOf(document.activeElement);
                        const next = current === -1
                            ? (event.shiftKey ? controls.length - 1 : 0)
                            : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
                        controls[next].focus();
                        return;
                    }
                    if (event.key !== 'Enter' || event.isComposing) return;
                    const target = event.target;
                    const isInput = target === newPasswordInput || target === confirmPasswordInput;
                    const isToggle = target === toggleNewBtn || target === toggleConfirmBtn;
                    if (!isInput && !isToggle && target !== Swal.getConfirmButton()) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.repeat || Swal.isLoading()) return;
                    if (isToggle) target.click();
                    else Swal.clickConfirm();
                }, true);
                
                // Toggle for new password
                if (toggleNewBtn && newPasswordInput && toggleNewIcon) {
                    let isNewVisible = false;
                    toggleNewBtn.addEventListener('click', () => {
                        isNewVisible = !isNewVisible;
                        newPasswordInput.type = isNewVisible ? 'text' : 'password';
                        toggleNewBtn.setAttribute('aria-pressed', String(isNewVisible));
                        toggleNewBtn.setAttribute('aria-label', isNewVisible ? 'Hide new password' : 'Show new password');
                        toggleNewIcon.classList.toggle('bi-eye', isNewVisible);
                        toggleNewIcon.classList.toggle('bi-eye-slash', !isNewVisible);
                    });
                }
                
                // Toggle for confirm password
                if (toggleConfirmBtn && confirmPasswordInput && toggleConfirmIcon) {
                    let isConfirmVisible = false;
                    toggleConfirmBtn.addEventListener('click', () => {
                        isConfirmVisible = !isConfirmVisible;
                        confirmPasswordInput.type = isConfirmVisible ? 'text' : 'password';
                        toggleConfirmBtn.setAttribute('aria-pressed', String(isConfirmVisible));
                        toggleConfirmBtn.setAttribute('aria-label', isConfirmVisible ? 'Hide confirm password' : 'Show confirm password');
                        toggleConfirmIcon.classList.toggle('bi-eye', isConfirmVisible);
                        toggleConfirmIcon.classList.toggle('bi-eye-slash', !isConfirmVisible);
                    });
                }
            },
            preConfirm: async () => {
                const newPassword = document.getElementById('swal-new-password')?.value || '';
                const confirmPassword = document.getElementById('swal-confirm-password')?.value || '';
                
                if (!newPassword || !confirmPassword) {
                    Swal.showValidationMessage('Please fill in all fields');
                    return false;
                }

                if (newPassword !== confirmPassword) {
                    Swal.showValidationMessage('Passwords do not match');
                    return false;
                }

                // Validate password strength
                const errors = [];
                if (newPassword.length < 8) {
                    errors.push('Password must be at least 8 characters long');
                }
                if (!/[A-Z]/.test(newPassword)) {
                    errors.push('Password must contain at least one uppercase letter');
                }
                if (!/[a-z]/.test(newPassword)) {
                    errors.push('Password must contain at least one lowercase letter');
                }
                if (!/[0-9]/.test(newPassword)) {
                    errors.push('Password must contain at least one number');
                }
                if (!/[^A-Za-z0-9]/.test(newPassword)) {
                    errors.push('Password must contain at least one special character');
                }

                if (errors.length > 0) {
                    Swal.showValidationMessage(errors.join('<br>'));
                    return false;
                }

                try {
                    await ApiService.refreshCSRFToken();
                    const response = await ApiService.post('/auth/auth-change-password.php', {
                        new_password: newPassword,
                        confirm_password: confirmPassword
                    });
                    if (response?.success !== true) {
                        Swal.showValidationMessage(escapeHtml(response?.message || 'Failed to change password. Please try again.'));
                        return false;
                    }
                    return response;
                } catch (error) {
                    Swal.showValidationMessage(escapeHtml(error?.response?.data?.message || 'Failed to change password. Please try again.'));
                    return false;
                }
            }
        });

        if (!isConfirmed) {
            try {
                const response = await ApiService.post('/auth/auth-logout.php');
                if (response?.success !== true) throw new Error('Could not cancel sign-in.');
            } catch (error) {
                console.error('Password-change dismissal sign-out failed:', error);
                window.location.reload();
                return;
            }
            try { sessionStorage.removeItem('user_session'); } catch (_) {}
            try { localStorage.removeItem('user_session'); } catch (_) {}
            const passwordInput = document.getElementById('password');
            if (passwordInput) passwordInput.value = '';
            this.resetTurnstile();
            this.setLoading(false);
            passwordInput?.focus();
            return;
        }

        if (passwordChangeResponse?.success === true) {
            this._redirected = true;
            const isStudent = user?.type === 'student';

            await Swal.fire({
                icon: 'success',
                title: 'Password Changed',
                text: isStudent
                    ? 'Your password has been changed successfully. Taking you to your dashboard.'
                    : 'Your password has been changed successfully. Please sign in again with your new password.',
                confirmButtonColor: '#0a8f1b',
                timer: 2000,
                timerProgressBar: true
            });

            if (isStudent && passwordChangeResponse?.require_login !== true) {
                window.location.replace(this.getDashboardUrl(user.role_id, user.type));
            } else {
                window.location.replace(AppPaths.page('views/auth/login.html'));
            }
        }
    }
}

export default LoginModule;
