import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import { renderStudentLoanDetails } from '../../shared/shared-student-loan-details.js?v=20260913-paid-partial-status';

class StudentsDashboardModule {
    constructor() {
        this.loans = [];
        this.loanApplicationPeriods = [];
        this.calendarDueDates = new Map();
        this.calendarExamDates = new Map();
        this.calendarEventsByDate = new Map();
        this.calendarPopoverHideTimer = null;
        this.currentPage = 1;
        this.itemsPerPage = 5;
        this.totalPages = 1;
        this.totalLoans = 0;
        this.recentLoansRequestId = 0;
        this.currentMonth = new Date().getMonth();
        this.currentYear = new Date().getFullYear();
        this.captchaAnswer = 0;
        this.otpTimer = null;
        this.otpTimerSeconds = 60;
        this.currentProfile = null;
        this.idValidationPassed = false; // Track if AI ID validation passed
        this.idValidationRequest = 0;
    }
    
    async init() {
        // Initialize CSRF token
        await this.initCSRFToken();
        await this.loadProfile();
        await this.loadLoanSummary();
        await this.loadRecentLoans();
        await this.loadCalendarEvents();
        await this.loadFormSettings();
        this.initCalendar();
        this.setupEventListeners();
        this.initCaptcha();
        this.updateSidebarProfile();
        await this.handleReapplyLoanFromUrl();
    }
    
    async initCSRFToken() {
        try {
            const token = await ApiService.refreshCSRFToken();
            if (!token) {
                console.warn('Failed to initialize CSRF token');
            }
        } catch (error) {
            console.error('Error initializing CSRF token:', error);
        }
    }
    
    async loadProfile() {
        try {
            const response = await ApiService.get('/students/students-dashboard.php', { action: 'profile' });
            if (response.success && response.profile) {
                const p = response.profile;
                const fullName = [p.student_first_name, p.student_middle_name, p.student_last_name].filter(Boolean).join(' ');
                
                // Update profile display
                const profileNameEl = document.getElementById('profileName');
                if (profileNameEl) profileNameEl.textContent = fullName;
                const profileNameDesktopEl = document.getElementById('profileNameDesktop');
                if (profileNameDesktopEl) profileNameDesktopEl.textContent = fullName;
                const roleText = p.student_type || 'Student';
                const profileRoleEl = document.getElementById('profileRole');
                if (profileRoleEl) profileRoleEl.textContent = roleText;
                const profileRoleDesktopEl = document.getElementById('profileRoleDesktop');
                if (profileRoleDesktopEl) profileRoleDesktopEl.textContent = roleText;
                
                const sid = p.student_school_id || '-';
                const profileStudentIdMobileEl = document.getElementById('profileStudentIdMobile');
                if (profileStudentIdMobileEl) profileStudentIdMobileEl.textContent = sid;
                const profileStudentIdDesktopEl = document.getElementById('profileStudentIdDesktop');
                if (profileStudentIdDesktopEl) profileStudentIdDesktopEl.textContent = sid;

                const profileProgramDesktopEl = document.getElementById('profileProgramDesktop');
                if (profileProgramDesktopEl) profileProgramDesktopEl.textContent = p.program_name || '-';

                const profileYearLevelDesktopEl = document.getElementById('profileYearLevelDesktop');
                if (profileYearLevelDesktopEl) profileYearLevelDesktopEl.textContent = p.year_level_name || '-';
                
                // Update avatar with profile image if exists
                const profilePhotoEl = document.getElementById('profilePhoto');
                const profilePhotoDesktopEl = document.getElementById('profilePhotoDesktop');
                if (profilePhotoEl) {
                    if (p.student_profile_image) {
                        profilePhotoEl.src = '../../' + p.student_profile_image;
                    } else {
                        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=198754&color=fff&size=100`;
                        profilePhotoEl.src = avatarUrl;
                    }
                }
                if (profilePhotoDesktopEl) {
                    if (p.student_profile_image) {
                        profilePhotoDesktopEl.src = '../../' + p.student_profile_image;
                    } else {
                        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=198754&color=fff&size=120`;
                        profilePhotoDesktopEl.src = avatarUrl;
                    }
                }
                
                // Store profile data for sidebar update
                this.currentProfile = p;
                this.updateSidebarProfile();
            }
        } catch (error) {
            console.error('Error loading profile:', error);
        }
    }
    
    updateSidebarProfile() {
        const name = document.getElementById('profileName')?.textContent || 'Student';
        const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
        const headerAvatar = document.getElementById('headerUserAvatarImg');
        const sidebarName = document.getElementById('sidebarProfileName');
        
        // Use profile image if available
        if (this.currentProfile && this.currentProfile.student_profile_image) {
            const imagePath = '../../' + this.currentProfile.student_profile_image;
            if (sidebarAvatar) sidebarAvatar.src = imagePath;
            if (headerAvatar) headerAvatar.src = imagePath;
        } else {
            // Use default avatar
            const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=64`;
            if (sidebarAvatar) sidebarAvatar.src = avatarUrl;
            if (headerAvatar) headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=28`;
        }
        
        if (sidebarName) sidebarName.textContent = name;
    }
    
    async loadBalancesModalData() {
        const loadingEl = document.getElementById('balancesLoading');
        const contentEl = document.getElementById('balancesContent');
        const errorEl = document.getElementById('balancesError');

        if (loadingEl) loadingEl.style.display = 'block';
        if (contentEl) contentEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';

        try {
            const response = await ApiService.get('/students/students-dashboard.php', { action: 'balance' });

            if (response.success && !response.balance) {
                if (loadingEl) loadingEl.style.display = 'none';
                const infoContentEl = document.getElementById('balanceInfoContent');
                if (infoContentEl) infoContentEl.textContent = 'Assessment has not set up your balance yet. You can use your account, but must wait for your balance before applying for a loan.';
                if (contentEl) contentEl.style.display = 'block';
                return;
            }
            if (!response.success) {
                if (loadingEl) loadingEl.style.display = 'none';
                if (errorEl) errorEl.style.display = 'block';
                return;
            }

            const b = response.balance;
            const fmt = (val) => `₱${parseFloat(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

            const infoContentEl = document.getElementById('balanceInfoContent');
            if (infoContentEl) {
                infoContentEl.innerHTML = this.renderBalanceDetails(b, fmt);
            }

            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = 'block';
        } catch (error) {
            console.error('Error loading balances:', error);
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) errorEl.style.display = 'block';
        }
    }

    async loadLoansModalData() {
        const loadingEl = document.getElementById('loansLoading');
        const contentEl = document.getElementById('loansContent');
        const errorEl = document.getElementById('loansError');
        const infoContentEl = document.getElementById('loansInfoContent');

        if (loadingEl) loadingEl.style.display = 'block';
        if (contentEl) contentEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';

        try {
            const response = await ApiService.get('/students/students-loans.php', {
                action: 'list',
                page: 1,
                perPage: 10
            });

            if (!response.success || !Array.isArray(response.loans)) {
                if (loadingEl) loadingEl.style.display = 'none';
                if (errorEl) errorEl.style.display = 'block';
                return;
            }

            if (infoContentEl) {
                infoContentEl.innerHTML = this.renderLoansModalTable(response.loans);
            }

            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = 'block';
        } catch (error) {
            console.error('Error loading loans list:', error);
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) errorEl.style.display = 'block';
        }
    }

    renderLoansModalTable(loans) {
        if (!loans || loans.length === 0) {
            return `
                <div class="text-center py-5">
                    <h6 class="text-muted small mb-1">No loan applications yet</h6>
                    <p class="text-muted small mb-0">Your applications will appear here.</p>
                </div>
            `;
        }

        const sortedLoans = [...loans].sort((a, b) => {
            const dateA = new Date(a.loan_application_date || 0).getTime();
            const dateB = new Date(b.loan_application_date || 0).getTime();
            if (dateA !== dateB) {
                return dateB - dateA;
            }
            return Number(b.loan_id || 0) - Number(a.loan_id || 0);
        });
        const latestLoan = sortedLoans[0];
        const latestLoanAmount = `₱${parseFloat(latestLoan.loan_amount_can_pay || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        // Attach click handler after modal content render.
        setTimeout(() => {
            const latestLoanCard = document.getElementById('latestLoanApplicationCard');
            if (latestLoanCard) {
                latestLoanCard.addEventListener('click', () => {
                    const id = parseInt(latestLoanCard.getAttribute('data-loan-id'), 10);
                    if (id) {
                        this.viewLoan(id);
                    }
                });
            }
        }, 0);

        return `
            <div class="students-modal-latest mb-3">
                <div class="students-modal-latest__label small text-muted fw-semibold mb-2">Latest Application</div>
                <button
                    type="button"
                    id="latestLoanApplicationCard"
                    data-loan-id="${latestLoan.loan_id}"
                    class="students-modal-latest__card w-100 text-start"
                    aria-label="View latest loan application"
                >
                    <div class="students-modal-latest__head d-flex flex-wrap align-items-start justify-content-between gap-2">
                        <div>
                            <div class="students-modal-latest__title fw-semibold text-dark">${escapeHtml(latestLoan.loan_application_no || '-')}</div>
                            <div class="students-modal-latest__meta small text-muted">Applied ${escapeHtml(this.formatDisplayDate(latestLoan.loan_application_date))}</div>
                        </div>
                        <span class="badge ${this.getStatusBadgeClass(latestLoan.loan_status_id)}">${escapeHtml(latestLoan.loan_status_name || '-')}</span>
                    </div>
                    <div class="students-modal-latest__foot d-flex flex-wrap align-items-center justify-content-between mt-2">
                        <div class="students-modal-latest__step small text-muted">${escapeHtml(latestLoan.current_step_name || '-')}</div>
                        <div class="students-modal-latest__amount fw-semibold text-success">${latestLoanAmount}</div>
                    </div>
                </button>
            </div>
        `;
    }
    
    async loadLoanSummary() {
        try {
            const response = await ApiService.get('/students/students-dashboard.php', { action: 'loan-summary' });
            if (response.success && response.summary) {
                const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
                set('summaryTotalLoans', response.summary.total);
                set('summaryPaidLoans', response.summary.paid);
                set('summaryActiveLoans', response.summary.active);
                set('summaryPendingLoans', response.summary.pending);
            }
        } catch (error) {
            console.error('Error loading loan summary:', error);
        }
    }
    
    async loadRecentLoans() {
        const requestId = ++this.recentLoansRequestId;
        try {
            const response = await ApiService.get('/students/students-dashboard.php', { 
                action: 'recent', 
                page: this.currentPage,
                limit: this.itemsPerPage 
            });
            
            if (requestId !== this.recentLoansRequestId) return;
            if (response.success) {
                this.loans = response.loans || [];
                this.totalPages = Math.max(1, Number(response.totalPages) || 1);
                this.totalLoans = response.total || 0;
                if (this.currentPage > this.totalPages) {
                    this.currentPage = this.totalPages;
                    return this.loadRecentLoans();
                }
                this.renderLoanHistory();
                this.updatePagination();
            }
        } catch (error) {
            if (requestId !== this.recentLoansRequestId) return;
            console.error('Error loading recent loans:', error);
            this.renderLoanHistoryError();
        }
    }

    async loadCalendarEvents() {
        try {
            const response = await ApiService.get('/students/students-dashboard.php', {
                action: 'calendar',
                year: this.currentYear,
                month: this.currentMonth + 1
            });

            this.calendarDueDates = new Map();
            this.calendarExamDates = new Map();
            this.calendarEventsByDate = new Map();

            if (response.success) {
                (response.due_dates || []).forEach((entry) => {
                    const dateKey = typeof entry === 'string' ? entry : entry?.date;
                    if (!dateKey) return;

                    const loans = typeof entry === 'object' ? (entry.loans || []) : [];
                    this.calendarDueDates.set(dateKey, loans);

                    const existing = this.calendarEventsByDate.get(dateKey) || { dueLoans: [], exams: [] };
                    existing.dueLoans = loans;
                    this.calendarEventsByDate.set(dateKey, existing);
                });

                (response.exam_dates || []).forEach((entry) => {
                    if (!entry?.date) return;
                    const items = entry.items || [];
                    this.calendarExamDates.set(entry.date, items);

                    const existing = this.calendarEventsByDate.get(entry.date) || { dueLoans: [], exams: [] };
                    existing.exams = items;
                    this.calendarEventsByDate.set(entry.date, existing);
                });
            }
        } catch (error) {
            console.error('Error loading calendar events:', error);
            this.calendarDueDates = new Map();
            this.calendarExamDates = new Map();
            this.calendarEventsByDate = new Map();
        }
    }

    formatCalendarMoney(value) {
        const amount = parseFloat(value || 0);
        return `₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    getCalendarDueBadgeHtml(loan = {}) {
        const paymentStatus = String(loan.payment_status || '').trim();
        if (paymentStatus === 'Paid') {
            return '<span class="badge bg-success">Paid</span>';
        }
        if (paymentStatus === 'Partial Payment') {
            return '<span class="badge bg-warning text-dark">Partial</span>';
        }
        if (paymentStatus === 'Paid Partial') {
            return '<span class="badge bg-warning text-dark">Paid Partial</span>';
        }
        if (paymentStatus === 'Paid Pending') {
            return '<span class="badge bg-info text-dark">Paid Pending</span>';
        }
        const pnStatus = String(loan.pn_status || '').trim();
        if (pnStatus === 'Tagged') {
            return '<span class="badge bg-success">PN Tagged</span>';
        }
        const statusId = Number(loan.status_id || 0);
        if (statusId === 5) {
            return '<span class="badge bg-success">Completed</span>';
        }
        if (statusId === 2) {
            return '<span class="badge bg-info text-white">Approved</span>';
        }
        const statusName = String(loan.status_name || '').trim();
        if (statusName) {
            return `<span class="badge bg-secondary">${escapeHtml(statusName)}</span>`;
        }
        return '<span class="badge bg-warning text-dark">Due</span>';
    }

    getCalendarDueMeta(loan = {}) {
        const paymentStatus = String(loan.payment_status || '').trim();
        if (paymentStatus && paymentStatus !== 'Not Paid') return paymentStatus;
        if (String(loan.pn_status || '').trim() === 'Tagged') return 'PN Tagged';
        return String(loan.status_name || 'Due date').trim();
    }

    getCalendarEventsForDate(dateKey) {
        const events = this.calendarEventsByDate.get(dateKey) || { dueLoans: [], exams: [] };
        const seenExams = new Set();
        const exams = (events.exams || []).filter((exam) => {
            const key = [
                exam.period_name || '',
                exam.sy_code || '',
                exam.exam_start_date || '',
                exam.exam_end_date || ''
            ].join('|');
            if (seenExams.has(key)) return false;
            seenExams.add(key);
            return true;
        });
        return { dueLoans: events.dueLoans || [], exams };
    }

    buildCalendarPopoverHtml(dateKey) {
        const events = this.getCalendarEventsForDate(dateKey);
        const sections = [];

        if (events.dueLoans.length > 0) {
            const items = events.dueLoans.slice(0, 2).map((loan) => `
                <li class="calendar-day-popover__item">
                    <span class="calendar-day-popover__item-title">${escapeHtml(loan.application_no || 'Loan')}</span>
                    <span class="calendar-day-popover__item-meta">${escapeHtml(this.getCalendarDueMeta(loan))} · ${this.formatCalendarMoney(loan.amount)}</span>
                </li>
            `).join('');
            const more = events.dueLoans.length > 2
                ? `<li class="calendar-day-popover__more">+${events.dueLoans.length - 2} more due</li>`
                : '';
            sections.push(`
                <div class="calendar-day-popover__section calendar-day-popover__section--due">
                    <div class="calendar-day-popover__label"><i class="bi bi-clock-history" aria-hidden="true"></i>Due date</div>
                    <ul class="calendar-day-popover__list">${items}${more}</ul>
                </div>
            `);
        }

        if (events.exams.length > 0) {
            const items = events.exams.slice(0, 2).map((exam) => `
                <li class="calendar-day-popover__item">
                    <span class="calendar-day-popover__item-title">${escapeHtml(exam.period_name || 'Periodical exam')}</span>
                    <span class="calendar-day-popover__item-meta">${escapeHtml(exam.sy_code || '')}</span>
                </li>
            `).join('');
            const more = events.exams.length > 2
                ? `<li class="calendar-day-popover__more">+${events.exams.length - 2} more exam</li>`
                : '';
            sections.push(`
                <div class="calendar-day-popover__section calendar-day-popover__section--exam">
                    <div class="calendar-day-popover__label"><i class="bi bi-mortarboard" aria-hidden="true"></i>Periodical exam</div>
                    <ul class="calendar-day-popover__list">${items}${more}</ul>
                </div>
            `);
        }

        return `
            <div class="calendar-day-popover__header">${escapeHtml(this.formatDisplayDate(dateKey))}</div>
            <div class="calendar-day-popover__body">${sections.join('')}</div>
            <div class="calendar-day-popover__footer">Click for full details</div>
        `;
    }

    showCalendarPopover(dayElement) {
        const popover = document.getElementById('calendarDayPopover');
        const dateKey = dayElement?.dataset?.dateKey;
        if (!popover || !dateKey) return;

        clearTimeout(this.calendarPopoverHideTimer);
        popover.innerHTML = this.buildCalendarPopoverHtml(dateKey);
        popover.hidden = false;
        popover.setAttribute('aria-hidden', 'false');

        const rect = dayElement.getBoundingClientRect();
        const popoverWidth = 240;
        let left = rect.left + (rect.width / 2) - (popoverWidth / 2);
        let top = rect.bottom + 8;

        left = Math.max(12, Math.min(left, window.innerWidth - popoverWidth - 12));
        if (top + 180 > window.innerHeight) {
            top = rect.top;
            popover.classList.add('is-above');
        } else {
            popover.classList.remove('is-above');
        }

        popover.style.width = `${popoverWidth}px`;
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
    }

    scheduleHideCalendarPopover() {
        clearTimeout(this.calendarPopoverHideTimer);
        this.calendarPopoverHideTimer = setTimeout(() => {
            const popover = document.getElementById('calendarDayPopover');
            if (popover && !popover.matches(':hover')) {
                this.hideCalendarPopover();
            }
        }, 140);
    }

    hideCalendarPopover() {
        const popover = document.getElementById('calendarDayPopover');
        if (!popover) return;
        popover.hidden = true;
        popover.setAttribute('aria-hidden', 'true');
        popover.innerHTML = '';
    }

    openCalendarEventModal(dateKey) {
        this.hideCalendarPopover();
        const modalEl = document.getElementById('calendarEventModal');
        const bodyEl = document.getElementById('calendarEventModalBody');
        if (!modalEl || !bodyEl) return;

        bodyEl.innerHTML = this.renderCalendarEventModalContent(dateKey);
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();

        bodyEl.querySelectorAll('[data-loan-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (loanId) {
                    modal.hide();
                    this.viewLoan(loanId);
                }
            });
        });
    }

    renderCalendarEventModalContent(dateKey) {
        const events = this.getCalendarEventsForDate(dateKey);
        const sections = [];

        if (events.dueLoans.length > 0) {
            const cards = events.dueLoans.map((loan) => `
                <div class="calendar-event-card calendar-event-card--due">
                    <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                        <div>
                            <div class="calendar-event-card__title">${escapeHtml(loan.application_no || 'Loan application')}</div>
                            <div class="calendar-event-card__subtitle text-muted small">${escapeHtml(loan.period_name || 'No period')}</div>
                        </div>
                        ${this.getCalendarDueBadgeHtml(loan)}
                    </div>
                    <div class="calendar-event-card__row">
                        <span class="text-muted small">Amount to pay</span>
                        <span class="fw-semibold">${this.formatCalendarMoney(loan.amount)}</span>
                    </div>
                    ${loan.loan_id ? `
                        <button type="button" class="btn btn-outline-success btn-sm mt-3 w-auto" style="align-self:flex-start;" data-loan-id="${loan.loan_id}">
                            View application
                        </button>
                    ` : ''}
                </div>
            `).join('');
            sections.push(`
                <div class="calendar-event-section mb-4">
                    <h6 class="calendar-event-section__title"><i class="bi bi-clock-history me-2 text-warning"></i>Due date</h6>
                    <div class="d-flex flex-column gap-2">${cards}</div>
                </div>
            `);
        }

        if (events.exams.length > 0) {
            const cards = events.exams.map((exam) => {
                const rangeStart = this.formatDisplayDate(exam.exam_start_date);
                const rangeEnd = this.formatDisplayDate(exam.exam_end_date || exam.exam_start_date);
                const rangeLabel = rangeStart === rangeEnd ? rangeStart : `${rangeStart} – ${rangeEnd}`;
                return `
                    <div class="calendar-event-card calendar-event-card--exam">
                        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                            <div>
                                <div class="calendar-event-card__title">${escapeHtml(exam.period_name || 'Periodical exam')}</div>
                                <div class="calendar-event-card__subtitle text-muted small">${escapeHtml(exam.sy_code || '')}</div>
                            </div>
                            <span class="badge bg-success">Exam</span>
                        </div>
                        <div class="calendar-event-card__row">
                            <span class="text-muted small">Exam period</span>
                            <span class="fw-semibold text-end">${escapeHtml(rangeLabel)}</span>
                        </div>
                    </div>
                `;
            }).join('');
            sections.push(`
                <div class="calendar-event-section">
                    <h6 class="calendar-event-section__title"><i class="bi bi-mortarboard me-2 text-success"></i>Periodical exam</h6>
                    <div class="d-flex flex-column gap-2">${cards}</div>
                </div>
            `);
        }

        if (sections.length === 0) {
            return '<p class="text-muted mb-0">No event details for this date.</p>';
        }

        return `
            <div class="calendar-event-modal-date mb-3">
                <span class="text-muted small d-block">Selected date</span>
                <span class="fw-semibold fs-5">${escapeHtml(this.formatDisplayDate(dateKey))}</span>
            </div>
            ${sections.join('')}
        `;
    }

    setupCalendarPopoverListeners() {
        if (this.calendarPopoverListenersBound) return;
        this.calendarPopoverListenersBound = true;

        const popover = document.getElementById('calendarDayPopover');
        if (popover) {
            popover.addEventListener('mouseenter', () => clearTimeout(this.calendarPopoverHideTimer));
            popover.addEventListener('mouseleave', () => this.hideCalendarPopover());
        }

        window.addEventListener('scroll', () => this.hideCalendarPopover(), { passive: true });
    }
    
    async loadFormSettings() {
        try {
            const response = await ApiService.get('/students/students-dashboard.php', { 
                action: 'form-settings'
            });
            
            if (response.success && response.settings) {
                // Update form description in the modal
                const formDescEl = document.querySelector('#loanApplicationModal .alert-info p.mb-2');
                if (formDescEl && response.settings.form_description) {
                    formDescEl.textContent = response.settings.form_description;
                }
                
                // Update instructions
                const instructionsEl = document.querySelector('#loanApplicationModal .alert-info ol');
                if (instructionsEl && response.settings.form_instructions) {
                    const instructions = response.settings.form_instructions.split('\n').filter(i => i.trim());
                    instructionsEl.innerHTML = instructions.map(inst => `<li class="small">${this.escapeHtml(inst)}</li>`).join('');
                }
                
                // Update modal title if form_title exists
                const modalTitleEl = document.querySelector('#loanApplicationModalLabel');
                if (modalTitleEl && response.settings.form_title) {
                    modalTitleEl.textContent = response.settings.form_title;
                }
            }
        } catch (error) {
            console.error('Error loading form settings:', error);
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatDisplayDate(value) {
        if (!value) return '-';
        const raw = String(value).trim();
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            const dt = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
            if (!Number.isNaN(dt.getTime())) {
                return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            }
        }
        const ts = Date.parse(raw);
        if (!Number.isNaN(ts)) {
            return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        }
        return raw;
    }
    
    renderLoanHistory() {
        const tbody = document.getElementById('loanHistoryTableBody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        if (this.loans.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-muted py-5">
                        <h6 class="text-muted small mb-1">No loan applications yet</h6>
                        <p class="text-muted small mb-0">Your recent applications will show here.</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        this.loans.forEach(loan => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.innerHTML = `
                <td class="text-nowrap ps-3" data-label="Application No.">${escapeHtml(loan.loan_application_no || '-')}</td>
                <td class="text-center text-nowrap" data-label="Amount to Pay">₱${parseFloat(loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                <td class="text-center" data-label="Status">
                    <span class="badge ${this.getStatusBadgeClass(loan.loan_status_id)}">${escapeHtml(loan.loan_status_name || '-')}</span>
                </td>
                <td class="text-center" data-label="Payment Status">
                    ${this.getPaymentStatusBadgeHtml(loan.payment_status)}
                </td>
                <td class="text-center" data-label="PN Status">
                    ${this.getPnStatusBadgeHtml(loan.pn_status)}
                </td>
                <td class="text-center text-nowrap" data-label="Due Date">${escapeHtml(this.formatDisplayDate(loan.loan_promised_payment_date))}</td>
                <td class="text-center" data-label="Period">${escapeHtml(loan.app_period_name || '-')}</td>
            `;
            
            row.addEventListener('click', () => {
                this.viewLoan(loan.loan_id);
            });
            
            tbody.appendChild(row);
        });
    }

    renderLoanHistoryError() {
        const tbody = document.getElementById('loanHistoryTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-danger py-5">
                        <h6 class="text-danger small mb-1">Couldn’t load loans</h6>
                        <p class="text-muted small mb-0">Please try again later.</p>
                    </td>
                </tr>
            `;
        }
    }
    
    getStatusBadgeClass(statusId) {
        const classes = {
            1: 'bg-warning text-dark', // Pending
            2: 'bg-success', // Approved
            5: 'bg-success', // Completed
            6: 'bg-warning text-dark', // Returned
            9: 'bg-secondary', // Cancelled
            11: 'bg-warning text-dark', // Partial Payment
            12: 'bg-success' // Endorsed - changed to green
        };
        return classes[statusId] || 'bg-secondary';
    }

    getPaymentStatusBadgeHtml(statusName) {
        const status = String(statusName || 'Not Paid').trim();
        const classes = {
            'Paid': 'bg-success',
            'Paid Pending': 'bg-info text-dark',
            'Paid Partial': 'bg-warning text-dark',
            'Partial Payment': 'bg-warning text-dark',
            'Not Paid': 'bg-secondary'
        };
        return `<span class="badge ${classes[status] || 'bg-secondary'}">${escapeHtml(status)}</span>`;
    }

    getPnStatusBadgeHtml(statusName) {
        const status = String(statusName || 'Not Tagged').trim();
        return `<span class="badge ${status === 'Tagged' ? 'bg-success' : 'bg-secondary'}">${escapeHtml(status)}</span>`;
    }
    
    updatePagination() {
        const pageInfo = document.getElementById('pageInfo');
        if (!pageInfo) return;
        
        const page = this.currentPage || 1;
        const perPage = this.itemsPerPage || 5;
        const total = this.totalLoans || 0;
        const start = total === 0 ? 0 : (page - 1) * perPage + 1;
        const end = Math.min(page * perPage, total);
        
        pageInfo.textContent = `Showing ${start} to ${end} of ${total} entries`;

        const nav = document.getElementById('recentLoansPagination');
        if (!nav) return;
        const pages = Math.max(1, this.totalPages);
        if (pages <= 1) {
            nav.innerHTML = '';
            return;
        }
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
        nav.innerHTML = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
    }
    
    initCalendar() {
        this.setupCalendarPopoverListeners();
        this.renderCalendar();
        
        const prevBtn = document.getElementById('prevMonth');
        const nextBtn = document.getElementById('nextMonth');
        const todayBtn = document.getElementById('todayBtn');
        
        if (prevBtn) {
            prevBtn.addEventListener('click', async () => {
                this.currentMonth--;
                if (this.currentMonth < 0) {
                    this.currentMonth = 11;
                    this.currentYear--;
                }
                await this.loadCalendarEvents();
                this.renderCalendar();
            });
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', async () => {
                this.currentMonth++;
                if (this.currentMonth > 11) {
                    this.currentMonth = 0;
                    this.currentYear++;
                }
                await this.loadCalendarEvents();
                this.renderCalendar();
            });
        }
        
        if (todayBtn) {
            todayBtn.addEventListener('click', async () => {
                const today = new Date();
                this.currentMonth = today.getMonth();
                this.currentYear = today.getFullYear();
                await this.loadCalendarEvents();
                this.renderCalendar();
            });
        }
    }
    
    renderCalendar() {
        const calendarBody = document.getElementById('calendarBody');
        const monthYear = document.getElementById('currentMonthYear');
        
        if (!calendarBody) return;
        
        const firstDay = new Date(this.currentYear, this.currentMonth, 1);
        const lastDay = new Date(this.currentYear, this.currentMonth + 1, 0);
        const daysInMonth = lastDay.getDate();
        const startingDayOfWeek = firstDay.getDay();
        
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                           'July', 'August', 'September', 'October', 'November', 'December'];
        if (monthYear) {
            monthYear.textContent = `${monthNames[this.currentMonth]} ${this.currentYear}`;
        }
        
        calendarBody.innerHTML = '';
        
        // Previous month's days
        const prevMonth = new Date(this.currentYear, this.currentMonth, 0);
        const daysInPrevMonth = prevMonth.getDate();
        for (let i = startingDayOfWeek - 1; i >= 0; i--) {
            const day = document.createElement('div');
            day.className = 'calendar-day other-month';
            day.textContent = daysInPrevMonth - i;
            calendarBody.appendChild(day);
        }
        
        // Build maps from calendar API data
        const dueDates = this.calendarDueDates || new Map();
        const examDates = this.calendarExamDates || new Map();

        // Current month's days
        const today = new Date();
        for (let day = 1; day <= daysInMonth; day++) {
            const dayElement = document.createElement('div');
            dayElement.className = 'calendar-day';
            
            const date = new Date(this.currentYear, this.currentMonth, day);
            const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            
            if (date.toDateString() === today.toDateString()) {
                dayElement.classList.add('today');
            }
            
            const hasDue = dueDates.has(dateKey);
            const hasExam = examDates.has(dateKey);

            if (hasDue) {
                dayElement.classList.add('has-due-date');
            }

            if (hasExam) {
                dayElement.classList.add('has-exam-date');
            }

            if (hasDue || hasExam) {
                dayElement.classList.add('calendar-day--interactive');
                dayElement.dataset.dateKey = dateKey;
                dayElement.setAttribute('role', 'button');
                dayElement.setAttribute('tabindex', '0');
                dayElement.setAttribute('aria-label', `${this.formatDisplayDate(dateKey)} calendar events`);

                dayElement.addEventListener('mouseenter', () => this.showCalendarPopover(dayElement));
                dayElement.addEventListener('mouseleave', () => this.scheduleHideCalendarPopover());
                dayElement.addEventListener('click', () => this.openCalendarEventModal(dateKey));
                dayElement.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.openCalendarEventModal(dateKey);
                    }
                });
            }

            const dayNumber = document.createElement('span');
            dayNumber.className = 'calendar-day__number';
            dayNumber.textContent = String(day);
            dayElement.appendChild(dayNumber);

            if (hasDue || hasExam) {
                const markers = document.createElement('span');
                markers.className = 'calendar-day__markers';
                markers.setAttribute('aria-hidden', 'true');
                if (hasDue) {
                    const dueMarker = document.createElement('span');
                    dueMarker.className = 'calendar-day__marker calendar-day__marker--due';
                    markers.appendChild(dueMarker);
                }
                if (hasExam) {
                    const examMarker = document.createElement('span');
                    examMarker.className = 'calendar-day__marker calendar-day__marker--exam';
                    markers.appendChild(examMarker);
                }
                dayElement.appendChild(markers);
            }

            calendarBody.appendChild(dayElement);
        }
        
        // Next month's days to fill the grid
        const totalCells = calendarBody.children.length;
        const remainingCells = 42 - totalCells; // 6 rows * 7 days
        for (let day = 1; day <= remainingCells && day <= 14; day++) {
            const dayElement = document.createElement('div');
            dayElement.className = 'calendar-day other-month';
            dayElement.textContent = day;
            calendarBody.appendChild(dayElement);
        }

        this.hideCalendarPopover();
    }
    
    initCaptcha() {
        this.generateCaptcha();
        
        const refreshBtn = document.getElementById('profileRefreshCaptcha');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                this.generateCaptcha();
            });
        }
    }
    
    generateCaptcha() {
        const num1 = Math.floor(Math.random() * 10) + 1;
        const num2 = Math.floor(Math.random() * 10) + 1;
        this.captchaAnswer = num1 + num2;
        
        const captcha1 = document.getElementById('profileCaptchaNum1');
        const captcha2 = document.getElementById('profileCaptchaNum2');
        const answerInput = document.getElementById('profileCaptchaAnswer');
        
        if (captcha1) captcha1.textContent = num1;
        if (captcha2) captcha2.textContent = num2;
        if (answerInput) answerInput.value = '';
    }
    
    setupEventListeners() {
        // Pagination
        const itemsPerPage = document.getElementById('itemsPerPage');
        
        if (itemsPerPage) {
            itemsPerPage.addEventListener('change', (e) => {
                this.itemsPerPage = parseInt(e.target.value, 10) || 5;
                this.currentPage = 1;
                this.loadRecentLoans();
            });
        }
        document.getElementById('recentLoansPagination')?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            const page = Number(button.dataset.page);
            if (page < 1 || page > this.totalPages || page === this.currentPage) return;
            this.currentPage = page;
            this.loadRecentLoans();
        });
        
        // Quick Actions - Set up window functions for modal opening
        window.openLoanApplicationModal = () => {
            this.loadLoanApplicationForm();
        };
        
        window.openBalancesModal = () => {
            const modalEl = document.getElementById('balancesModal');
            if (modalEl) {
                const modal = new bootstrap.Modal(modalEl);
                modal.show();
                this.loadBalancesModalData();
            }
        };

        
        window.openLoansModal = () => {
            const modalEl = document.getElementById('loansModal');
            if (modalEl) {
                const modal = new bootstrap.Modal(modalEl);
                modal.show();
                this.loadLoansModalData();
            }
        };
        
        const quickActionLoan = document.getElementById('quickActionLoan');
        const quickActionBalance = document.getElementById('quickActionBalance');
        
        if (quickActionLoan) {
            quickActionLoan.addEventListener('click', () => {
                window.openLoanApplicationModal();
            });
        }
        
        if (quickActionBalance) {
            quickActionBalance.addEventListener('click', () => {
                window.openBalancesModal();
            });
        }
        
        // Update form
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

        // Loan application form
        const loanApplicationForm = document.getElementById('loanApplicationForm');
        if (loanApplicationForm) {
            loanApplicationForm.addEventListener('submit', (e) => {
                this.handleLoanApplicationSubmit(e);
            });
        }

        // Character count for loan reason
        const loanReason = document.getElementById('loanReason');
        if (loanReason) {
            loanReason.addEventListener('input', (e) => {
                const charCount = document.getElementById('charCount');
                if (charCount) {
                    charCount.textContent = e.target.value.length;
                }
            });
        }

        // Parent/Guardian contact number validation - Philippine mobile numbers only (09xxxxxxxxx)
        const parentContactInput = document.getElementById('parentContact');
        if (parentContactInput) {
            parentContactInput.addEventListener('input', (e) => {
                const value = e.target.value;
                
                // Remove non-numeric characters
                const numericValue = value.replace(/[^0-9]/g, '');
                e.target.value = numericValue;
                
                // Validate Philippine mobile number format
                if (numericValue.length > 0) {
                    if (!numericValue.startsWith('09')) {
                        e.target.setCustomValidity('Philippine mobile numbers must start with 09');
                        e.target.classList.add('is-invalid');
                    } else if (numericValue.length === 11) {
                        e.target.setCustomValidity('');
                        e.target.classList.remove('is-invalid');
                    } else if (numericValue.length < 11) {
                        e.target.setCustomValidity('Mobile number must be exactly 11 digits');
                        e.target.classList.add('is-invalid');
                    } else {
                        e.target.setCustomValidity('');
                        e.target.classList.remove('is-invalid');
                    }
                } else {
                    e.target.setCustomValidity('');
                    e.target.classList.remove('is-invalid');
                }
            });
            
            // Validate on blur
            parentContactInput.addEventListener('blur', (e) => {
                const value = e.target.value;
                if (value.length > 0) {
                    if (!value.startsWith('09')) {
                        e.target.setCustomValidity('Philippine mobile numbers must start with 09');
                        e.target.classList.add('is-invalid');
                    } else if (value.length !== 11) {
                        e.target.setCustomValidity('Mobile number must be exactly 11 digits');
                        e.target.classList.add('is-invalid');
                    }
                }
            });
        }
        document.getElementById('relationship')?.addEventListener('change', () => this.updateSelectedFamilyMember());

        // Student contact number validation - Philippine mobile numbers only (09xxxxxxxxx)
        const studentContactInput = document.getElementById('contactNumber');
        if (studentContactInput) {
            studentContactInput.addEventListener('input', (e) => {
                const value = e.target.value;
                
                // Remove non-numeric characters
                const numericValue = value.replace(/[^0-9]/g, '');
                e.target.value = numericValue;
                
                // Validate Philippine mobile number format
                if (numericValue.length > 0) {
                    if (!numericValue.startsWith('09')) {
                        e.target.classList.add('is-invalid');
                    } else if (numericValue.length === 11) {
                        e.target.classList.remove('is-invalid');
                    } else if (numericValue.length < 11) {
                        e.target.classList.add('is-invalid');
                    } else {
                        e.target.classList.remove('is-invalid');
                    }
                } else {
                    e.target.classList.remove('is-invalid');
                }
            });
            
            // Validate on blur
            studentContactInput.addEventListener('blur', (e) => {
                const value = e.target.value;
                if (value.length > 0) {
                    if (!value.startsWith('09')) {
                        e.target.classList.add('is-invalid');
                    } else if (value.length !== 11) {
                        e.target.classList.add('is-invalid');
                    }
                }
            });
        }

        // Payment date validation
        const paymentDate = document.getElementById('paymentDate');
        if (paymentDate) {
            this.updatePaymentDateLimits();
            paymentDate.addEventListener('input', () => this.validatePaymentDate(paymentDate, false));
            paymentDate.addEventListener('change', () => this.validatePaymentDate(paymentDate, true));
            paymentDate.addEventListener('blur', () => this.validatePaymentDate(paymentDate, true));
        }

        const applicationPeriod = document.getElementById('applicationPeriod');
        if (applicationPeriod) {
            applicationPeriod.addEventListener('change', () => {
                this.updatePaymentDateLimits();
                if (paymentDate?.value) {
                    this.validatePaymentDate(paymentDate, true);
                }
            });
        }

        // Amount I can pay validation
        const amountCanPayInput = document.getElementById('amountCanPay');
        if (amountCanPayInput) {
            amountCanPayInput.addEventListener('input', (e) => {
                this.validateAmountCanPay(e.target);
            });
            
            amountCanPayInput.addEventListener('blur', (e) => {
                this.validateAmountCanPay(e.target);
            });
            
            amountCanPayInput.addEventListener('change', (e) => {
                this.validateAmountCanPay(e.target);
            });
        }

        // Guardian ID validation with OCR AI
        const parentNameInput = document.getElementById('parentName');
        const documentTypeSelect = document.getElementById('documentType');
        const idValidationBadge = document.getElementById('idValidationBadge');
        const validIdFileInput = document.getElementById('validIdFile');

        // Trigger OCR validation when file is uploaded
        if (validIdFileInput && parentNameInput && documentTypeSelect && idValidationBadge) {
            validIdFileInput.addEventListener('change', async () => {
                this.invalidateGuardianIdScreening();
                const file = validIdFileInput.files?.[0];
                const guardianName = parentNameInput.value.trim();
                const documentTypeId = parseInt(documentTypeSelect.value || '0', 10);

                if (!file) {
                    idValidationBadge.textContent = '';
                    idValidationBadge.className = 'd-none';
                    this.hideIdPreview();
                    return;
                }

                // Basic file validation
                const allowedExt = ['jpg', 'jpeg', 'png', 'gif', 'pdf'];
                const ext = file.name.split('.').pop()?.toLowerCase() || '';
                
                if (!allowedExt.includes(ext)) {
                    idValidationBadge.textContent = '';
                    idValidationBadge.className = 'd-none';
                    this.hideIdPreview();
                    Swal.fire({
                        icon: 'error',
                        title: 'Invalid file type',
                        text: 'Only JPG, PNG, GIF, and PDF files are allowed.',
                        confirmButtonText: 'OK'
                    });
                    return;
                }
                
                if (file.size > 5 * 1024 * 1024) {
                    idValidationBadge.textContent = '';
                    idValidationBadge.className = 'd-none';
                    this.hideIdPreview();
                    Swal.fire({
                        icon: 'error',
                        title: 'File is too large',
                        text: 'The maximum file size is 5MB.',
                        confirmButtonText: 'OK'
                    });
                    return;
                }

                // Show preview for images (not PDF)
                if (ext !== 'pdf') {
                    await this.showIdPreview(file);
                } else {
                    this.hideIdPreview();
                }

                // Check if guardian name and document type are provided
                if (!guardianName || documentTypeId <= 0) {
                    idValidationBadge.textContent = '';
                    idValidationBadge.className = 'd-none';
                    Swal.fire({
                        icon: 'info',
                        title: 'Complete the ID details',
                        text: 'Enter the parent or guardian name and select the document type before uploading the ID.',
                        confirmButtonText: 'OK'
                    });
                    return;
                }

                // Perform AI-based ID validation with OCR
                await this.validateGuardianIdWithOCR(guardianName, documentTypeId, file, idValidationBadge);
            });

            // Also re-validate when guardian name or document type changes (if file already uploaded)
            const reValidateOnChange = async () => {
                this.invalidateGuardianIdScreening();
                const file = validIdFileInput.files?.[0];
                const guardianName = parentNameInput.value.trim();
                const documentTypeId = parseInt(documentTypeSelect.value || '0', 10);
                
                if (file && guardianName && documentTypeId > 0) {
                    await this.validateGuardianIdWithOCR(guardianName, documentTypeId, file, idValidationBadge);
                } else if (idValidationBadge && !file) {
                    idValidationBadge.textContent = '';
                    idValidationBadge.className = 'd-none';
                }
            };

            if (parentNameInput) {
                parentNameInput.addEventListener('input', () => this.invalidateGuardianIdScreening());
                parentNameInput.addEventListener('blur', reValidateOnChange);
            }
            if (documentTypeSelect) {
                documentTypeSelect.addEventListener('change', reValidateOnChange);
            }
        }

        // Reset form when modal is closed
        const loanApplicationModal = document.getElementById('loanApplicationModal');
        if (loanApplicationModal) {
            loanApplicationModal.addEventListener('hidden.bs.modal', () => {
                this.invalidateGuardianIdScreening();
                const form = document.getElementById('loanApplicationForm');
                if (form) {
                    form.reset();
                    form.classList.remove('was-validated');
                    const charCount = document.getElementById('charCount');
                    if (charCount) {
                        charCount.textContent = '0';
                    }
                    
                    // Hide ID preview
                    this.hideIdPreview();
                    
                    // Clear validation badge
                    const validationBadge = document.getElementById('idValidationBadge');
                    if (validationBadge) {
                        validationBadge.textContent = '';
                        validationBadge.className = 'd-none';
                    }
                    
                    // Re-enable application period field
                    const periodSelect = document.getElementById('applicationPeriod');
                    if (periodSelect) {
                        periodSelect.disabled = false;
                        periodSelect.classList.remove('bg-light');
                        // Restore original name attribute
                        const originalName = periodSelect.getAttribute('data-original-name');
                        if (originalName) {
                            periodSelect.name = originalName;
                            periodSelect.removeAttribute('data-original-name');
                        }
                        // Reset help text
                        const helpText = periodSelect.nextElementSibling;
                        if (helpText && helpText.classList.contains('form-text')) {
                            helpText.innerHTML = 'Select the application period for this loan';
                        }
                    }
                    
                    // Remove hidden application period input if exists
                    const hiddenPeriodInput = document.getElementById('applicationPeriodHidden');
                    if (hiddenPeriodInput) {
                        hiddenPeriodInput.remove();
                    }
                    
                    // Re-enable file upload requirement
                    const fileInput = document.getElementById('validIdFile');
                    if (fileInput) {
                        fileInput.setAttribute('required', 'required');
                        const helpText = fileInput.nextElementSibling;
                        if (helpText && helpText.classList.contains('form-text')) {
                            helpText.innerHTML = 'Make sure that the file uploaded is clear and not your school ID. Accepted formats: JPG, PNG, PDF';
                        }
                    }
                    
                }
            });
        }
    }
    
    async handleProfileUpdate() {
        const captchaInput = parseInt(document.getElementById('profileCaptchaAnswer')?.value || 0);
        
        if (captchaInput !== this.captchaAnswer) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid Captcha',
                text: 'Please enter the correct answer.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
            this.generateCaptcha();
            return;
        }
        
        // Validate form fields
        const firstName = document.getElementById('updFirstName')?.value.trim();
        const lastName = document.getElementById('updLastName')?.value.trim();
        const contact = document.getElementById('updContact')?.value.trim();
        const email = document.getElementById('updEmail')?.value.trim();
        
        if (!firstName || !lastName || !contact || !email) {
            Swal.fire({
                icon: 'error',
                title: 'Validation Error',
                text: 'Please fill in all required fields (First Name, Last Name, Contact, Email).',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
            return;
        }
        
        try {
            // Send OTP
            const response = await ApiService.post('/students/students-profile-update.php', {
                action: 'send_otp'
            });
            
            if (response.success) {
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
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 3000
                });
            }
        } catch (error) {
            console.error('Error sending OTP:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to send OTP. Please try again.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
        }
    }
    
    startOtpTimer() {
        this.otpTimerSeconds = 60;
        const timerElement = document.getElementById('otpTimer');
        
        if (this.otpTimer) {
            clearInterval(this.otpTimer);
        }
        
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
                if (timerElement) {
                    timerElement.textContent = '0';
                }
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
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
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
        const email = document.getElementById('updEmail')?.value.trim();
        
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
                email: email
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
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 3000
                });
                
                // Reload profile to show updated data
                await this.loadProfile();
                this.generateCaptcha();
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to update profile. Please try again.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 3000
                });
            }
        } catch (error) {
            console.error('Error updating profile:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to update profile. Please try again.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
        }
    }
    
    async viewLoan(loanId) {
        try {
            // Check if we're coming from the loans modal and hide it
            const loansModalEl = document.getElementById('loansModal');
            let wasLoansModalOpen = false;
            if (loansModalEl) {
                const loansModal = bootstrap.Modal.getInstance(loansModalEl);
                if (loansModal) {
                    wasLoansModalOpen = true;
                    loansModal.hide();
                }
            }
            
            const response = await ApiService.get('/students/students-dashboard.php', { action: 'details', loanId });
            
            if (response.success) {
                const loan = response.loan;
                const modalEl = document.getElementById('viewLoanModal');
                if (!modalEl) return;
                
                const modal = new bootstrap.Modal(modalEl);
                const content = document.getElementById('loanDetailsContent');
                const footerEl = document.getElementById('loanDetailsFooter');
                
                if (content) {
                    content.innerHTML = renderStudentLoanDetails(loan, escapeHtml);
                    
                    // Add event listeners for view document buttons
                    setTimeout(() => {
                        const viewDocBtns = content.querySelectorAll('.view-document-btn');
                        viewDocBtns.forEach(btn => {
                            btn.addEventListener('click', () => {
                                const docPath = btn.getAttribute('data-doc-path');
                                const docName = btn.getAttribute('data-doc-name');
                                this.viewDocument(docPath, docName);
                            });
                        });
                    }, 0);
                }

                if (footerEl) {
                    const actions = [];
                    if (Number(loan.loan_status_id) === 1) {
                        actions.push(`<button type="button" class="btn btn-danger" onclick="window.studentsDashboardModule.cancelLoan(${loanId})">
                            <i class=""></i>Cancel Application
                        </button>`);
                    }
                    if (Number(loan.loan_status_id) === 6) {
                        actions.push(`<button type="button" class="btn btn-success" onclick="window.studentsDashboardModule.reapplyLoan(${loanId})">
                            Reapply Loan
                        </button>`);
                    }
                    actions.push('<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>');
                    footerEl.innerHTML = actions.join(' ');
                }
                
                // If we came from the loans modal, restore it when loan details modal is closed
                if (wasLoansModalOpen) {
                    modalEl.addEventListener('hidden.bs.modal', function restoreLoansModal() {
                        if (loansModalEl) {
                            const loansModal = new bootstrap.Modal(loansModalEl);
                            loansModal.show();
                        }
                        // Remove this event listener after it fires once
                        modalEl.removeEventListener('hidden.bs.modal', restoreLoansModal);
                    });
                }
                
                modal.show();
            }
        } catch (error) {
            console.error('Error loading loan details:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load loan details.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
        }
    }
    
    viewDocument(docPath, docName) {
        // Hide the loan details modal first
        const loanModalEl = document.getElementById('viewLoanModal');
        if (loanModalEl) {
            const loanModal = bootstrap.Modal.getInstance(loanModalEl);
            if (loanModal) {
                loanModal.hide();
            }
        }
        
        const modalEl = document.getElementById('viewDocumentModal');
        if (!modalEl) return;
        
        const modal = new bootstrap.Modal(modalEl);
        const titleEl = document.getElementById('viewDocumentModalLabel');
        const contentEl = document.getElementById('documentViewerContent');
        const downloadBtn = document.getElementById('downloadDocumentBtn');
        
        if (titleEl) {
            titleEl.textContent = docName || 'Document';
        }
        
        if (contentEl) {
            const fileExt = docPath.split('.').pop().toLowerCase();
            
            if (fileExt === 'pdf') {
                contentEl.innerHTML = `
                    <iframe src="${docPath}" class="w-100 h-100 border-0"></iframe>
                `;
            } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt)) {
                contentEl.innerHTML = `
                    <div class="d-flex align-items-center justify-content-center p-3 bg-light" style="min-height: 60vh;">
                        <img src="${docPath}" class="img-fluid rounded shadow-sm" alt="${docName}" style="max-width: 100%; height: auto;">
                    </div>
                `;
            } else {
                contentEl.innerHTML = `
                    <div class="d-flex align-items-center justify-content-center" style="min-height: 60vh;">
                        <div class="alert alert-info text-center">
                            <i class="bi bi-file-earmark fs-1 d-block mb-3"></i>
                            <p class="mb-2">Preview not available for this file type.</p>
                            <p class="small text-muted mb-0">Please use the download button to view the file.</p>
                        </div>
                    </div>
                `;
            }
        }
        
        if (downloadBtn) {
            downloadBtn.onclick = () => {
                // Create a temporary anchor element to trigger download
                const link = document.createElement('a');
                link.href = docPath;
                link.download = docName || 'document';
                link.target = '_blank';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            };
        }
        
        // When document modal is closed, show the loan details modal again
        modalEl.addEventListener('hidden.bs.modal', function showLoanModalAgain() {
            if (loanModalEl) {
                const loanModal = new bootstrap.Modal(loanModalEl);
                loanModal.show();
            }
            // Remove this event listener after it fires once
            modalEl.removeEventListener('hidden.bs.modal', showLoanModalAgain);
        });
        
        modal.show();
    }
    
    renderLoanDetails(loan) {
        return renderStudentLoanDetails(loan, escapeHtml);
    }

    async cancelLoan(loanId) {
        try {
            // eslint-disable-next-line no-undef
            const result = await Swal.fire({
                icon: 'warning',
                title: 'Cancel application?',
                text: 'This will cancel your pending loan application.',
                showCancelButton: true,
                confirmButtonColor: '#d33',
                cancelButtonColor: '#6c757d',
                confirmButtonText: 'Yes, cancel it',
                cancelButtonText: 'Keep it'
            });

            if (!result.isConfirmed) return;

            const response = await ApiService.post('/students/students-loans.php', { action: 'cancel', loanId });

            if (response.success) {
                const viewLoanModalEl = document.getElementById('viewLoanModal');
                if (viewLoanModalEl) {
                    const viewLoanModal = bootstrap.Modal.getInstance(viewLoanModalEl);
                    if (viewLoanModal) viewLoanModal.hide();
                }

                // Refresh data on dashboard
                await this.loadLoanSummary();
                await this.loadRecentLoans();
                await this.loadCalendarEvents();
                this.renderCalendar();

                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'success',
                    title: 'Cancelled',
                    text: 'Your loan application has been cancelled.',
                    confirmButtonColor: '#198754'
                });
            } else {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to cancel application.',
                    confirmButtonColor: '#198754'
                });
            }
        } catch (error) {
            console.error('Error cancelling loan:', error);
            
            // Show more detailed error message
            const errorMessage = error.response?.data?.message || 'An unexpected error occurred.';
            
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: errorMessage,
                confirmButtonColor: '#198754'
            });
        }
    }

    renderBalanceDetails(balance, fmt) {
        return `
            <div class="row">
                <div class="col-md-6 mb-3 mb-md-0">
                    <h6 class="fw-semibold text-dark mb-3">Balance Information</h6>
                    <div class="mb-3">
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Previous Balance:</span>
                            <span class="fw-semibold">${fmt(balance.previous_balance ?? '0.00')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Current Balance:</span>
                            <span class="fw-semibold">${fmt(balance.current_balance ?? '0.00')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2">
                            <span class="text-muted small">Total Balance:</span>
                            <span class="fw-semibold">${fmt(balance.total_balance ?? '0.00')}</span>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <h6 class="fw-semibold text-dark mb-3">Additional Information</h6>
                    <div class="mb-3">
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">School Year:</span>
                            <span class="fw-semibold">${balance.school_year || '-'}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2">
                            <span class="text-muted small">As of Date:</span>
                            <span class="fw-semibold">${this.formatDisplayDate(balance.as_of_date)}</span>
                        </div>
                    </div>
                </div>
            </div>
            <hr class="my-3">
            <div class="accordion accordion-flush" id="balanceFaqAccordion">
                <div class="accordion-item border-0">
                    <h2 class="accordion-header" id="balanceFaqHeading">
                        <button class="accordion-button collapsed px-0 py-2 bg-transparent shadow-none" type="button" data-bs-toggle="collapse" data-bs-target="#balanceFaqCollapse" aria-expanded="false" aria-controls="balanceFaqCollapse">
                            <i class="bi bi-question-circle me-2 text-success"></i>
                            <span class="fw-semibold">Balance FAQ</span>
                        </button>
                    </h2>
                    <div id="balanceFaqCollapse" class="accordion-collapse collapse" aria-labelledby="balanceFaqHeading" data-bs-parent="#balanceFaqAccordion">
                        <div class="accordion-body px-0 pt-2 pb-0">
                            <div class="balances-faq-item">
                                <h6 class="balances-faq-item__title small fw-semibold">Previous Balance</h6>
                                <p class="balances-faq-item__text small mb-2">Previous balance includes your previous semester and/or periodical balance.</p>
                            </div>
                            <div class="balances-faq-item">
                                <h6 class="balances-faq-item__title small fw-semibold">Current Balance</h6>
                                <p class="balances-faq-item__text small mb-2">Current balance covers your periodical balance.</p>
                            </div>
                            <div class="balances-faq-item mb-0">
                                <h6 class="balances-faq-item__title small fw-semibold">Total Balance</h6>
                                <p class="balances-faq-item__text small mb-0">Total balance is the sum of the previous and current balance.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    async loadLoanApplicationForm(reapplication = null) {
        try {
            // Show loading indicator
            Swal.fire({
                title: 'Loading...',
                text: 'Please wait',
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    Swal.showLoading();
                }
            });
            
            // First, fetch the data to check if student can apply
            const response = await ApiService.get('/students/students-loan-application.php', {
                _ts: Date.now()
            });
            
            if (!response.success) {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: 'Failed to load application form. Please try again.',
                    confirmButtonColor: '#198754'
                });
                return;
            }
            
            const data = response;
            this.loanApplicationPeriods = Array.isArray(data.applicationPeriods)
                ? data.applicationPeriods
                : [];

            if (data.loan_eligibility?.can_apply === false || !data.balance) {
                Swal.fire({
                    icon: 'info',
                    title: 'Awaiting balance setup',
                    text: data.loan_eligibility?.message || 'Please wait for Assessment to set up your balance before applying for a loan.',
                    confirmButtonText: 'OK',
                    confirmButtonColor: '#198754'
                });
                return;
            }
            
            // Check if there are available periods BEFORE opening modal
            const availablePeriods = this.loanApplicationPeriods.filter((period) =>
                !Boolean(period.already_applied) && !Boolean(period.cancellation_limit_reached)
            );
            
            if (!reapplication && availablePeriods.length === 0) {
                // Don't open the modal at all - just show validation message
                Swal.fire({
                    icon: 'warning',
                    title: 'Application already submitted',
                    text: 'You already have a loan application for the currently available application period. Only one application is allowed per period.',
                    confirmButtonText: 'OK',
                    confirmButtonColor: '#198754'
                });
                return;
            }
            
            // Close loading indicator
            Swal.close();
            
            // Now open the modal since validation passed
            const modalEl = document.getElementById('loanApplicationModal');
            let modal = null;
            if (modalEl) {
                modal = new bootstrap.Modal(modalEl);
                modal.show();
            }
            
            // Reset validation state when opening the form
            this.idValidationPassed = false;
            
            // Populate student information
            if (data.student) {
                const student = data.student;
                document.getElementById('studentId').value = student.student_school_id || '';
                document.getElementById('completeName').value = [
                    student.student_first_name,
                    student.student_middle_name,
                    student.student_last_name
                ].filter(Boolean).join(' ') || '';
                document.getElementById('course').value = student.program_name || '';
                document.getElementById('yearLevel').value = student.year_level_name || '';
                document.getElementById('campus').value = student.campus_name || '';
                document.getElementById('scholarship').value = student.scholarship_name || 'None';
                document.getElementById('contactNumber').value = student.student_contact_number || '';
                document.getElementById('fbAccount').value = student.student_fb_account || '';
            }

                const formatBalanceAmount = (value) => {
                    const amount = parseFloat(value ?? 0);
                    return `₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                };

                const balanceInput = document.getElementById('studentBalance');
                if (balanceInput) {
                    balanceInput.value = formatBalanceAmount(data.balance?.balance_total_balance ?? 0);
                }

                const previousBalanceInput = document.getElementById('previousBalance');
                if (previousBalanceInput) {
                    previousBalanceInput.value = formatBalanceAmount(data.balance?.balance_previous_balance ?? 0);
                }

                const currentBalanceInput = document.getElementById('currentBalance');
                if (currentBalanceInput) {
                    currentBalanceInput.value = formatBalanceAmount(data.balance?.balance_current_balance ?? 0);
                }

                const advisedToPayInput = document.getElementById('advisedToPay');
                if (advisedToPayInput) {
                    advisedToPayInput.value = formatBalanceAmount(data.balance?.balance_advice_to_pay ?? 0);
                }

                const amountCanPayInput = document.getElementById('amountCanPay');
                const minimumAmountCanPay = Number(data.minimumAmountCanPay || 1);
                if (amountCanPayInput && Number.isFinite(minimumAmountCanPay) && minimumAmountCanPay > 0) {
                    amountCanPayInput.min = minimumAmountCanPay.toFixed(2);
                    amountCanPayInput.dataset.minimumAmount = String(minimumAmountCanPay);
                    const helpText = amountCanPayInput.closest('.col-md-6')?.querySelector('.form-text');
                    if (helpText) {
                        helpText.textContent = `Minimum amount: ₱${minimumAmountCanPay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Numbers only.`;
                    }
                }

                // Populate application periods
                const applicationPeriodSelect = document.getElementById('applicationPeriod');
                if (applicationPeriodSelect) {
                    applicationPeriodSelect.innerHTML = '<option value="">Select Application Period</option>';
                    this.loanApplicationPeriods.forEach(period => {
                        const option = document.createElement('option');
                        option.value = period.app_period_id;
                        const alreadyApplied = Boolean(period.already_applied);
                        const cancellationLimitReached = Boolean(period.cancellation_limit_reached);
                        option.textContent = cancellationLimitReached
                            ? `${period.app_period_name} — cancellation limit reached`
                            : (alreadyApplied
                                ? `${period.app_period_name} — application already submitted`
                                : period.app_period_name);
                        option.disabled = alreadyApplied || cancellationLimitReached;
                        applicationPeriodSelect.appendChild(option);
                    });
                }

                // Validation already done at the beginning - no need to check again
                
                // Populate document types
                const documentTypeSelect = document.getElementById('documentType');
                if (documentTypeSelect && data.documentTypes) {
                    documentTypeSelect.innerHTML = '<option value="">Select Document Type</option>';
                    data.documentTypes.forEach(docType => {
                        const option = document.createElement('option');
                        option.value = docType.doc_type_id;
                        option.textContent = docType.doc_type_name;
                        documentTypeSelect.appendChild(option);
                    });
                }
                
                // Populate relationships
                const relationshipSelect = document.getElementById('relationship');
                this.familyMembers = Array.isArray(data.familyMembers) ? data.familyMembers : [];
                if (relationshipSelect && data.relationships) {
                    relationshipSelect.innerHTML = '<option value="">Select Relationship</option>';
                    data.relationships.forEach(rel => {
                        if (!this.familyMembers.some((member) => Number(member.relationship_id) === Number(rel.relationship_id))) return;
                        const option = document.createElement('option');
                        option.value = rel.relationship_id;
                        option.textContent = rel.relationship_name;
                        relationshipSelect.appendChild(option);
                    });
                }
                this.updateSelectedFamilyMember();

                if (reapplication) {
                    this.populateReapplicationForm(reapplication);
                } else {
                    this.resetLoanApplicationMode();
                }
                this.updatePaymentDateLimits();

                // Disable submit button by default until ID validation passes
                const submitBtn = document.getElementById('submitApplicationBtn');
                if (submitBtn) {
                    submitBtn.disabled = true;
                }
                
        } catch (error) {
            console.error('Error loading loan application form:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to load loan application form',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
        }
    }

    updateSelectedFamilyMember(preferredId = 0) {
        const relationshipSelect = document.getElementById('relationship');
        const nameInput = document.getElementById('parentName');
        const contactInput = document.getElementById('parentContact');
        const idInput = document.getElementById('familyMemberId');
        if (!relationshipSelect || !nameInput || !contactInput || !idInput) return;
        const relationshipId = Number(relationshipSelect.value);
        const matches = (this.familyMembers || []).filter((member) => Number(member.relationship_id) === relationshipId);
        const selected = matches.find((member) => String(member.id) === String(preferredId)) || matches[0];
        const previousId = idInput.value;
        idInput.value = selected?.id || '';
        nameInput.value = selected ? this.familyMemberFullName(selected) : '';
        contactInput.value = selected?.contact || '';
        contactInput.readOnly = !selected;
        contactInput.placeholder = selected ? '09XXXXXXXXX' : 'Choose a relationship first';
        contactInput.setCustomValidity('');
        contactInput.classList.remove('is-invalid');
        if (previousId !== idInput.value) {
            this.invalidateGuardianIdScreening();
        }
        const help = relationshipSelect.nextElementSibling;
        if (help?.classList.contains('form-text')) {
            help.textContent = this.familyMembers?.length
                ? 'Only family members saved in your student record are available.'
                : 'No family details are saved yet. Ask CSDL to add a family member before applying.';
        }
    }

    familyMemberFullName(member) {
        return String(member.name || '').trim();
    }

    populateReapplicationForm(loan) {
        const setValue = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.value = value ?? '';
        };

        setValue('reapplyLoanId', loan.loan_id);
        setValue('applicationPeriod', loan.loan_app_period_id);
        setValue('loanReason', loan.loan_reason);
        setValue('amountCanPay', loan.loan_amount_can_pay);
        setValue('relationship', loan.guardian_relationship_id);
        this.updateSelectedFamilyMember(Number(loan.guardian_id));
        setValue('documentType', loan.documents?.[0]?.loan_document_doc_type_id);

        const paymentDate = String(loan.loan_promised_payment_date || '').slice(0, 10);
        if (paymentDate >= this.toLocalDateString(new Date())) {
            setValue('paymentDate', paymentDate);
        }

        const title = document.getElementById('loanApplicationModalLabel');
        if (title) title.innerHTML = '<i class="bi bi-arrow-repeat me-2"></i>Reapply Loan';

        const submitBtn = document.getElementById('submitApplicationBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = 'Resubmit Application';
        }

        // Stored IDs predate the current screening and cannot bypass a fresh check.
        const fileInput = document.getElementById('validIdFile');
        if (fileInput) {
            fileInput.setAttribute('required', 'required');
            const helpText = fileInput.nextElementSibling;
            if (helpText?.classList.contains('form-text')) {
                helpText.textContent = 'Upload and scan the guardian ID again before resubmitting. Include a clear portrait, readable ID details and guardian signature.';
            }
        }
        this.invalidateGuardianIdScreening();
    }

    resetLoanApplicationMode() {
        const reapplyInput = document.getElementById('reapplyLoanId');
        if (reapplyInput) reapplyInput.value = '';
        const relationship = document.getElementById('relationship');
        if (relationship) relationship.value = '';
        this.updateSelectedFamilyMember();

        const title = document.getElementById('loanApplicationModalLabel');
        if (title) title.innerHTML = '<i class="bi bi-file-earmark-text me-2"></i>Student Loan Application Form';

        const submitBtn = document.getElementById('submitApplicationBtn');
        if (submitBtn) submitBtn.innerHTML = 'Submit Application';
    }

    async reapplyLoan(loanId) {
        try {
            const details = await ApiService.get('/students/students-dashboard.php', { action: 'details', loanId });
            if (!details?.success || Number(details.loan?.loan_status_id) !== 6) {
                throw new Error(details?.message || 'Only returned loan applications can be reapplied.');
            }

            const viewModalEl = document.getElementById('viewLoanModal');
            await this.hideModalAndClearBackdrop(viewModalEl);
            await this.loadLoanApplicationForm(details.loan);
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Unable to reapply',
                text: error.message || 'Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }

    async handleReapplyLoanFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const loanId = Number(params.get('reapplyLoan'));
        if (!loanId) return;

        params.delete('reapplyLoan');
        const query = params.toString();
        window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
        await this.reapplyLoan(loanId);
    }

    invalidateGuardianIdScreening() {
        this.idValidationPassed = false;
        this.idValidationRequest++;
        this.hideScanningAnimation();
        const submitBtn = document.getElementById('submitApplicationBtn');
        if (submitBtn) submitBtn.disabled = true;
    }

    async validateGuardianIdWithOCR(guardianName, documentTypeId, file, badgeEl) {
        const requestId = ++this.idValidationRequest;
        try {
            if (!badgeEl || !file) return;
            
            // Get submit button reference once
            const submitBtn = document.getElementById('submitApplicationBtn');
            
            // Reset validation state and disable submit button
            this.idValidationPassed = false;
            if (submitBtn) {
                submitBtn.disabled = true;
            }
            
            // Show scanning animation
            this.showScanningAnimation();
            
            badgeEl.textContent = '';
            badgeEl.className = 'd-none';

            // Create FormData for file upload
            const formData = new FormData();
            formData.append('guardian_name', guardianName);
            formData.append('document_type_id', documentTypeId);
            formData.append('id_file', file);

            // Call validation API with file
            const response = await ApiService.postFormData('/students/students-id-validation.php', formData);
            if (requestId !== this.idValidationRequest) return;

            // Hide scanning animation
            this.hideScanningAnimation();

            if (!response.success) {
                const message = response.message || 'Unable to validate ID information.';
                badgeEl.textContent = '';
                badgeEl.className = 'd-none';
                
                // Keep submit button disabled
                this.idValidationPassed = false;
                if (submitBtn) {
                    submitBtn.disabled = true;
                }

                Swal.fire({
                    icon: 'error',
                    title: 'ID Validation Failed',
                    text: message,
                    confirmButtonText: 'OK'
                });
                return;
            }

            const screening = response.screening || response.gemini;
            const needsStaffReview = response.reviewRequired === true || screening?.decision === 'needs_review';
            const frontRequired = screening?.front_required === true;
            const passed = response.valid === true && screening?.decision === 'visual_checks_passed' && !needsStaffReview && !frontRequired;
            const canSubmitForReview = response.reviewSubmissionAllowed === true && needsStaffReview && screening?.document_side !== 'back';
            const message = response.message || (passed
                ? 'Visual checks passed. Staff must still inspect the original ID; authenticity is not established.'
                : 'This document could not be cleared. Upload a clearer complete ID or contact CSDL for review.');

            this.idValidationPassed = passed || canSubmitForReview;
            if (submitBtn) submitBtn.disabled = !this.idValidationPassed;
            badgeEl.textContent = '';
            badgeEl.className = 'd-none';
            Swal.fire({
                icon: passed ? 'success' : needsStaffReview ? 'warning' : 'error',
                title: passed ? 'Completed' : canSubmitForReview ? 'Submit for CSDL review' : frontRequired ? 'Upload the front of your ID' : needsStaffReview ? 'CSDL review required' : 'ID verification failed',
                text: passed ? 'ID screening completed. You can now submit your application.' : canSubmitForReview ? 'You can submit this application for CSDL staff review. It cannot be approved or endorsed until the guardian ID is reviewed.' : message,
                confirmButtonText: 'OK'
            });
        } catch (error) {
            if (requestId !== this.idValidationRequest) return;
            this.hideScanningAnimation();
            
            // Keep validation failed and submit button disabled
            this.idValidationPassed = false;
            const submitBtn = document.getElementById('submitApplicationBtn');
            if (submitBtn) {
                submitBtn.disabled = true;
            }
            
            if (badgeEl) {
                badgeEl.textContent = '';
                badgeEl.className = 'd-none';
            }
            console.error('ID validation error:', error);

            Swal.fire({
                icon: 'error',
                title: 'ID Validation Error',
                text: error?.response?.data?.message || 'Failed to validate ID. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }

    async showIdPreview(file) {
        const previewContainer = document.getElementById('idPreviewContainer');
        const canvas = document.getElementById('idPreviewCanvas');
        
        if (!previewContainer || !canvas) return;
        
        const ctx = canvas.getContext('2d');
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                // Calculate dimensions to fit canvas while maintaining aspect ratio
                const maxWidth = 600;
                const maxHeight = 300;
                let width = img.width;
                let height = img.height;
                
                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }
                
                if (height > maxHeight) {
                    width = (width * maxHeight) / height;
                    height = maxHeight;
                }
                
                canvas.width = width;
                canvas.height = height;
                
                // Draw image on canvas
                ctx.drawImage(img, 0, 0, width, height);
                
                // Show preview container
                previewContainer.style.display = 'block';
            };
            img.src = e.target.result;
        };
        
        reader.readAsDataURL(file);
    }

    hideIdPreview() {
        const previewContainer = document.getElementById('idPreviewContainer');
        if (previewContainer) {
            previewContainer.style.display = 'none';
        }
    }

    showScanningAnimation() {
        const scanningOverlay = document.getElementById('scanningOverlay');
        const scanningStatus = document.getElementById('scanningStatus');
        
        if (scanningOverlay) {
            scanningOverlay.classList.remove('d-none');
        }
        if (scanningStatus) {
            scanningStatus.classList.remove('d-none');
        }
    }

    hideScanningAnimation() {
        const scanningOverlay = document.getElementById('scanningOverlay');
        const scanningStatus = document.getElementById('scanningStatus');
        
        if (scanningOverlay) {
            scanningOverlay.classList.add('d-none');
        }
        if (scanningStatus) {
            scanningStatus.classList.add('d-none');
        }
    }

    /**
     * Wait until a Bootstrap modal is fully hidden before another overlay is
     * opened. This prevents a leftover backdrop when reapplying or submitting
     * a loan application.
     */
    async hideModalAndClearBackdrop(modalEl) {
        if (!modalEl || typeof bootstrap === 'undefined') {
            this.clearStaleModalBackdrop();
            return;
        }

        const modal = bootstrap.Modal.getInstance(modalEl)
            || bootstrap.Modal.getOrCreateInstance(modalEl);

        if (!modalEl.classList.contains('show')) {
            this.clearStaleModalBackdrop();
            return;
        }

        await new Promise((resolve) => {
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                modalEl.removeEventListener('hidden.bs.modal', finish);
                resolve();
            };

            modalEl.addEventListener('hidden.bs.modal', finish, { once: true });
            modal.hide();

            // Fallback for an interrupted Bootstrap transition.
            window.setTimeout(finish, 500);
        });

        this.clearStaleModalBackdrop();
    }

    clearStaleModalBackdrop() {
        // Do not disturb another Bootstrap modal that is still open.
        if (document.querySelector('.modal.show')) return;

        document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
    }

    validateAmountCanPay(input) {
        if (!input) return false;

        const value = input.value.trim();
        const helpTextEl = document.getElementById('amountCanPayHelp');
        const errorEl = document.getElementById('amountCanPayError');
        
        // Get validation parameters
        const minAmount = parseFloat(input.dataset.minimumAmount || input.min || 1);
        const totalBalance = parseFloat(document.getElementById('studentBalance')?.value?.replace(/[₱,]/g, '') || 0);
        const advisedToPay = parseFloat(document.getElementById('advisedToPay')?.value?.replace(/[₱,]/g, '') || 0);

        // Reset validation state - remove Bootstrap validation classes
        input.classList.remove('is-invalid', 'is-valid');
        if (errorEl) errorEl.style.display = 'none';

        // Empty field - no validation yet
        if (value === '') {
            if (helpTextEl) {
                helpTextEl.textContent = `Minimum amount: ₱${minAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Numbers only.`;
                helpTextEl.className = 'form-text';
            }
            return false;
        }

        const numericValue = parseFloat(value);

        // Not a valid number
        if (isNaN(numericValue) || numericValue <= 0) {
            input.classList.add('is-invalid');
            if (errorEl) {
                errorEl.textContent = 'Please enter a valid positive number.';
                errorEl.style.display = 'block';
            }
            if (helpTextEl) {
                helpTextEl.textContent = 'Enter a valid amount (numbers only).';
                helpTextEl.className = 'form-text text-danger';
            }
            return false;
        }

        // Below minimum
        if (numericValue < minAmount) {
            input.classList.add('is-invalid');
            if (errorEl) {
                errorEl.textContent = `Amount must be at least ₱${minAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`;
                errorEl.style.display = 'block';
            }
            if (helpTextEl) {
                helpTextEl.textContent = `Minimum: ₱${minAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                helpTextEl.className = 'form-text text-danger';
            }
            return false;
        }

        // Check if amount exceeds total balance (error - cannot exceed balance)
        if (totalBalance > 0 && numericValue > totalBalance) {
            input.classList.add('is-invalid');
            if (errorEl) {
                errorEl.textContent = `Amount exceeds your total balance of ₱${totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`;
                errorEl.style.display = 'block';
            }
            if (helpTextEl) {
                helpTextEl.textContent = `Your total balance is ₱${totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                helpTextEl.className = 'form-text text-danger';
            }
            return false;
        }

        // Valid amount - show green border but no icon
        input.classList.add('is-valid');
        if (helpTextEl) {
            if (advisedToPay > 0 && numericValue >= advisedToPay) {
                helpTextEl.textContent = `Covers the advised amount of ₱${advisedToPay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                helpTextEl.className = 'form-text text-success';
            } else if (advisedToPay > 0) {
                const remaining = advisedToPay - numericValue;
                helpTextEl.textContent = `Note: Advised to pay is ₱${advisedToPay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (₱${remaining.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} short)`;
                helpTextEl.className = 'form-text text-info';
            } else {
                helpTextEl.textContent = `Amount looks good!`;
                helpTextEl.className = 'form-text text-success';
            }
        }
        return true;
    }

    toLocalDateString(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    formatPaymentWindowDate(value) {
        if (!value) return '';
        const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
    }

    updatePaymentDateLimits() {
        const input = document.getElementById('paymentDate');
        if (!input) return;

        const todayDate = new Date();
        const deadlineDate = new Date(todayDate);
        deadlineDate.setDate(deadlineDate.getDate() + 30);
        const today = this.toLocalDateString(todayDate);
        const deadline = this.toLocalDateString(deadlineDate);

        input.min = today;
        input.max = deadline;
        input.dataset.deadlineSource = '30-days';
        input.dataset.windowClosed = 'false';
        input.dataset.scheduleMissing = 'false';
        input.disabled = false;

        if (input.value && (input.value < today || input.value > deadline)) {
            input.value = '';
            input.classList.remove('is-valid', 'is-invalid');
            input.setCustomValidity('');
        }

        const helpText = document.getElementById('paymentDateHelp');
        if (!helpText) return;

        helpText.textContent = 'Choose a payment date within 30 days.';
    }

    validatePaymentDate(input, showEmptyError = false) {
        if (!input) return false;

        const errorEl = document.getElementById('paymentDateError');
        const value = input.value;
        let message = '';

        if (!value) {
            if (showEmptyError || input.validity?.badInput) {
                message = input.validity?.badInput
                    ? 'Please enter a complete and valid date.'
                    : 'Please select your intended payment date.';
            }
        } else if (value < input.min) {
            message = 'Payment date cannot be in the past.';
        } else if (value > input.max) {
            const latestDate = this.formatPaymentWindowDate(input.max);
            message = `Payment date must be within 30 days. The latest allowed date is ${latestDate}.`;
        }

        input.setCustomValidity(message);
        input.classList.toggle('is-invalid', message !== '');
        input.classList.toggle('is-valid', message === '' && value !== '');
        if (errorEl) {
            errorEl.textContent = message || 'Please select a valid intended payment date.';
            errorEl.style.display = message ? 'block' : '';
        }

        return message === '' && value !== '';
    }

    async handleLoanApplicationSubmit(e) {
        e.preventDefault();
        
        const form = e.target;
        const submitBtn = document.getElementById('submitApplicationBtn');

        // The server requires a matching screening or staff-review receipt.
        if (!this.idValidationPassed) {
            Swal.fire({
                icon: 'error',
                title: 'ID Validation Required',
                text: 'Please scan the guardian ID before submitting your loan application.',
                confirmButtonText: 'OK'
            });
            return;
        }

        // Extra front-end validation for consent and declaration
        const consentAgree = document.getElementById('consentAgree');
        const declaration = document.getElementById('declaration');
        if (consentAgree && !consentAgree.checked) {
            Swal.fire({
                icon: 'error',
                title: 'Data Privacy Consent',
                text: 'You must agree to the data privacy consent to continue.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
            return;
        }
        if (declaration && !declaration.checked) {
            Swal.fire({
                icon: 'error',
                title: 'Declaration Required',
                text: 'You must agree to the declaration to continue.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
            return;
        }

        // Comprehensive amount validation
        const amountInput = document.getElementById('amountCanPay');
        if (amountInput) {
            if (!this.validateAmountCanPay(amountInput)) {
                amountInput.focus();
                return;
            }
        }

        // Validate Philippine mobile number format for parent/guardian contact
        const parentContactInput = document.getElementById('parentContact');
        if (parentContactInput) {
            const contactValue = parentContactInput.value.trim();
            if (!contactValue.match(/^09[0-9]{9}$/)) {
                Swal.fire({
                    icon: 'error',
                    title: 'Invalid Contact Number',
                    text: 'Parent/Guardian contact number must be a valid 11-digit Philippine mobile number starting with 09.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 3000
                });
                parentContactInput.focus();
                return;
            }
        }

        // Validate Philippine mobile number format for student contact
        const studentContactInput = document.getElementById('contactNumber');
        if (studentContactInput) {
            const contactValue = studentContactInput.value.trim();
            if (!contactValue.match(/^09[0-9]{9}$/)) {
                Swal.fire({
                    icon: 'error',
                    title: 'Invalid Contact Number',
                    text: 'Student contact number must be a valid 11-digit Philippine mobile number starting with 09.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 3000
                });
                studentContactInput.focus();
                return;
            }
        }
        
        // Validate form
        const fbAccountInput = document.getElementById('fbAccount');
        if (fbAccountInput) {
            fbAccountInput.value = fbAccountInput.value.trim();
            if (!fbAccountInput.value) {
                fbAccountInput.setCustomValidity('Enter your Facebook name or profile link.');
                fbAccountInput.reportValidity();
                fbAccountInput.focus();
                return;
            }
            fbAccountInput.setCustomValidity('');
        }
        if (!form.checkValidity()) {
            form.classList.add('was-validated');
            return;
        }
        
        // Validate typed dates as well as dates chosen from the calendar.
        const paymentDateInput = document.getElementById('paymentDate');
        if (!this.validatePaymentDate(paymentDateInput, true)) {
            paymentDateInput?.focus();
            return;
        }
        
        // Disable submit button
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Submitting...';
        }
        
        try {
            // Create FormData
            const formData = new FormData(form);
            
            // Submit using FormData
            const response = await ApiService.postFormData('/students/students-loan-application.php', formData);
            
            if (response.success) {
                // Wait for the form to finish closing before showing the
                // SweetAlert. Otherwise Bootstrap can leave its backdrop on
                // the dashboard after a resubmission.
                const modalEl = document.getElementById('loanApplicationModal');
                await this.hideModalAndClearBackdrop(modalEl);
                
                // Reset form
                form.reset();
                form.classList.remove('was-validated');
                
                // Show success message
                await Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: `Loan application submitted successfully! Application No: ${response.applicationNo || 'N/A'}${response.reviewRequired ? ' Your guardian ID is awaiting CSDL staff review before approval.' : ''}`,
                    confirmButtonText: 'OK'
                });

                this.clearStaleModalBackdrop();
                // Reload recent loans
                this.loadRecentLoans();
                this.loadLoanSummary();
                if (window.studentsNotificationsModule && typeof window.studentsNotificationsModule.loadNotifications === 'function') {
                    window.studentsNotificationsModule.loadNotifications();
                }
                
                // Refresh calendar data and re-render to show new due dates
                if (typeof this.loadCalendarEvents === 'function') {
                    this.loadCalendarEvents().then(() => this.renderCalendar());
                }
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to submit loan application',
                    confirmButtonText: 'OK'
                });
            }
        } catch (error) {
            console.error('Error submitting loan application:', error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to submit loan application',
                confirmButtonText: 'OK'
            });
        } finally {
            // Re-enable submit button
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Submit Application';
            }
        }
    }
}

export default StudentsDashboardModule;
