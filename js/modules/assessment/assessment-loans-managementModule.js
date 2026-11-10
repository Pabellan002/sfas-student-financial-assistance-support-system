import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import ApiService from '../../services/services-apiService.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import {
    ASSESSMENT_LOAN_MGMT_TABLE_COLSPAN,
    buildLoanMgmtTableRowHtml,
    getLoanMgmtCountdownElementId,
    getLoanMgmtExpiryTimestamp,
    mapLoanMgmtExportRow,
} from '../../shared/shared-loan-management-table.js?v=20261018-overdue-countdown';
const PAID_PN_REMARK = 'PN marked as paid.';
const PARTIAL_PN_REMARK = 'PN marked as partial payment.';
const INLINE_ACTION_IGNORE = '.loan-actions-cell, .inline-row-actions, .inline-action-btn, .assessment-intake-actions';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js?v=20260913-paid-partial-status';
import StaffPartialPaymentController from '../../shared/shared-staff-partial-payment.js?v=20260920-additive-partial';

class AssessmentLoansManagementModule {
    constructor() {
        this.currentPage = 1;
        this.perPage = 10;
        this.filters = { status: '', semester: '', schoolYear: '', period: '', campus: '', search: '' };
        this.loans = [];
        this.total = 0;
        this.totalPages = 0;
        this.permissions = {
            view: false,
            tagPn: false,
            approve: false,
            partialPayment: false,
            endorse: false,
            chat: false
        };
        this.modalListView = null;
        this.modalLoanPage = 1;
        this.modalLoanPerPage = 25;
        this.modalLoanTotal = 0;
        this.modalLoanTotalPages = 0;
        this._loansModalPaginationBound = false;
        this.chatLoanId = 0;
        this.chatLastMessageId = 0;
        this.chatPollTimer = null;
        this.chatTypingHeartbeatTimer = null;
        this.chatTypingStopTimer = null;
        this.chatTypingActive = false;
        this.chatRenderedMessageIds = new Set();
        this.chatSendInFlight = false;
        this.partialPayment = new StaffPartialPaymentController({
            apiPath: '/assessment/assessment-loan-management.php',
            hasPermission: () => this.permissions.partialPayment,
            getLoans: () => this.loans,
            onUpdated: async () => {
                await Promise.all([this.loadStats(), this.loadLoans()]);
                window.dispatchEvent(new Event('sidebar-live-counts:refresh'));
            },
        });
    }

    async init() {
        await this.ensureSession();
        await this.loadPermissions();
        await this.loadFilters();
        await this.loadStats();
        await this.loadLoans();
        this.bindEvents();
        this.partialPayment.bind();
        this.bindStatCards();
        this.applyActionVisibility();
        this.bindOutsideActionMenuClose();
        this.bindActionMenuPositionFix();
        this.setupMobileFilterClose();
        const chatLoanId = Number(new URLSearchParams(window.location.search).get('chatLoan')) || 0;
        if (chatLoanId && this.permissions.chat) this.openLoanChat(chatLoanId);
    }

    async loadPermissions() {
        try {
            const res = await fetch('../../api/masterfiles/masterfiles-permissions.php?action=get_my_permissions', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const data = await res.json();
            if (!data?.success || !Array.isArray(data.permissions)) return;
            const can = (key) => {
                const perm = data.permissions.find((p) => p.permission_key === key);
                return !!(perm && Number(perm.is_granted) === 1);
            };
            this.permissions = {
                view: can('assessment.loans.view'),
                tagPn: can('assessment.loans.tag_pn'),
                approve: can('assessment.loans.approve'),
                partialPayment: can('assessment.loans.partial_payment'),
                endorse: can('assessment.loans.endorse'),
                chat: can('assessment.loans.chat')
            };
        } catch (error) {
            console.error('Error loading assessment loan permissions:', error);
        }
    }

    applyActionVisibility() {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.style.display = this.permissions.view ? '' : 'none';
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
    }

    async loadFilters() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch('../../api/assessment/assessment-loan-management.php?action=filters', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success) {
                const statusSelect = document.getElementById('filterStatus');
                if (statusSelect) {
                    const defaultOption = statusSelect.querySelector('option[value=""]');
                    statusSelect.innerHTML = '';
                    if (defaultOption) statusSelect.appendChild(defaultOption);
                    else {
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'All Status';
                        statusSelect.appendChild(allOption);
                    }
                    
                    const allowedStatusIds = [1];
                    response.statuses.filter(status => allowedStatusIds.includes(parseInt(status.loan_status_id))).forEach(status => {
                        const option = document.createElement('option');
                        option.value = status.loan_status_id;
                        option.textContent = status.loan_status_name;
                        if (status.loan_status_id === '1') option.selected = true;
                        statusSelect.appendChild(option);
                    });
                }
                
                // Populate semester filters (desktop and mobile)
                const semesterSelect = document.getElementById('filterSemester');
                const semesterSelectMobile = document.getElementById('filterSemesterMobile');
                [semesterSelect, semesterSelectMobile].forEach(select => {
                    if (select) {
                        select.innerHTML = '<option value="">All Semesters</option>';
                        response.semesters.forEach(semester => {
                            const option = document.createElement('option');
                            option.value = semester.semester_id;
                            option.textContent = semester.semester_name;
                            select.appendChild(option);
                        });
                    }
                });
                
                // Populate school year filters (desktop and mobile)
                const schoolYearSelect = document.getElementById('filterSchoolYear');
                const schoolYearSelectMobile = document.getElementById('filterSchoolYearMobile');
                [schoolYearSelect, schoolYearSelectMobile].forEach(select => {
                    if (select) {
                        select.innerHTML = '<option value="">All School Years</option>';
                        response.schoolYears.forEach(sy => {
                            const option = document.createElement('option');
                            option.value = sy.sy_id;
                            option.textContent = sy.sy_display;
                            select.appendChild(option);
                        });
                    }
                });
                
                // Populate period filters (desktop and mobile)
                const periodSelect = document.getElementById('filterPeriod');
                const periodSelectMobile = document.getElementById('filterPeriodMobile');
                [periodSelect, periodSelectMobile].forEach(select => {
                    if (select) {
                        const defaultOption = select.querySelector('option[value=""]');
                        select.innerHTML = '';
                        if (defaultOption) select.appendChild(defaultOption);
                        else {
                            const allOption = document.createElement('option');
                            allOption.value = '';
                            allOption.textContent = 'All Periods';
                            select.appendChild(allOption);
                        }
                        
                        response.periods.forEach(period => {
                            const option = document.createElement('option');
                            option.value = period.app_period_id;
                            option.textContent = period.app_period_name;
                            select.appendChild(option);
                        });
                    }
                });

                const campusSelect = document.getElementById('filterCampus');
                const campusSelectMobile = document.getElementById('filterCampusMobile');
                [campusSelect, campusSelectMobile].forEach(select => {
                    if (!select) return;
                    select.innerHTML = '<option value="">All Campuses</option>';
                    (response.campuses || []).forEach(campus => {
                        const option = document.createElement('option');
                        option.value = campus.campus_id;
                        option.textContent = campus.campus_name || campus.campus_code;
                        select.appendChild(option);
                    });
                    select.value = this.filters.campus;
                });

            }
        } catch (error) {
            console.error('Error loading filters:', error);
        }
    }

    bindEvents() {
        const statusSelect = document.getElementById('filterStatus');
        const semesterSelect = document.getElementById('filterSemester');
        const schoolYearSelect = document.getElementById('filterSchoolYear');
        const periodSelect = document.getElementById('filterPeriod');
        const campusSelect = document.getElementById('filterCampus');
        const searchInput = document.getElementById('searchLoans');
        const searchInputMobile = document.getElementById('searchLoansMobile');
        const refreshBtn = document.getElementById('refreshBtn');
        const perPageSelect = document.getElementById('perPageSelect');
        const tbody = document.querySelector('#loansTable tbody');

        if (statusSelect) {
            statusSelect.addEventListener('change', (e) => {
                this.filters.status = e.target.value;
                this.currentPage = 1;
                this.loadLoans();
            });
        }
        
        if (semesterSelect) {
            semesterSelect.addEventListener('change', (e) => {
                this.filters.semester = e.target.value;
                this.currentPage = 1;
                this.loadLoans();
            });
        }
        
        if (schoolYearSelect) {
            schoolYearSelect.addEventListener('change', (e) => {
                this.filters.schoolYear = e.target.value;
                this.currentPage = 1;
                this.loadLoans();
            });
        }
        
        if (periodSelect) {
            periodSelect.addEventListener('change', (e) => {
                this.filters.period = e.target.value;
                this.currentPage = 1;
                this.loadLoans();
            });
        }

        if (campusSelect) {
            campusSelect.addEventListener('change', (e) => {
                this.filters.campus = e.target.value;
                this.currentPage = 1;
                this.loadLoans();
                this.loadStats();
                const campusMobile = document.getElementById('filterCampusMobile');
                if (campusMobile) campusMobile.value = e.target.value;
            });
        }

        
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const searchValue = e.target.value.trim();
                searchTimeout = setTimeout(() => {
                    this.filters.search = searchValue;
                    this.currentPage = 1;
                    this.loadLoans();
                    // Sync with mobile search
                    if (searchInputMobile) searchInputMobile.value = searchValue;
                }, 300);
            });
        }
        
        // Mobile search input
        if (searchInputMobile) {
            let searchTimeout;
            searchInputMobile.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const searchValue = e.target.value.trim();
                searchTimeout = setTimeout(() => {
                    this.filters.search = searchValue;
                    this.currentPage = 1;
                    this.loadLoans();
                    // Sync with desktop search
                    if (searchInput) searchInput.value = searchValue;
                }, 300);
            });
        }
        
        // Apply mobile filters button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const semesterMobile = document.getElementById('filterSemesterMobile');
                const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
                const periodMobile = document.getElementById('filterPeriodMobile');
                const campusMobile = document.getElementById('filterCampusMobile');
                
                // Sync mobile selections to desktop and filters
                if (semesterMobile && semesterSelect) {
                    semesterSelect.value = semesterMobile.value;
                    this.filters.semester = semesterMobile.value;
                }
                if (schoolYearMobile && schoolYearSelect) {
                    schoolYearSelect.value = schoolYearMobile.value;
                    this.filters.schoolYear = schoolYearMobile.value;
                }
                if (periodMobile && periodSelect) {
                    periodSelect.value = periodMobile.value;
                    this.filters.period = periodMobile.value;
                }
                if (campusMobile && campusSelect) {
                    campusSelect.value = campusMobile.value;
                    this.filters.campus = campusMobile.value;
                }
                
                this.currentPage = 1;
                this.loadLoans();
                this.loadStats();
                
                // Close the dropdown
                const dropdown = bootstrap.Dropdown.getInstance(document.getElementById('mobileFilterBtn'));
                if (dropdown) dropdown.hide();
            });
        }
        
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                this.currentPage = 1;
                if (statusSelect) { statusSelect.value = ''; this.filters.status = ''; }
                if (semesterSelect) { semesterSelect.value = ''; this.filters.semester = ''; }
                if (schoolYearSelect) { schoolYearSelect.value = ''; this.filters.schoolYear = ''; }
                if (periodSelect) { periodSelect.value = ''; this.filters.period = ''; }
                if (campusSelect) { campusSelect.value = ''; this.filters.campus = ''; }
                if (searchInput) { searchInput.value = ''; this.filters.search = ''; }
                if (searchInputMobile) { searchInputMobile.value = ''; }
                
                // Reset mobile filters
                const semesterMobile = document.getElementById('filterSemesterMobile');
                const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
                const periodMobile = document.getElementById('filterPeriodMobile');
                const campusMobile = document.getElementById('filterCampusMobile');
                if (semesterMobile) semesterMobile.value = '';
                if (schoolYearMobile) schoolYearMobile.value = '';
                if (periodMobile) periodMobile.value = '';
                if (campusMobile) campusMobile.value = '';
                
                await Promise.all([this.loadFilters(), this.loadStats(), this.loadLoans()]);
            });
        }
        
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportLoans();
            });
        }

        if (perPageSelect) {
            perPageSelect.addEventListener('change', (e) => {
                this.perPage = parseInt(e.target.value, 10);
                this.currentPage = 1;
                this.loadLoans();
            });
        }
        if (tbody) {
            tbody.addEventListener('click', (e) => {
                if (e.target.closest(INLINE_ACTION_IGNORE)) return;
                const row = e.target.closest('tr[data-loan-id]');
                if (!row) return;
                const loanId = row.getAttribute('data-loan-id');
                if (loanId) this.viewLoan(loanId);
            });
        }

        const submitActionBtn = document.getElementById('submitActionBtn');
        if (submitActionBtn) {
            submitActionBtn.addEventListener('click', () => {
                this.submitAction();
            });
        }
        
        // Extend amount checkbox toggle
        const extendCheckbox = document.getElementById('extendAmountCheckbox');
        if (extendCheckbox) {
            extendCheckbox.addEventListener('change', (e) => {
                const amountInputContainer = document.getElementById('actionAmountInputContainer');
                const amountInput = document.getElementById('actionAmountInput');
                if (e.target.checked) {
                    if (amountInputContainer) amountInputContainer.style.display = 'block';
                    if (amountInput) amountInput.required = true;
                } else {
                    if (amountInputContainer) amountInputContainer.style.display = 'none';
                    if (amountInput) amountInput.required = false;
                }
            });
        }
        
    }

    async loadLoans() {
        if (!this.permissions.view) {
            const tbody = document.querySelector('#loansTable tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="${ASSESSMENT_LOAN_MGMT_TABLE_COLSPAN}" class="text-center text-muted py-4">You do not have permission to view loans</td></tr>`;
            return;
        }
        try {
            const params = { action: 'list', page: this.currentPage, perPage: this.perPage, ...this.filters };
            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => { if (params[key] !== '') qs.set(key, params[key]); });
            
            const res = await fetch(`../../api/assessment/assessment-loan-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            
            if (response.success) {
                this.loans = response.data || [];
                this.total = response.total || 0;
                this.totalPages = response.totalPages || 0;
                this.renderTable();
                this.updatePagination();
                
                const totalCount = document.getElementById('totalCount');
                if (totalCount) totalCount.textContent = `${this.total} application${this.total !== 1 ? 's' : ''}`;
            }
        } catch (err) {
            console.error('Error loading loans:', err);
            if (window.Swal) {
                Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to load loans', confirmButtonText: 'OK' });
            }
        }
    }

    renderTable() {
        const tbody = document.querySelector('#loansTable tbody');
        if (!tbody) return;

        this.cleanupCountdowns();
        tbody.innerHTML = '';

        if (this.loans.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${ASSESSMENT_LOAN_MGMT_TABLE_COLSPAN}" class="text-center text-muted py-4">No loans found</td></tr>`;
            return;
        }

        this.loans.forEach(loan => {
            const row = document.createElement('tr');
            row.setAttribute('data-loan-id', loan.loan_id);
            row.style.cursor = 'pointer';

            const dueDateIso = loan.dueDate ? String(loan.dueDate).split(' ')[0].split('T')[0] : '';
            const statusHtml = `<span class="badge ${this.getStatusBadgeClass(loan.statusId)}">${escapeHtml(loan.statusName || '-')}</span>`;
            const paymentStatus = this.getPaymentStatusName(loan);
            const paymentStatusHtml = `<span class="badge ${this.getPaymentStatusBadgeClass(paymentStatus)}">${escapeHtml(paymentStatus)}</span>`;
            const pnStatus = this.getPnStatusName(loan);
            const pnStatusClass = this.getPnStatusBadgeClass(pnStatus);
            const pnStatusHtml = `<span class="badge ${pnStatusClass}">${escapeHtml(pnStatus)}</span>`;
            const actionsHtml = this.renderAssessmentActions(loan);

            row.innerHTML = buildLoanMgmtTableRowHtml({
                loan,
                escapeHtml,
                statusHtml,
                actionsHtml,
                actionsCellClass: 'assessment-actions-col',
                formatCountdown: (ts) => this.formatCountdown(ts),
                columnPreset: 'assessment',
                paymentStatusHtml,
                pnStatusHtml,
            });
            tbody.appendChild(row);

            const expiry = getLoanMgmtExpiryTimestamp(loan);
            const countdownId = getLoanMgmtCountdownElementId(loan);
            if (expiry && countdownId) {
                this.startCountdown(countdownId, expiry);
            }
        });

        tbody.querySelectorAll('.action-loan-process').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = Number(btn.dataset.loanId || 0);
                if (loanId && btn.dataset.action) this.openActionModal(loanId, btn.dataset.action);
            });
        });

        tbody.querySelectorAll('.action-loan-chat').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = Number(btn.dataset.loanId || 0);
                if (loanId) this.openLoanChat(loanId);
            });
        });

    }

    renderAssessmentActions(loan) {
        const totalBalance = Number(loan.balance_total_balance ?? loan.totalBalance ?? loan.total_balance ?? 0);
        const amountCanPay = Number(loan.loan_amount_can_pay ?? loan.amountCanPay ?? 0);
        const remainingBalance = totalBalance - amountCanPay;
        const campusCode = String(loan.campus_code || loan.campusCode || '').toLowerCase();
        const isCarmenCampus = campusCode.includes('carmen');
        const button = (action, icon, style, label) => `<button type="button" class="inline-action-btn ${style} action-loan-process" data-loan-id="${loan.loan_id}" data-action="${action}" title="${label}" aria-label="${label}"><i class="bi ${icon}"></i></button>`;
        const actions = [];
        // Assessment approval is only available in its own threshold range.
        // Loans outside this range must be endorsed to the responsible office.
        if (this.permissions.approve && remainingBalance > 3000 && remainingBalance <= 7500) {
            actions.push(button('approve', 'bi-check-lg', 'inline-action-btn--approve', 'Approve and send to Cashier'));
        }
        // Carmen campus should NEVER be endorsed to Branch Admin
        if (this.permissions.endorse && remainingBalance > 7500 && remainingBalance <= 10000 && !isCarmenCampus) {
            actions.push(button('endorse_branch', 'bi-diagram-3', 'inline-action-btn--info', 'Endorse to Branch Admin'));
        }
        // For Carmen campus with balance > 7500, show COO endorsement option
        if (this.permissions.endorse && (remainingBalance > 10000 || (isCarmenCampus && remainingBalance > 7500))) {
            actions.push(button('endorse_coo', 'bi-send-check', 'inline-action-btn--info', 'Endorse to COO'));
        }
        // Partial payment belongs only to loans within Assessment's own
        // approval range. Branch Admin and COO endorsements must not show it.
        if (this.permissions.partialPayment && remainingBalance > 3000 && remainingBalance <= 7500) {
            actions.push(button('partial', 'bi-cash-coin', 'inline-action-btn--return', 'Partial payment'));
        }
        if (this.permissions.chat) {
            actions.push(`<button type="button" class="inline-action-btn inline-action-btn--info action-loan-chat" data-loan-id="${loan.loan_id}" title="Chat with student" aria-label="Chat with student"><i class="bi bi-chat-dots"></i></button>`);
        }
        return `<span class="loan-actions-cell assessment-intake-actions d-inline-flex justify-content-center w-100"><span class="inline-row-actions" role="group" aria-label="Loan actions">
            ${actions.join('') || '<span class="text-muted">-</span>'}
        </span></span>`;
    }

    renderPnActions(loanId, dueDate, statusId) {
        if (!this.permissions.tagPn) return '<span class="text-muted">—</span>';
        const isPartialPayment = Number(statusId) === 11;
        const partialAction = isPartialPayment
            ? `<button type="button" class="inline-action-btn inline-action-btn--return action-pn-partial"
                    data-loan-id="${loanId}" data-due-date="${escapeHtml(dueDate)}" title="Mark as partial payment" aria-label="Mark as partial payment">
                    <i class="bi bi-cash-coin"></i>
                </button>`
            : '';

        return `
            <span class="loan-actions-cell assessment-intake-actions d-inline-flex justify-content-center w-100">
                <span class="inline-row-actions" role="group" aria-label="PN tagging actions">
                    <button type="button" class="inline-action-btn inline-action-btn--approve action-pn-paid"
                        data-loan-id="${loanId}" title="Mark as paid" aria-label="Mark as paid">
                        <i class="bi bi-check-lg"></i>
                    </button>
                    ${partialAction}
                </span>
            </span>`;
    }

    getStatusBadgeClass(statusId) {
        const id = parseInt(statusId, 10);
        const classes = {
            1: 'bg-warning text-dark', // Pending
            2: 'bg-success', // Approved
            5: 'bg-success', // Completed
            6: 'bg-warning text-dark', // Returned
            9: 'bg-secondary', // Cancelled
            11: 'bg-warning text-dark', // Partial Payment
            12: 'bg-success' // Endorsed
        };
        return classes[id] || 'bg-secondary';
    }

    getPaymentStatusName(loan) {
        return String(loan?.paymentStatus || loan?.payment_status || 'Not Paid');
    }

    getPaymentStatusBadgeClass(statusName) {
        const status = String(statusName || '').trim().toLowerCase();
        if (status === 'paid') return 'bg-success';
        if (status === 'paid pending') return 'bg-info text-dark';
        if (status === 'paid partial') return 'bg-warning text-dark';
        if (status === 'partial payment' || status === 'partial') return 'bg-warning text-dark';
        return 'bg-secondary';
    }

    getPnStatusName(loan) {
        return String(loan?.pnStatus || loan?.pn_status || 'Not Tagged');
    }

    getPnStatusBadgeClass(statusName) {
        const status = String(statusName || '').trim().toLowerCase();
        if (status === 'tagged') return 'bg-success';
        return 'bg-secondary';
    }

    updateStats() {
    }
    
    async loadStats() {
        if (!this.permissions.view) return;
        try {
            // Add timestamp to prevent caching
            const timestamp = new Date().getTime();
            const statsParams = new URLSearchParams({ action: 'stats', _: String(timestamp) });
            if (this.filters.campus) statsParams.set('campus', this.filters.campus);
            const res = await fetch(`../../api/assessment/assessment-loan-management.php?${statsParams.toString()}`, { 
                credentials: 'same-origin', 
                cache: 'no-store',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            });
            const response = await res.json();
            
            if (response.success) {
                const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
                set('statPending', response.stats.allApplications);
                set('statOverdue', response.stats.overdueApplications);
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    updatePagination() {
        const start = this.total ? (this.currentPage - 1) * this.perPage + 1 : 0;
        const end = Math.min(this.currentPage * this.perPage, this.total);
        const info = document.getElementById('pageInfo');
        if (info) info.textContent = `Showing ${start} to ${end} of ${this.total} entries`;
        const container = document.getElementById('pageNumbers');
        if (!container) return;
        if (this.totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        const nearby = new Set([1, this.totalPages, this.currentPage - 2, this.currentPage - 1, this.currentPage, this.currentPage + 1, this.currentPage + 2]);
        const numbers = [...nearby].filter(page => page >= 1 && page <= this.totalPages).sort((a, b) => a - b);
        const buttons = [];
        numbers.forEach((page, index) => {
            if (index && page > numbers[index - 1] + 1) buttons.push('<span class="px-1 text-muted" aria-hidden="true">…</span>');
            buttons.push(`<button type="button" class="btn btn-sm ${page === this.currentPage ? 'btn-success' : 'btn-outline-secondary'}" data-page="${page}" ${page === this.currentPage ? 'aria-current="page"' : ''}>${page}</button>`);
        });
        container.innerHTML = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.currentPage - 1}" ${this.currentPage === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.currentPage + 1}" ${this.currentPage === this.totalPages ? 'disabled' : ''}>Next</button>`;
        container.querySelectorAll('button[data-page]').forEach(button => button.addEventListener('click', () => {
            const page = Number(button.dataset.page);
            if (button.disabled || !Number.isInteger(page) || page < 1 || page > this.totalPages || page === this.currentPage) return;
            this.currentPage = page;
            this.loadLoans();
        }));
    }

    async viewLoan(loanId) {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`../../api/assessment/assessment-loan-management.php?action=details&loanId=${loanId}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            
            if (response.success) {
                const loan = response.loan;
                const modalEl = document.getElementById('viewLoanModal');
                if (!modalEl) return;
                
                let modal = bootstrap.Modal.getInstance(modalEl);
                if (!modal) modal = new bootstrap.Modal(modalEl);
                
                const content = document.getElementById('loanDetailsContent');
                const actionButtons = document.getElementById('loanActionButtons');
                
                if (content) content.innerHTML = this.renderLoanDetails(loan);
                if (actionButtons) actionButtons.innerHTML = '';
                
                modal.show();
            }
        } catch (error) {
            console.error('Error loading loan details:', error);
            if (window.Swal) {
                Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to load loan details', confirmButtonText: 'OK' });
            }
        }
    }
    
    renderLoanDetails(loan) {
        return renderModernLoanDetails(
            loan,
            (statusId) => this.getStatusBadgeClass(statusId),
            (loanObj) => loanObj.loan_status_name || '-',
            {
                showVerifyButton: false,
                verifyFunctionName: 'verifyDocument',
                moduleName: 'cashierLoansManagementModule'
            }
        );
    }

    openActionModal(loanId, actionType) {
        const allowed = {
            approve: this.permissions.approve,
            endorse_branch: this.permissions.endorse,
            endorse_coo: this.permissions.endorse,
            partial: this.permissions.partialPayment,
        };
        if (!allowed[actionType]) return;
        
        if (actionType === 'partial') {
            this.partialPayment.open(loanId);
            return;
        }

        // Approvals and endorsements use the action modal.
        const modal = new bootstrap.Modal(document.getElementById('actionLoanModal'));
        const loan = this.loans.find((item) => String(item.loan_id) === String(loanId));
        if (!loan) return;
        
        const actionLoanIdEl = document.getElementById('actionLoanId');
        const actionTypeEl = document.getElementById('actionType');
        if (actionLoanIdEl) actionLoanIdEl.value = loanId;
        if (actionTypeEl) actionTypeEl.value = actionType;
        
        const title = document.getElementById('actionLoanModalTitle');
        const summaryStudent = document.getElementById('actionLoanSummaryStudent');
        const summaryAmount = document.getElementById('actionLoanSummaryAmount');
        const amountLabel = document.getElementById('actionAmountLabel');
        const remarksContainer = document.getElementById('actionRemarksContainer');
        const remarksField = document.getElementById('actionRemarks');
        const submitButton = document.getElementById('submitActionBtn');
        const amountInputContainer = document.getElementById('actionAmountInputContainer');
        const amountInput = document.getElementById('actionAmountInput');
        
        const amount = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0);
        const displayAmount = Number.isFinite(amount)
            ? amount.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' })
            : '₱0.00';
        
        // Configure modal based on action type
        if (actionType === 'approve') {
            if (title) title.textContent = 'Approve Loan';
            if (amountLabel) amountLabel.textContent = 'Amount Can Pay';
            if (summaryStudent) summaryStudent.textContent = loan.name || 'Student';
            if (summaryAmount) summaryAmount.textContent = displayAmount;
            if (remarksContainer) remarksContainer.style.display = 'none';
            if (remarksField) remarksField.required = false;
            
            // Hide checkbox and input for approve
            const checkboxContainer = document.getElementById('extendAmountCheckboxContainer');
            if (checkboxContainer) checkboxContainer.style.display = 'none';
            if (amountInputContainer) amountInputContainer.style.display = 'none';
            
            if (submitButton) {
                submitButton.textContent = 'Approve Loan';
                submitButton.className = 'btn btn-success';
            }
        } else if (actionType === 'endorse_branch') {
            if (title) title.textContent = 'Endorse to Branch Admin';
            if (amountLabel) amountLabel.textContent = 'Current Amount Can Pay';
            if (summaryStudent) summaryStudent.textContent = loan.name || 'Student';
            if (summaryAmount) summaryAmount.textContent = displayAmount;
            if (remarksContainer) remarksContainer.style.display = 'none';
            if (remarksField) remarksField.required = false;
            
            // Branch Admin endorsements support the same optional amount
            // extension used by COO endorsements.
            const checkboxContainer = document.getElementById('extendAmountCheckboxContainer');
            const checkbox = document.getElementById('extendAmountCheckbox');
            if (checkboxContainer) checkboxContainer.style.display = 'block';
            if (checkbox) checkbox.checked = false;
            if (amountInputContainer) amountInputContainer.style.display = 'none';
            if (amountInput) {
                amountInput.value = amount;
                amountInput.min = amount;
                amountInput.required = false;
            }
            
            if (submitButton) {
                submitButton.textContent = 'Endorse to Branch Admin';
                submitButton.className = 'btn btn-success';
            }
        } else if (actionType === 'endorse_coo') {
            if (title) title.textContent = 'Endorse to COO';
            if (amountLabel) amountLabel.textContent = 'Current Amount Can Pay';
            if (summaryStudent) summaryStudent.textContent = loan.name || 'Student';
            if (summaryAmount) summaryAmount.textContent = displayAmount;
            if (remarksContainer) remarksContainer.style.display = 'none';
            if (remarksField) remarksField.required = false;
            
            // Show checkbox for COO (extension available)
            const checkboxContainer = document.getElementById('extendAmountCheckboxContainer');
            const checkbox = document.getElementById('extendAmountCheckbox');
            if (checkboxContainer) checkboxContainer.style.display = 'block';
            if (checkbox) checkbox.checked = false;
            if (amountInputContainer) amountInputContainer.style.display = 'none';
            if (amountInput) {
                amountInput.value = amount;
                amountInput.min = amount;
                amountInput.required = false;
            }
            
            if (submitButton) {
                submitButton.textContent = 'Endorse to COO';
                submitButton.className = 'btn btn-success';
            }
        }
        
        modal.show();
    }
    
    async showApproveConfirmation(loanId, actionType) {
        const loan = this.loans.find((l) => String(l.loan_id) === String(loanId));
        if (!loan) return;
        
        const actionTexts = {
            approve: {
                title: 'Approve Application?',
                text: `Approve loan application ${loan.applicationNo} for ${loan.name}?`,
                confirmText: 'Yes, Approve',
                processText: 'Approving...'
            },
            endorse_branch: {
                title: 'Endorse to Branch Admin?',
                text: `Endorse loan application ${loan.applicationNo} to Branch Admin for approval?`,
                confirmText: 'Yes, Endorse',
                processText: 'Endorsing...'
            },
            endorse_coo: {
                title: 'Endorse to COO?',
                text: `Endorse loan application ${loan.applicationNo} to COO for approval?`,
                confirmText: 'Yes, Endorse',
                processText: 'Endorsing...'
            }
        };
        
        const config = actionTexts[actionType];
        if (!config) return;
        
        const result = await Swal.fire({
            title: config.title,
            text: config.text,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: config.confirmText,
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#198754',
            cancelButtonColor: '#6c757d'
        });
        
        if (!result.isConfirmed) return;
        
        try {
            Swal.fire({
                title: config.processText,
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });
            
            const formData = new FormData();
            formData.append('action', 'process');
            formData.append('loanId', loanId);
            formData.append('processType', actionType);
            formData.append('amountApproved', loan.amountCanPay || 0);
            formData.append('remarks', ''); // Auto-generated on backend
            
            const response = await ApiService.postFormData('/assessment/assessment-loan-management.php', formData);
            
            if (response.success) {
                Swal.fire({ icon: 'success', title: 'Success!', text: response.message || 'Loan processed successfully' });
                bootstrap.Modal.getInstance(document.getElementById('viewLoanModal'))?.hide();
                await this.loadLoans();
                await this.loadStats();
            } else {
                throw new Error(response.message || 'Failed to process loan');
            }
        } catch (error) {
            console.error('Error processing loan:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to process loan' });
        }
    }

    async submitAction() {
        const loanIdEl = document.getElementById('actionLoanId');
        const actionTypeEl = document.getElementById('actionType');
        if (!loanIdEl || !actionTypeEl) return;
        
        const loanId = loanIdEl.value;
        const actionType = actionTypeEl.value;
        
        const allowed = (actionType === 'approve' && this.permissions.approve)
            || (['endorse_branch', 'endorse_coo'].includes(actionType) && this.permissions.endorse);
        if (!allowed) return;
        
        // Get the loan data
        const loan = this.loans.find((item) => String(item.loan_id) === String(loanId));
        if (!loan) return;
        
        // Get amount - for endorsements, use the input field value; otherwise use original amount
        let amountApproved;
        if (['endorse_branch', 'endorse_coo'].includes(actionType)) {
            const amountInput = document.getElementById('actionAmountInput');
            if (!amountInput) return;
            amountApproved = Number(amountInput.value);
            const originalAmount = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0);
            
            if (!amountApproved || amountApproved < originalAmount) {
                Swal.fire({ icon: 'warning', title: 'Invalid Amount', text: 'Extended amount must be greater than or equal to the current amount.' });
                return;
            }
        } else {
            amountApproved = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0);
        }
        
        const remarks = '';
        
        try {
            const formData = new FormData();
            formData.append('action', 'process');
            formData.append('loanId', loanId);
            formData.append('processType', actionType);
            formData.append('amountApproved', amountApproved);
            formData.append('remarks', remarks);
            
            const response = await ApiService.postFormData('/assessment/assessment-loan-management.php', formData);
            
            if (response.success) {
                let message = 'Loan processed successfully';
                if (actionType === 'approve') message = 'Loan approved successfully';
                else if (actionType === 'endorse_branch') message = 'Loan endorsed to Branch Admin successfully';
                else if (actionType === 'endorse_coo') message = 'Loan endorsed to COO successfully';
                
                Swal.fire({ icon: 'success', title: 'Success', text: response.message || message });
                bootstrap.Modal.getInstance(document.getElementById('actionLoanModal')).hide();
                bootstrap.Modal.getInstance(document.getElementById('viewLoanModal'))?.hide();
                await this.loadLoans();
                await this.loadStats();
            } else {
                throw new Error(response.message || 'Failed to process loan');
            }
        } catch (error) {
            console.error('Error processing loan:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to process loan' });
        }
    }
    
    async quickTagPaid(loanId) {
        if (!this.permissions.tagPn) return;

        const loan = this.loans.find((l) => String(l.loan_id) === String(loanId));
        const studentName = loan?.name || 'Student';
        const appNo = loan?.applicationNo || '';
        const subtitle = appNo ? `${studentName} · ${appNo}` : studentName;

        const result = await Swal.fire({
            title: 'Mark as Paid',
            html: `<div class="text-center"><p class="mb-0"><strong>${escapeHtml(subtitle)}</strong></p></div>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Mark Paid',
            confirmButtonColor: '#198754',
            cancelButtonText: 'Cancel',
        });
        if (!result.isConfirmed) return;

        try {
            const formData = new FormData();
            formData.append('action', 'tag_pn');
            formData.append('loanId', String(loanId));
            formData.append('pnStatus', 'Paid');
            formData.append('remarks', PAID_PN_REMARK);

            const response = await ApiService.postFormData('/assessment/assessment-loan-management.php', formData);

            if (response.success) {
                await this.loadStats();
                await this.loadLoans();
                await Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    confirmButtonText: 'OK',
                });
            } else {
                throw new Error(response.message || 'Failed to mark PN as paid');
            }
        } catch (error) {
            console.error('Error marking PN as paid:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to mark PN as paid' });
        }
    }

    async notifyStudentForPn(loanId) {
        if (!this.permissions.tagPn) return;

        const loan = this.loans.find((item) => String(item.loan_id) === String(loanId));
        const isPartialPayment = Number(loan?.statusId) === 11;
        const studentName = loan?.name || 'Student';
        const appNo = loan?.applicationNo || '';
        const label = appNo ? `${studentName} · ${appNo}` : studentName;
        const amount = Number(loan?.amountCanPay ?? loan?.loan_amount_can_pay ?? 0);
        const amountLabel = Number.isFinite(amount) && amount > 0
            ? `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : 'the required amount';
        const dueDate = String(loan?.dueDate || loan?.loan_due_date || '').split('T')[0].split(' ')[0];
        const dueLabel = dueDate
            ? new Date(`${dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
            : 'the due date shown on the application';
        const title = isPartialPayment ? 'Mark as Partial Payment' : 'Tag PN';
        const text = isPartialPayment
            ? `Mark this loan for a partial payment of ${amountLabel}, due on or before ${dueLabel}, and notify the student.`
            : 'Tag this paid loan as complete in PN tagging and notify the student.';

        const result = await Swal.fire({
            title,
            html: `<div class="text-center"><p class="mb-0"><strong>${escapeHtml(label)}</strong></p><p class="mb-0 mt-2">${escapeHtml(text)}</p></div>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: isPartialPayment ? 'Mark Partial' : 'Tag PN',
            confirmButtonColor: '#198754',
            cancelButtonText: 'Cancel',
        });
        if (!result.isConfirmed) return;

        try {
            const formData = new FormData();
            formData.append('action', 'tag_pn');
            formData.append('loanId', String(loanId));
            formData.append('pnStatus', isPartialPayment ? 'Partial Payment' : 'Tagged');
            formData.append('remarks', isPartialPayment ? PARTIAL_PN_REMARK : 'PN tagged and student notified.');
            const response = await ApiService.postFormData('/assessment/assessment-loan-management.php', formData);
            if (!response.success) throw new Error(response.message || 'Failed to send the PN notification');
            await this.loadStats();
            await this.loadLoans();
            await Swal.fire({
                icon: 'success',
                title: isPartialPayment ? 'Partial Payment Marked' : 'PN Tagged',
                text: response.message || (isPartialPayment ? 'The loan was marked for partial payment and the student was notified.' : 'The promissory note was tagged and the student was notified.'),
                confirmButtonText: 'OK'
            });
        } catch (error) {
            console.error('Error sending PN notification:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to send the PN notification' });
        }
    }

    bindStatCards() {
        const cards = document.querySelectorAll('.stat-card[data-view]');
        if (!cards.length) return;
        this.loansListModal = new bootstrap.Modal(document.getElementById('loansListModal'));
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                this.populateLoansListModal(view);
            });
        });
        this.bindLoansModalPagination();
    }

    bindLoansModalPagination() {
        if (this._loansModalPaginationBound) return;
        this._loansModalPaginationBound = true;
    }

    updateLoansModalPaginationUI() {
        const pageInfo = document.getElementById('loansModalPageInfo');
        const pageNumbers = document.getElementById('loansModalPageNumbers');
        const total = this.modalLoanTotal;
        const start = total === 0 ? 0 : (this.modalLoanPage - 1) * this.modalLoanPerPage + 1;
        const end = Math.min(this.modalLoanPage * this.modalLoanPerPage, total);
        if (pageInfo) pageInfo.textContent = total === 0 ? 'No records' : `Showing ${start} to ${end} of ${total} entries`;
        if (!pageNumbers) return;
        pageNumbers.innerHTML = '';
        if (total < 10 || this.modalLoanTotalPages <= 1) return;

        const addBtn = (label, page, active = false) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `btn btn-sm ${active ? 'btn-success' : 'btn-outline-secondary'}`;
            b.textContent = label;
            b.addEventListener('click', () => { this.populateLoansListModal(undefined, page); });
            pageNumbers.appendChild(b);
        };

        if (this.modalLoanPage > 1) addBtn('‹', this.modalLoanPage - 1);
        const maxBtns = 5;
        let from = Math.max(1, this.modalLoanPage - 2);
        let to = Math.min(this.modalLoanTotalPages, from + maxBtns - 1);
        if (to - from < maxBtns - 1) from = Math.max(1, to - maxBtns + 1);
        for (let i = from; i <= to; i++) addBtn(String(i), i, i === this.modalLoanPage);
        if (this.modalLoanPage < this.modalLoanTotalPages) addBtn('›', this.modalLoanPage + 1);
    }

    async populateLoansListModal(view, page) {
        const titleEl = document.getElementById('loansModalTitle');
        const tbody = document.getElementById('loansModalTableBody');
        if (!titleEl || !tbody) return;

        if (view !== undefined) {
            this.modalListView = view;
            if (page === undefined) this.modalLoanPage = 1;
        }
        if (page !== undefined) this.modalLoanPage = page;

        const perPageEl = document.getElementById('loansModalPerPageSelect');
        if (perPageEl) this.modalLoanPerPage = parseInt(perPageEl.value, 10) || 25;

        let title = 'Loans';
        const params = {
            action: 'list',
            page: this.modalLoanPage,
            perPage: this.modalLoanPerPage,
            ...this.filters
        };

        if (this.modalListView === 'allApplications') {
            title = 'All Applications';
        } else if (this.modalListView === 'overdueApplications') {
            title = 'Overdue Applications';
            params.overdue = '1';
        } else {
            return;
        }

        titleEl.textContent = title;
        const iconEl = document.getElementById('loansModalIcon');
        const icons = { allApplications: 'bi-collection', overdueApplications: 'bi-clock-history' };
        if (iconEl) iconEl.className = `bi ${icons[this.modalListView] || 'bi-list-check'} me-2`;
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Loading...</td></tr>';

        try {
            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => { if (params[key] !== '') qs.set(key, params[key]); });

            const res = await fetch(`../../api/assessment/assessment-loan-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();

            const loans = response.success ? (response.data || []) : [];
            this.modalLoanTotal = response.success ? (parseInt(response.total, 10) || 0) : 0;
            this.modalLoanTotalPages = response.success ? (parseInt(response.totalPages, 10) || 0) : 0;

            if (!loans || loans.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No loans found</td></tr>`;
            } else {
                tbody.innerHTML = loans.map(loan => {
                    // Use default gray color for all status badges
                    const StatusBadge = loan.pnStatus
                        ? `<span class="badge bg-secondary">${escapeHtml(loan.pnStatus)}</span>`
                        : '<span class="badge bg-secondary">Not Set</span>';
                    const dateApplied = loan.dateApplied ? new Date(loan.dateApplied).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
                    return `
                        <tr style="cursor: pointer;" onclick="window.cashierLoansManagementModule.viewLoan(${loan.loan_id})">
                            <td class="text-center">${escapeHtml(loan.applicationNo || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.schoolId || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.name || '-')}</td>
                            <td class="text-center">₱${parseFloat(loan.amount || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="text-center">${StatusBadge}</td>
                            <td class="text-center">${dateApplied}</td>
                        </tr>
                    `;
                }).join('');
            }

            this.updateLoansModalPaginationUI();
            this.loansListModal && this.loansListModal.show();
        } catch (error) {
            console.error('Error loading loans for modal:', error);
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">Error loading loans</td></tr>`;
            this.modalLoanTotal = 0;
            this.modalLoanTotalPages = 0;
            this.updateLoansModalPaginationUI();
        }
    }

    async exportLoans() {
        if (!rbacUtil.requireModulePermission(this.permissions.view, 'export loans data')) {
            return;
        }
        const swal = window.Swal;
        if (!swal) return;

        try {
            // Build params to fetch all matching loans
            const params = {
                action: 'list',
                page: 1,
                perPage: 100,
                status: this.filters.status || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                period: this.filters.period || '',
                campus: this.filters.campus || '',
                search: this.filters.search || ''
            };

            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => {
                if (params[key] !== '' || key === 'action' || key === 'page' || key === 'perPage') {
                    qs.set(key, params[key]);
                }
            });

            const exportLoans = [];
            for (let page = 1; ; page += 1) {
                qs.set('page', String(page));
                const res = await fetch(`../../api/assessment/assessment-loan-management.php?${qs.toString()}`, {
                    credentials: 'same-origin',
                    cache: 'no-store'
                });
                const response = await res.json();
                if (!response.success || !Array.isArray(response.data)) {
                    throw new Error('Failed to fetch loan data for export');
                }
                exportLoans.push(...response.data);
                if (page >= Number(response.totalPages || 1)) break;
            }

            // Show format selection dialog
            const result = await swal.fire({
                title: 'Export Applications',
                input: 'select',
                inputOptions: { csv: 'CSV', xls: 'Excel (.xls)', doc: 'Word (.doc)', pdf: 'PDF (.pdf)' },
                inputValue: 'csv',
                showCancelButton: true,
                confirmButtonText: 'Export',
                cancelButtonText: 'Cancel',
                buttonsStyling: false,
                customClass: { 
                    confirmButton: 'btn btn-success px-4', 
                    cancelButton: 'btn btn-secondary px-4', 
                    actions: 'd-flex gap-2', 
                    popup: 'swal2-custom-popup' 
                }
            });

            if (!result.isConfirmed) return;

            // Map loans data to export format
            const rows = exportLoans.map(r => mapLoanMgmtExportRow(
                r,
                r.statusName || '',
                r.paymentStatus || r.payment_status || '',
                r.pnStatus || r.pn_status || ''
            ));

            if (rows.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No loans found to export.',
                    confirmButtonText: 'OK',
                    buttonsStyling: false,
                    customClass: { confirmButton: 'btn btn-primary px-4' }
                });
                return;
            }

            const choice = result.value;

            if (choice === 'csv') {
                const headers = Object.keys(rows[0] || {});
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                let csv = headers.map(esc).join(',') + '\n';
                rows.forEach(row => {
                    csv += headers.map(h => esc(row[h])).join(',') + '\n';
                });

                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `assessment-loans-${new Date().toISOString().split('T')[0]}.csv`;
                link.click();
            } else if (choice === 'xls') {
                const headers = Object.keys(rows[0] || {});
                let html = '<table border="1"><thead><tr>';
                headers.forEach(h => { html += `<th>${h}</th>`; });
                html += '</tr></thead><tbody>';
                rows.forEach(row => {
                    html += '<tr>';
                    headers.forEach(h => { html += `<td>${row[h] ?? ''}</td>`; });
                    html += '</tr>';
                });
                html += '</tbody></table>';

                const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `assessment-loans-${new Date().toISOString().split('T')[0]}.xls`;
                link.click();
            } else if (choice === 'doc') {
                const headers = Object.keys(rows[0] || {});
                let html = '<html><head><meta charset="utf-8"><title>Loans Export</title></head><body>';
                html += '<h1>Assessment Loans Export</h1>';
                html += '<table border="1" cellpadding="5" cellspacing="0"><thead><tr>';
                headers.forEach(h => { html += `<th>${h}</th>`; });
                html += '</tr></thead><tbody>';
                rows.forEach(row => {
                    html += '<tr>';
                    headers.forEach(h => { html += `<td>${row[h] ?? ''}</td>`; });
                    html += '</tr>';
                });
                html += '</tbody></table></body></html>';

                const blob = new Blob([html], { type: 'application/msword' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `assessment-loans-${new Date().toISOString().split('T')[0]}.doc`;
                link.click();
            } else if (choice === 'pdf') {
                // Professional PDF export with enhanced HTML print design
                const headers = Object.keys(rows[0] || {});
                
                // Build filter summary
                const filterParts = [];
                const semesterSelect = document.getElementById('filterSemester') || document.getElementById('filterSemesterMobile');
                const schoolYearSelect = document.getElementById('filterSchoolYear') || document.getElementById('filterSchoolYearMobile');
                const periodSelect = document.getElementById('filterPeriod') || document.getElementById('filterPeriodMobile');
                
                if (this.filters.semester && semesterSelect) {
                    const selectedOption = Array.from(semesterSelect.options).find(opt => opt.value === this.filters.semester);
                    if (selectedOption) filterParts.push(`Semester: ${selectedOption.text}`);
                }
                if (this.filters.schoolYear && schoolYearSelect) {
                    const selectedOption = Array.from(schoolYearSelect.options).find(opt => opt.value === this.filters.schoolYear);
                    if (selectedOption) filterParts.push(`School Year: ${selectedOption.text}`);
                }
                if (this.filters.period && periodSelect) {
                    const selectedOption = Array.from(periodSelect.options).find(opt => opt.value === this.filters.period);
                    if (selectedOption) filterParts.push(`Period: ${selectedOption.text}`);
                }
                if (this.filters.search) filterParts.push(`Search: "${this.filters.search}"`);
                
                const filterHtml = filterParts.length > 0 
                    ? `<div class="filters"><strong>Applied Filters:</strong> ${filterParts.join(' | ')}</div>` 
                    : '';
                
                const escapeHtml = (str) => {
                    if (str === null || str === undefined) return '';
                    return String(str)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                };
                
                const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
                const trs = rows.map((r, idx) => {
                    const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                    return `<tr style="background-color:${bgColor};">${headers.map(h => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(r[h] ?? ''))}</td>`).join('')}</tr>`;
                }).join('');
                
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>Assessment Active Loans Report</title>
                        <style>
                            @page { size: landscape; margin: 15mm; }
                            * { margin: 0; padding: 0; box-sizing: border-box; }
                            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; font-size: 12px; }
                            .header { border-bottom: 3px solid #198754; padding-bottom: 15px; margin-bottom: 20px; }
                            .header-content { display: flex; align-items: center; justify-content: space-between; }
                            .logo { width: 60px; height: 60px; }
                            .header-title { flex: 1; padding: 0 20px; }
                            .header-title h1 { color: #198754; font-size: 24px; margin-bottom: 5px; }
                            .header-title h2 { color: #666; font-size: 16px; font-weight: normal; }
                            .report-info { text-align: right; color: #666; font-size: 11px; }
                            .report-info div { margin: 3px 0; }
                            .filters { background: #f8f9fa; padding: 12px; border-left: 4px solid #198754; margin: 15px 0; font-size: 11px; color: #333; }
                            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                            .footer { margin-top: 30px; padding-top: 15px; border-top: 2px solid #198754; text-align: center; font-size: 10px; color: #666; }
                            @media print { 
                                body { padding: 0; }
                                @page { margin: 15mm; }
                            }
                        </style>
                    </head>
                    <body>
                        <div class="header">
                            <div class="header-content">
                                <img src="${new URL('../../assets/images/i.png', document.baseURI).href}" alt="Logo" class="logo">
                                <div class="header-title">
                                    <h1>Student Financial Assistance</h1>
                                    <h2>Active Loans Report - Assessment Office</h2>
                                </div>
                                <div class="report-info">
                                    <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                    <div><strong>Office:</strong> Assessment</div>
                                    <div><strong>Total Records:</strong> ${rows.length}</div>
                                </div>
                            </div>
                        </div>
                        ${filterHtml}
                        <table>
                            <thead><tr>${th}</tr></thead>
                            <tbody>${trs}</tbody>
                        </table>
                        <div class="footer">
                            <div><strong>Student Financial Assistance Management System</strong></div>
                            <div>This is a system-generated report. No signature required.</div>
                            <div style="margin-top: 5px;">© ${new Date().getFullYear()} Student Financial Assistance</div>
                        </div>
                    </body>
                    </html>
                `;
                
                const printWindow = window.open('', '_blank');
                if (printWindow) {
                    printWindow.document.write(html);
                    printWindow.document.close();
                    printWindow.focus();
                    Promise.all(Array.from(printWindow.document.images, image => image.decode ? image.decode().catch(() => {}) : Promise.resolve()))
                        .then(() => printWindow.print());
                }
            }

            // Export completed silently - no confirmation dialog

        } catch (error) {
            console.error('Export error:', error);
            await swal.fire({
                icon: 'error',
                title: 'Export Failed',
                text: 'Failed to export loans. Please try again.',
                confirmButtonText: 'OK',
                buttonsStyling: false,
                customClass: { confirmButton: 'btn btn-danger px-4' }
            });
        }
    }

    formatCountdown(expiryTimestamp) {
        if (!expiryTimestamp) return '-';
        
        const expiry = new Date(expiryTimestamp);
        const now = new Date();
        const diff = expiry - now;
        if (Number.isNaN(diff)) return '-';

        if (diff <= 0) {
            const elapsed = Math.abs(diff);
            const days = Math.floor(elapsed / (1000 * 60 * 60 * 24));
            const hours = Math.floor((elapsed % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);
            const duration = days > 0 ? `${days}d ${hours}h ${minutes}m ${seconds}s`
                : hours > 0 ? `${hours}h ${minutes}m ${seconds}s`
                : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            return `<span class="badge bg-danger">Overdue -${duration}</span>`;
        }
        
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        if (days > 0) {
            return `<span class="badge ${days <= 1 ? 'bg-warning' : 'bg-info'}">${days}d ${hours}h ${minutes}m ${seconds}s</span>`;
        } else if (hours > 0) {
            return `<span class="badge bg-warning">${hours}h ${minutes}m ${seconds}s</span>`;
        } else if (minutes > 0) {
            return `<span class="badge bg-danger">${minutes}m ${seconds}s</span>`;
        } else {
            return `<span class="badge bg-danger">${seconds}s</span>`;
        }
    }
    
    startCountdown(elementId, expiryTimestamp) {
        const element = document.getElementById(elementId);
        if (!element) return;
        
        // Clear any existing interval for this element
        if (this.countdownIntervals && this.countdownIntervals[elementId]) {
            clearInterval(this.countdownIntervals[elementId]);
        }
        
        const updateCountdown = () => {
            element.innerHTML = this.formatCountdown(expiryTimestamp);
        };
        
        // Update immediately
        updateCountdown();
        
        // Update every second for real-time countdown
        const intervalId = setInterval(() => {
            updateCountdown();
        }, 1000);
        
        // Store interval ID for cleanup
        if (!this.countdownIntervals) {
            this.countdownIntervals = {};
        }
        this.countdownIntervals[elementId] = intervalId;
    }
    
    cleanupCountdowns() {
        if (this.countdownIntervals) {
            Object.values(this.countdownIntervals).forEach(intervalId => {
                clearInterval(intervalId);
            });
            this.countdownIntervals = {};
        }
    }
    
    setupMobileFilterClose() {
        // Close mobile filter dropdown when sidebar opens
        const navbarToggler = document.querySelector('.navbar-toggler');
        const mobileFilterBtn = document.getElementById('mobileFilterBtn');
        
        if (navbarToggler && mobileFilterBtn) {
            navbarToggler.addEventListener('click', () => {
                const dropdown = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                if (dropdown) {
                    dropdown.hide();
                }
            });
        }
    }

    async openLoanChat(loanId) {
        if (!this.permissions.chat) return;
        const loan = this.loans.find((item) => Number(item.loan_id) === Number(loanId));
        this.stopLoanChatPolling();
        this.chatLoanId = Number(loanId);
        this.chatLastMessageId = 0;
        this.chatRenderedMessageIds.clear();

        const subtitle = document.getElementById('loanChatSubtitle');
        const messages = document.getElementById('loanChatMessages');
        const form = document.getElementById('loanChatForm');
        const input = document.getElementById('loanChatInput');
        if (subtitle) subtitle.textContent = loan ? `${loan.name || 'Student'} · ${loan.applicationNo || ''}` : `Loan #${loanId}`;
        if (messages) messages.innerHTML = '<div class="loan-chat-empty">Loading conversation...</div>';

        if (form && !form.dataset.bound) {
            form.dataset.bound = '1';
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                this.sendLoanChatMessage();
            });
            input?.addEventListener('input', () => this.handleLoanChatTyping());
        }

        const modalEl = document.getElementById('loanChatModal');
        if (!modalEl) return;
        if (!modalEl.dataset.chatCleanupBound) {
            modalEl.dataset.chatCleanupBound = '1';
            modalEl.addEventListener('hidden.bs.modal', () => this.stopLoanChatPolling());
        }
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
        await this.loadLoanChatMessages();
        this.chatPollTimer = window.setInterval(() => this.loadLoanChatMessages(true), 1200);
        input?.focus();
    }

    async loadLoanChatMessages(silent = false) {
        if (!this.permissions.chat || !this.chatLoanId) return;
        const requestedLoanId = this.chatLoanId;
        try {
            const params = new URLSearchParams({ action: 'messages', loanId: String(requestedLoanId), afterId: String(this.chatLastMessageId) });
            const response = await ApiService.get(`/shared/shared-loan-chat.php?${params.toString()}`);
            if (!response.success) throw new Error(response.message || 'Failed to load messages');
            if (requestedLoanId !== this.chatLoanId) return;
            const subtitle = document.getElementById('loanChatSubtitle');
            if (subtitle && response.loan) subtitle.textContent = `${response.loan.student_name || 'Student'} · ${response.loan.loan_application_no || ''}`;
            const container = document.getElementById('loanChatMessages');
            if (!container) return;
            if (this.chatLastMessageId === 0) container.innerHTML = '';
            container.querySelector('.loan-chat-typing')?.remove();
            if ((response.messages || []).length && container.querySelector('.loan-chat-empty')) container.innerHTML = '';
            (response.messages || []).forEach((message) => {
                const messageId = Number(message.id) || 0;
                if (messageId && this.chatRenderedMessageIds.has(messageId)) return;
                const wrapper = document.createElement('div');
                wrapper.className = `loan-chat-message ${message.is_mine ? 'is-mine' : 'is-other'}`;
                const time = new Date(String(message.created_at).replace(' ', 'T')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                const sender = message.is_mine ? 'You' : (message.sender_label || (message.sender_type === 'student' ? 'Student' : 'Loan Office'));
                wrapper.innerHTML = `<div class="loan-chat-bubble"><div>${escapeHtml(message.body)}</div><span class="loan-chat-meta">${escapeHtml(sender)} · ${escapeHtml(time)}</span></div>`;
                container.appendChild(wrapper);
                if (messageId) this.chatRenderedMessageIds.add(messageId);
                this.chatLastMessageId = Math.max(this.chatLastMessageId, messageId);
            });
            this.renderLoanChatTypingIndicator(container, Boolean(response.other_is_typing));
            if (!container.querySelector('.loan-chat-message') && !container.querySelector('.loan-chat-typing')) container.innerHTML = '<div class="loan-chat-empty">Start the conversation about this loan.</div>';
            if ((response.messages || []).length || response.other_is_typing) container.scrollTop = container.scrollHeight;
            const readData = new FormData();
            readData.append('action', 'mark_read');
            readData.append('loanId', String(this.chatLoanId));
            ApiService.postFormData('/shared/shared-loan-chat.php', readData).catch(() => {});
        } catch (error) {
            if (!silent) {
                const container = document.getElementById('loanChatMessages');
                if (container) container.innerHTML = `<div class="loan-chat-empty text-danger">${escapeHtml(error.message || 'Failed to load conversation')}</div>`;
            }
        }
    }

    async sendLoanChatMessage() {
        if (!this.permissions.chat) return;
        const input = document.getElementById('loanChatInput');
        const message = input?.value.trim() || '';
        if (!this.chatLoanId || !message || this.chatSendInFlight) return;
        const submit = document.querySelector('#loanChatForm button[type="submit"]');
        this.chatSendInFlight = true;
        this.stopLoanChatTyping();
        if (input) input.disabled = true;
        if (submit) submit.disabled = true;
        try {
            const formData = new FormData();
            formData.append('action', 'send');
            formData.append('loanId', String(this.chatLoanId));
            formData.append('message', message);
            const response = await ApiService.postFormData('/shared/shared-loan-chat.php', formData);
            if (!response.success) throw new Error(response.message || 'Failed to send message');
            if (input) input.value = '';
            await this.loadLoanChatMessages();
        } catch (error) {
            Swal.fire({ icon: 'error', title: 'Message not sent', text: error.message || 'Please try again.' });
        } finally {
            this.chatSendInFlight = false;
            if (input) { input.disabled = false; input.focus(); }
            if (submit) submit.disabled = false;
        }
    }

    stopLoanChatPolling() {
        this.stopLoanChatTyping();
        if (this.chatPollTimer) window.clearInterval(this.chatPollTimer);
        this.chatPollTimer = null;
    }

    renderLoanChatTypingIndicator(container, isTyping) {
        container.querySelector('.loan-chat-typing')?.remove();
        if (!isTyping) return;
        container.querySelector('.loan-chat-empty')?.remove();
        const indicator = document.createElement('div');
        indicator.className = 'loan-chat-typing';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-label', 'Student is typing');
        indicator.innerHTML = '<span class="loan-chat-typing__bubble" aria-hidden="true"><span class="loan-chat-typing__dot"></span><span class="loan-chat-typing__dot"></span><span class="loan-chat-typing__dot"></span></span><span class="loan-chat-typing__label">Student is typing</span>';
        container.appendChild(indicator);
    }

    handleLoanChatTyping() {
        if (!this.permissions.chat) return;
        const input = document.getElementById('loanChatInput');
        if (!this.chatLoanId || !input?.value.trim()) {
            this.stopLoanChatTyping();
            return;
        }
        if (!this.chatTypingActive) {
            this.chatTypingActive = true;
            this.sendLoanChatTypingState(true);
            this.chatTypingHeartbeatTimer = window.setInterval(() => this.sendLoanChatTypingState(true), 1500);
        }
        if (this.chatTypingStopTimer) window.clearTimeout(this.chatTypingStopTimer);
        this.chatTypingStopTimer = window.setTimeout(() => this.stopLoanChatTyping(), 1800);
    }

    sendLoanChatTypingState(isTyping, loanId = this.chatLoanId) {
        if (!this.permissions.chat || !loanId) return;
        const data = new FormData();
        data.append('action', 'typing');
        data.append('loanId', String(loanId));
        data.append('isTyping', isTyping ? '1' : '0');
        ApiService.postFormData('/shared/shared-loan-chat.php', data).catch(() => {});
    }

    stopLoanChatTyping(loanId = this.chatLoanId) {
        if (this.chatTypingHeartbeatTimer) window.clearInterval(this.chatTypingHeartbeatTimer);
        if (this.chatTypingStopTimer) window.clearTimeout(this.chatTypingStopTimer);
        this.chatTypingHeartbeatTimer = null;
        this.chatTypingStopTimer = null;
        if (this.chatTypingActive) this.sendLoanChatTypingState(false, loanId);
        this.chatTypingActive = false;
    }

    bindOutsideActionMenuClose() {
        if (this._outsideActionMenuBound) return;
        this._outsideActionMenuBound = true;
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            if (target.closest('.action-dd')) return;
            document.querySelectorAll('.action-dd[open]').forEach((dd) => {
                dd.removeAttribute('open');
            });
        });
    }

    /**
     * Row actions use <details> inside .assessment-table-scroll; overflow clips the menu.
     * When open, pin the menu with position:fixed like CSDL loan queue.
     */
    bindActionMenuPositionFix() {
        if (this._actionMenuPositionBound) return;
        this._actionMenuPositionBound = true;

        const resetMenuStyles = (menu) => {
            if (!menu) return;
            menu.style.position = '';
            menu.style.top = '';
            menu.style.left = '';
            menu.style.right = '';
            menu.style.bottom = '';
            menu.style.zIndex = '';
            menu.style.maxHeight = '';
            menu.style.overflow = '';
        };

        const positionOpenMenu = (dd) => {
            const menu = dd.querySelector('.action-dd-menu');
            const summary = dd.querySelector('summary');
            if (!menu || !summary) return;
            requestAnimationFrame(() => {
                const r = summary.getBoundingClientRect();
                const mw = Math.max(menu.offsetWidth, 160);
                let left = r.right - mw;
                if (left < 8) left = 8;
                if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
                let top = r.bottom + 6;
                const mh = menu.scrollHeight;
                if (top + mh > window.innerHeight - 8) {
                    top = Math.max(8, r.top - mh - 6);
                }
                menu.style.position = 'fixed';
                menu.style.top = `${Math.round(top)}px`;
                menu.style.left = `${Math.round(left)}px`;
                menu.style.right = 'auto';
                menu.style.bottom = 'auto';
                menu.style.zIndex = '4000';
                menu.style.maxHeight = 'none';
                menu.style.overflow = 'visible';
            });
        };

        document.addEventListener('toggle', (e) => {
            const t = e.target;
            if (!(t instanceof HTMLDetailsElement) || !t.classList.contains('action-dd')) return;
            if (!t.closest('#loansTable')) return;
            const menu = t.querySelector('.action-dd-menu');
            if (!menu) return;
            if (t.open) {
                positionOpenMenu(t);
            } else {
                resetMenuStyles(menu);
            }
        }, true);

        const closeFloatingMenus = () => {
            document.querySelectorAll('#loansTable .action-dd[open]').forEach((dd) => {
                const menu = dd.querySelector('.action-dd-menu');
                resetMenuStyles(menu);
                dd.removeAttribute('open');
            });
        };
        document.addEventListener('scroll', closeFloatingMenus, true);
        window.addEventListener('resize', closeFloatingMenus);
    }
}

export default AssessmentLoansManagementModule;
