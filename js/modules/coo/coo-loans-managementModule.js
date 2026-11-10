import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import ApiService from '../../services/services-apiService.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { setApproveAmountDisplay } from '../../shared/shared-loan-action-amount.js';
import {
    confirmQuickLoanProcess,
    showLoanProcessError,
    showLoanProcessSuccess,
} from '../../shared/shared-loan-quick-actions.js';
import { INLINE_ACTION_IGNORE, loanProcessActions } from '../../shared/shared-inline-actions.js?v=20260909-partial-amount-only';
import {
    buildLoanMgmtTableRowHtml,
    getLoanMgmtCountdownElementId,
    getLoanMgmtExpiryTimestamp,
    mapLoanMgmtExportRow,
    startLoanMgmtModalCountdowns,
} from '../../shared/shared-loan-management-table.js?v=20261018-overdue-countdown';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js?v=20260913-paid-partial-status';
import StaffLoanChatController from '../../shared/shared-staff-loan-chat.js?v=20260927-chat-deeplinks';
import StaffPartialPaymentController from '../../shared/shared-staff-partial-payment.js?v=20260920-additive-partial';

const COO_LOAN_TABLE_COLSPAN = 12;

class CooLoansManagementModule {
    constructor() {
        this.currentPage = 1;
        this.perPage = 10;
        this.filters = {
            status: '',
            period: '',
            semester: '',
            schoolYear: '',
            applicationDate: '',
            search: ''
        };
        this.loans = [];
        this.total = 0;
        this.totalPages = 0;
        this.selectedLoanIds = new Set();
        this.modal = null;
        this.permissions = {
            view: false,
            approve: false,
            partialPayment: false,
            chat: false
        };
        this.loanChat = new StaffLoanChatController({
            hasPermission: () => this.permissions.chat,
            getLoans: () => this.loans,
        });
        this.partialPayment = new StaffPartialPaymentController({
            apiPath: '/coo/coo-loan-management.php',
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
        this.bindCardFilters();
        await this.loadLoans();
        this.bindEvents();
        this.loanChat.bind();
        this.partialPayment.bind();
        this.applyActionVisibility();
        this.bindOutsideActionMenuClose();
        this.bindActionMenuPositionFix();
        this.setupMobileFilterClose();
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
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
                view: can('coo.loans.view'),
                approve: can('coo.loans.approve'),
                partialPayment: can('coo.loans.partial_payment'),
                chat: can('coo.loans.chat')
            };
        } catch (error) {
            console.error('Error loading COO loan permissions:', error);
        }
    }

    applyActionVisibility() {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.style.display = this.permissions.view ? '' : 'none';
        const bulkApproveBtn = document.getElementById('bulkApproveBtn');
        if (bulkApproveBtn) bulkApproveBtn.style.display = this.permissions.approve ? '' : 'none';
    }

    async loadFilters() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch('../../api/coo/coo-loan-management.php?action=filters', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success) {
                // Populate status filter
                const statusSelect = document.getElementById('filterStatus');
                if (statusSelect) {
                    const defaultOption = statusSelect.querySelector('option[value=""]');
                    statusSelect.innerHTML = '';
                    if (defaultOption) {
                        statusSelect.appendChild(defaultOption);
                    } else {
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'All Status';
                        statusSelect.appendChild(allOption);
                    }
                    
                    // Pending (1) and Endorsed (12) are both active COO work.
                    const allowedStatusIds = [1, 12];
                    response.statuses
                        .filter(status => allowedStatusIds.includes(parseInt(status.loan_status_id, 10)))
                        .forEach(status => {
                            const option = document.createElement('option');
                            option.value = status.loan_status_id;
                            option.textContent = status.loan_status_name;
                            statusSelect.appendChild(option);
                        });
                }
                
                // Populate period filter (desktop and mobile)
                const periodSelect = document.getElementById('filterPeriod');
                const periodSelectMobile = document.getElementById('filterPeriodMobile');
                [periodSelect, periodSelectMobile].forEach(select => {
                    if (select) {
                        const defaultOption = select.querySelector('option[value=""]');
                        select.innerHTML = '';
                        if (defaultOption) {
                            select.appendChild(defaultOption);
                        } else {
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

                const semesters = response.semesters || [];
                const semesterSelect = document.getElementById('filterSemester');
                const semesterSelectMobile = document.getElementById('filterSemesterMobile');
                [semesterSelect, semesterSelectMobile].forEach((select) => {
                    if (!select) return;
                    select.innerHTML = '';
                    const allSem = document.createElement('option');
                    allSem.value = '';
                    allSem.textContent = 'All Semesters';
                    select.appendChild(allSem);
                    semesters.forEach((semester) => {
                        const option = document.createElement('option');
                        option.value = semester.semester_id;
                        option.textContent = semester.semester_name;
                        select.appendChild(option);
                    });
                });

                const schoolYears = response.schoolYears || [];
                const schoolYearSelect = document.getElementById('filterSchoolYear');
                const schoolYearSelectMobile = document.getElementById('filterSchoolYearMobile');
                [schoolYearSelect, schoolYearSelectMobile].forEach((select) => {
                    if (!select) return;
                    select.innerHTML = '';
                    const allSy = document.createElement('option');
                    allSy.value = '';
                    allSy.textContent = 'All School Years';
                    select.appendChild(allSy);
                    schoolYears.forEach((sy) => {
                        const option = document.createElement('option');
                        option.value = sy.sy_id;
                        option.textContent = sy.sy_display;
                        select.appendChild(option);
                    });
                });
            }
        } catch (error) {
            console.error('Error loading filters:', error);
        }
    }

    async loadStats() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch('../../api/coo/coo-loan-management.php?action=stats', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success) {
                const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
                set('statPending', response.stats?.pending);
                set('statOverdue', response.stats?.overdue);
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    bindCardFilters() {
        const cardPending = document.getElementById('cardPending');
        const cardExpiring = document.getElementById('cardExpiring');
        
        if (cardPending) {
            cardPending.addEventListener('click', async () => {
                await this.showPendingModal();
            });
        }
        
        const cardOverdue = document.getElementById('cardOverdue');
        if (cardOverdue) {
            cardOverdue.addEventListener('click', async () => {
                await this.showOverdueModal();
            });
        }
    }

    async showPendingModal() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`../../api/coo/coo-loan-management.php?action=list&status=1&period=&search=&page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const loans = response.data || [];
            const tbody = document.getElementById('pendingModalTableBody');
            if (!tbody) return;
            
            if (loans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No pending loans</td></tr>';
            } else {
                tbody.innerHTML = loans.map(loan => `
                    <tr>
                        <td class="text-center">${escapeHtml(loan.applicationNo || loan.loan_application_no)}</td>
                        <td class="text-center">${escapeHtml(loan.schoolId || loan.student_school_id)}</td>
                        <td class="text-center">${escapeHtml(loan.name || loan.student_name)}</td>
                        <td class="text-center">₱${parseFloat(loan.amount || loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td class="text-center"><span class="badge ${this.getStatusBadgeClass(loan.statusId || loan.loan_status_id)}">${escapeHtml(loan.statusName || loan.loan_status_name)}</span></td>
                        <td class="text-center">${loan.dateApplied || loan.loan_application_date ? new Date(loan.dateApplied || loan.loan_application_date).toLocaleDateString() : 'N/A'}</td>
                    </tr>
                `).join('');
            }
            
            const modal = new bootstrap.Modal(document.getElementById('pendingModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading pending loans:', error);
        }
    }

    async showOverdueModal() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`../../api/coo/coo-loan-management.php?action=list&status=overdue&period=&search=&page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const loans = response.data || [];
            const tbody = document.getElementById('overdueModalTableBody');
            if (!tbody) return;
            this.stopOverdueCountdowns?.();
            
            if (loans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No overdue loans</td></tr>';
            } else {
                tbody.innerHTML = loans.map(loan => `
                    <tr>
                        <td class="text-center">${escapeHtml(loan.applicationNo || loan.loan_application_no)}</td>
                        <td class="text-center">${escapeHtml(loan.schoolId || loan.student_school_id)}</td>
                        <td class="text-center">${escapeHtml(loan.name || loan.student_name)}</td>
                        <td class="text-center">₱${parseFloat(loan.amount || loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td class="text-center"><span class="badge ${this.getStatusBadgeClass(loan.statusId || loan.loan_status_id)}">${escapeHtml(loan.statusName || loan.loan_status_name)}</span></td>
                        <td class="text-center">${loan.dateApplied || loan.loan_application_date ? new Date(loan.dateApplied || loan.loan_application_date).toLocaleDateString() : 'N/A'}</td>
                        <td class="text-center" data-loan-countdown></td>
                    </tr>
                `).join('');
                this.stopOverdueCountdowns = startLoanMgmtModalCountdowns(
                    document.getElementById('overdueModal'), tbody,
                    loans.map(loan => getLoanMgmtExpiryTimestamp(loan)),
                    timestamp => this.formatCountdown(timestamp)
                );
            }
            
            const modal = new bootstrap.Modal(document.getElementById('overdueModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading overdue loans:', error);
        }
    }

    bindEvents() {
        const semesterSelect = document.getElementById('filterSemester');
        const schoolYearSelect = document.getElementById('filterSchoolYear');
        const periodSelect = document.getElementById('filterPeriod');
        const applicationDateInput = document.getElementById('filterApplicationDate');
        const searchInput = document.getElementById('searchLoans');
        const searchInputMobile = document.getElementById('searchLoansMobile');
        const refreshBtn = document.getElementById('refreshBtn');
        const exportBtn = document.getElementById('exportBtn');
        const perPageSelect = document.getElementById('perPageSelect');
        const tbody = document.querySelector('#loansTable tbody');

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

        if (applicationDateInput) {
            applicationDateInput.addEventListener('change', (e) => {
                this.filters.applicationDate = e.target.value;
                const mobileDateInput = document.getElementById('filterApplicationDateMobile');
                if (mobileDateInput) mobileDateInput.value = e.target.value;
                this.currentPage = 1;
                this.loadLoans();
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
                    // Sync with desktop search
                    if (searchInput) searchInput.value = searchValue;
                    this.currentPage = 1;
                    this.loadLoans();
                }, 300);
            });
        }
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const semesterMobile = document.getElementById('filterSemesterMobile');
                const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
                const periodMobile = document.getElementById('filterPeriodMobile');
                const applicationDateMobile = document.getElementById('filterApplicationDateMobile');
                
                if (semesterMobile) {
                    this.filters.semester = semesterMobile.value;
                    // Sync with desktop filter
                    if (semesterSelect) semesterSelect.value = semesterMobile.value;
                }
                if (schoolYearMobile) {
                    this.filters.schoolYear = schoolYearMobile.value;
                    // Sync with desktop filter
                    if (schoolYearSelect) schoolYearSelect.value = schoolYearMobile.value;
                }
                if (periodMobile) {
                    this.filters.period = periodMobile.value;
                    // Sync with desktop filter
                    if (periodSelect) periodSelect.value = periodMobile.value;
                }
                if (applicationDateMobile) {
                    this.filters.applicationDate = applicationDateMobile.value;
                    if (applicationDateInput) applicationDateInput.value = applicationDateMobile.value;
                }
                
                // Close mobile dropdown
                const mobileFilterBtn = document.getElementById('mobileFilterBtn');
                if (mobileFilterBtn) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                    if (dropdownInstance) dropdownInstance.hide();
                }
                
                this.currentPage = 1;
                this.loadLoans();
            });
        }
        
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                // Reset to first page and clear filters FIRST
                this.currentPage = 1;
                
                // Reset filter dropdowns and filter values
                if (semesterSelect) {
                    semesterSelect.value = '';
                    this.filters.semester = '';
                }
                if (schoolYearSelect) {
                    schoolYearSelect.value = '';
                    this.filters.schoolYear = '';
                }
                if (periodSelect) {
                    periodSelect.value = '';
                    this.filters.period = '';
                }
                if (applicationDateInput) {
                    applicationDateInput.value = '';
                    this.filters.applicationDate = '';
                }
                const applicationDateMobile = document.getElementById('filterApplicationDateMobile');
                if (applicationDateMobile) applicationDateMobile.value = '';
                if (searchInput) {
                    searchInput.value = '';
                    this.filters.search = '';
                }
                if (searchInputMobile) {
                    searchInputMobile.value = '';
                }
                
                // Reload filters and loans (with cleared filters)
                await Promise.all([
                    this.loadFilters(),
                    this.loadLoans()
                ]);
            });
        }
        
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
                if (e.target.closest('.loan-select-checkbox')) return;
                if (e.target.closest(INLINE_ACTION_IGNORE)) return;
                const row = e.target.closest('tr[data-loan-id]');
                if (!row) return;
                const loanId = row.getAttribute('data-loan-id');
                if (loanId) {
                    this.viewLoan(loanId);
                }
            });
            tbody.addEventListener('change', (e) => {
                const checkbox = e.target.closest('.loan-select-checkbox');
                if (!checkbox) return;
                const loanId = Number(checkbox.dataset.loanId || 0);
                if (!loanId) return;
                if (checkbox.checked) this.selectedLoanIds.add(loanId);
                else this.selectedLoanIds.delete(loanId);
                this.updateBulkApprovalControls();
            });
        }

        document.getElementById('selectAllLoans')?.addEventListener('change', (e) => {
            const checked = Boolean(e.target.checked);
            this.loans.filter((loan) => this.canProcessLoan(loan)).forEach((loan) => {
                const loanId = Number(loan.loan_id || loan.loanId || loan.id || 0);
                if (!loanId) return;
                if (checked) this.selectedLoanIds.add(loanId);
                else this.selectedLoanIds.delete(loanId);
            });
            document.querySelectorAll('#loansTable .loan-select-checkbox').forEach((checkbox) => {
                checkbox.checked = checked;
            });
            this.updateBulkApprovalControls();
        });
        document.getElementById('bulkApproveBtn')?.addEventListener('click', () => this.bulkApproveSelected());
        document.getElementById('actionLoanForm')?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.submitAction();
        });
        
        // Action form submit
        const submitActionBtn = document.getElementById('submitActionBtn');
        if (submitActionBtn) {
            submitActionBtn.addEventListener('click', () => {
                this.submitAction();
            });
        }
    }

    async loadLoans() {
        if (!this.permissions.view) {
            const tbody = document.querySelector('#loansTable tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="${COO_LOAN_TABLE_COLSPAN}" class="text-center text-muted py-3">You do not have permission to view loans</td></tr>`;
            return;
        }
        try {
            const params = {
                action: 'list',
                page: this.currentPage,
                perPage: this.perPage,
                ...this.filters
            };
            
            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => {
                if (params[key] !== '') {
                    qs.set(key, params[key]);
                }
            });
            
            const res = await fetch(`../../api/coo/coo-loan-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            
            if (response.success) {
                this.loans = response.data || [];
                this.total = response.total || 0;
                this.totalPages = response.totalPages || 0;
                this.selectedLoanIds.clear();
                
                this.renderTable();
                this.updatePagination();
                this.updateStats();
            }
        } catch (err) {
            console.error('Error loading loans:', err);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load loans. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }

    updateStats() {
        // Note: Stats are loaded from API via loadStats(), this method is kept for backward compatibility
        // Update total count badge
        const totalCount = document.getElementById('totalCount');
        if (totalCount) {
            totalCount.textContent = `${this.total} application${this.total !== 1 ? 's' : ''}`;
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
                const mw = Math.max(menu.offsetWidth, 150);
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
                dd.removeAttribute('open');
            });
        };
        document.addEventListener('scroll', closeFloatingMenus, true);
        window.addEventListener('resize', closeFloatingMenus);
    }

    async viewLoan(loanId) {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`../../api/coo/coo-loan-management.php?action=details&loanId=${loanId}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            
            if (response.success) {
                const loan = response.loan;
                const modalEl = document.getElementById('viewLoanModal');
                if (!modalEl) return;
                
                // Get or create modal instance
                let modal = bootstrap.Modal.getInstance(modalEl);
                if (!modal) {
                    modal = new bootstrap.Modal(modalEl);
                }
                
                const content = document.getElementById('loanDetailsContent');
                
                if (content) {
                    content.innerHTML = this.renderLoanDetails(loan);
                }
                
                modal.show();
            }
        } catch (error) {
            console.error('Error loading loan details:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load loan details.',
                confirmButtonText: 'OK'
            });
        }
    }
    
    renderActionButtons(loan) {
        // COO processes only pending loans at workflow step 4.
        const sid = Number(loan.loan_status_id);
        const stepId = Number(loan.loan_current_step_id);
        if (stepId !== 4 || sid !== 1) {
            return '';
        }
        
        // Pending COO applications can be approved.
        const buttons = [];
        if (this.permissions.approve) {
            buttons.push(`<button type="button" class="btn btn-sm btn-success" onclick="window.cooLoansManagementModule.openActionModal(${loan.loan_id}, 'approve')">
                <i class="bi bi-check-circle me-1"></i>Approve
            </button>`);
        }
        return buttons.join('\n');
    }
    
    renderLoanDetails(loan) {
        return renderModernLoanDetails(
            loan,
            (statusId) => this.getStatusBadgeClass(statusId),
            (loanObj) => loanObj.loan_status_name || '-',
            {
                showVerifyButton: false,
                verifyFunctionName: 'verifyDocument',
                moduleName: 'cooLoansManagementModule',
                paymentStatusBadgeClass: 'bg-warning text-dark',
                pnStatusBadgeClass: 'bg-warning text-dark'
            }
        );
    }

    getStatusBadgeClass(statusId) {
        const classes = {
            1: 'bg-warning text-dark', // Pending
            2: 'bg-success', // Approved
            5: 'bg-success', // Completed
            6: 'bg-secondary', // Returned
            9: 'bg-secondary', // Cancelled
            11: 'bg-warning text-dark', // Partial payment
            12: 'bg-success' // Endorsed
        };
        return classes[statusId] || 'bg-secondary';
    }

    getPaymentStatusName(loan) {
        return loan.payment_status || loan.paymentStatus || 'Not Paid';
    }

    getPnStatusName(loan) {
        return loan.pn_status || loan.pnStatus || 'Not Tagged';
    }

    getPaymentStatusBadgeClass(status) {
        const value = String(status || '').toLowerCase();
        if (value === 'paid pending') return 'bg-info text-dark';
        if (value.includes('partial')) return 'bg-warning text-dark';
        if (value === 'paid') return 'bg-success';
        return 'bg-warning text-dark';
    }

    getPnStatusBadgeClass(status) {
        const value = String(status || '').toLowerCase();
        if (value === 'tagged') return 'bg-success';
        return 'bg-warning text-dark';
    }
    
    formatCountdown(expiryTimestamp) {
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
        const duration = days > 0 ? `${days}d ${hours}h ${minutes}m ${seconds}s` : (hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : (minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`));

        if (diff <= 0) return `<span class="badge bg-danger">Overdue -${duration}</span>`;
        
        if (days > 0) {
            return `<span class="badge ${days <= 1 ? 'bg-warning' : 'bg-info'}">${duration}</span>`;
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
        
        // Store interval ID for cleanup if needed
        if (!this.countdownIntervals) {
            this.countdownIntervals = {};
        }
        this.countdownIntervals[elementId] = intervalId;
    }
    
    // Cleanup method to clear all countdown intervals
    cleanupCountdowns() {
        if (this.countdownIntervals) {
            Object.values(this.countdownIntervals).forEach(intervalId => {
                clearInterval(intervalId);
            });
            this.countdownIntervals = {};
        }
    }

    renderTable() {
        const tbody = document.querySelector('#loansTable tbody');
        if (!tbody) return;

        this.cleanupCountdowns();
        tbody.innerHTML = '';

        if (this.loans.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${COO_LOAN_TABLE_COLSPAN}" class="text-center text-muted py-3">No loans found</td></tr>`;
            this.updateBulkApprovalControls();
            return;
        }

        this.loans.forEach(loan => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            const rowLoanId = loan.loan_id || loan.loanId || loan.id || '';
            row.setAttribute('data-loan-id', rowLoanId);

            // An application endorsed to COO retains status 12 (Endorsed), but
            // it remains actionable while assigned to the COO step.
            const canProcess = this.canProcessLoan(loan);
            const hasAnyActionPermission = this.permissions.approve || this.permissions.partialPayment || this.permissions.chat;
            const statusHtml = `<span class="badge ${this.getStatusBadgeClass(loan.statusId)}">${escapeHtml(loan.statusName || '-')}</span>`;
            const paymentStatusHtml = `<span class="badge ${this.getPaymentStatusBadgeClass(loan.payment_status)}">${escapeHtml(this.getPaymentStatusName(loan))}</span>`;
            const pnStatusHtml = `<span class="badge ${this.getPnStatusBadgeClass(loan.pn_status)}">${escapeHtml(this.getPnStatusName(loan))}</span>`;
            const actionsHtml = hasAnyActionPermission
                ? loanProcessActions({
                    loanId: rowLoanId,
                    canProcess,
                    permissions: {
                        approve: this.permissions.approve,
                        decline: false,
                        return: false,
                        partial: this.permissions.partialPayment,
                        chat: this.permissions.chat,
                    },
                })
                : '—';

            row.innerHTML = `<td class="text-center bulk-select-col" data-label="Select">
                ${canProcess && this.permissions.approve
                    ? `<input class="form-check-input loan-select-checkbox" type="checkbox" data-loan-id="${escapeHtml(String(rowLoanId))}" aria-label="Select ${escapeHtml(String(loan.applicationNo || loan.loan_application_no || 'loan'))}">`
                    : '<span class="text-muted">—</span>'}
            </td>` + buildLoanMgmtTableRowHtml({
                loan,
                escapeHtml,
                statusHtml,
                paymentStatusHtml,
                pnStatusHtml,
                actionsHtml,
                actionsCellClass: 'loan-actions-col',
                columnPreset: 'assessment',
                formatCountdown: (ts) => this.formatCountdown(ts),
            });
            tbody.appendChild(row);

            const expiry = getLoanMgmtExpiryTimestamp(loan);
            const countdownId = getLoanMgmtCountdownElementId(loan);
            if (expiry && countdownId) {
                this.startCountdown(countdownId, expiry);
            }
        });

        tbody.querySelectorAll('.action-approve').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (!loanId) return;
                this.openActionModal(loanId, 'approve');
            });
        });

        tbody.querySelectorAll('.action-partial-payment').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.partialPayment.open(Number(btn.dataset.loanId));
            });
        });

        tbody.querySelectorAll('.action-loan-chat').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.loanChat.open(Number(btn.dataset.loanId));
            });
        });

        this.updateBulkApprovalControls();

    }

    canProcessLoan(loan) {
        return Number(loan?.statusId ?? loan?.loan_status_id) === 12
            && Number(loan?.stepId ?? loan?.loan_current_step_id) === 4;
    }

    updateBulkApprovalControls() {
        const selectableIds = this.loans
            .filter((loan) => this.canProcessLoan(loan))
            .map((loan) => Number(loan.loan_id || loan.loanId || loan.id || 0))
            .filter(Boolean);
        const selectedCount = selectableIds.filter((loanId) => this.selectedLoanIds.has(loanId)).length;
        const countEl = document.getElementById('bulkApproveCount');
        const button = document.getElementById('bulkApproveBtn');
        const selectAll = document.getElementById('selectAllLoans');
        if (countEl) countEl.textContent = String(selectedCount);
        if (button) button.disabled = selectedCount === 0;
        if (selectAll) {
            selectAll.disabled = selectableIds.length === 0;
            selectAll.checked = selectableIds.length > 0 && selectedCount === selectableIds.length;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < selectableIds.length;
        }
    }

    async bulkApproveSelected() {
        const selectedLoans = this.loans.filter((loan) => {
            const loanId = Number(loan.loan_id || loan.loanId || loan.id || 0);
            return this.selectedLoanIds.has(loanId) && this.canProcessLoan(loan);
        });
        if (!selectedLoans.length || !this.permissions.approve) return;

        const confirmation = await window.Swal?.fire({
            icon: 'question',
            title: 'Approve selected loans?',
            text: `${selectedLoans.length} loan application${selectedLoans.length === 1 ? '' : 's'} will be approved and sent to Cashier.`,
            showCancelButton: true,
            confirmButtonText: 'Approve Selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#198754',
        });
        if (!confirmation?.isConfirmed) return;

        const button = document.getElementById('bulkApproveBtn');
        if (button) button.disabled = true;
        let approved = 0;
        const failures = [];
        for (const loan of selectedLoans) {
            const loanId = Number(loan.loan_id || loan.loanId || loan.id || 0);
            const amount = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount_can_pay ?? 0);
            try {
                const formData = new FormData();
                formData.append('action', 'process');
                formData.append('loanId', String(loanId));
                formData.append('processType', 'approve');
                formData.append('amountApproved', String(amount));
                formData.append('remarks', '');
                const response = await ApiService.postFormData('/coo/coo-loan-management.php', formData);
                if (!response?.success) throw new Error(response?.message || 'Approval failed');
                approved += 1;
            } catch (error) {
                failures.push(`${loan.applicationNo || loan.loan_application_no || `Loan ${loanId}`}: ${error.message || 'Approval failed'}`);
            }
        }

        await Promise.all([this.loadStats(), this.loadLoans()]);
        window.dispatchEvent(new Event('sidebar-live-counts:refresh'));
        await window.Swal?.fire({
            icon: failures.length ? 'warning' : 'success',
            title: failures.length ? 'Bulk approval completed with errors' : 'Loans approved',
            html: failures.length
                ? `<p>${approved} approved; ${failures.length} failed.</p><div class="text-start small">${failures.map((message) => `<div>${escapeHtml(message)}</div>`).join('')}</div>`
                : `${approved} loan application${approved === 1 ? '' : 's'} approved and sent to Cashier.`,
        });
    }
    
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
    
    async exportLoans() {
        if (!rbacUtil.requireModulePermission(this.permissions.view, 'export loans data')) {
            return;
        }
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        
        try {
            // Fetch every page that matches the current filters.
            const params = {
                action: 'list',
                page: 1,
                perPage: 100,
                status: this.filters.status || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                period: this.filters.period || '',
                applicationDate: this.filters.applicationDate || '',
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
                const res = await fetch(`../../api/coo/coo-loan-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
                const response = await res.json();
                if (!response.success || !Array.isArray(response.data)) {
                    throw new Error('Failed to fetch loan data for export');
                }
                exportLoans.push(...response.data);
                if (page >= Number(response.totalPages || 1)) break;
            }
            
            // Show format selection dialog
            const result = await swal.fire({
                title: 'Export Loans',
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
            const rows = exportLoans.map(r => mapLoanMgmtExportRow(r, r.statusName || ''));
            
            if (rows.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No loans found to export.',
                    confirmButtonText: 'OK'
                });
                return;
            }
            
            const choice = result.value;
            
            if (choice === 'csv') {
                const headers = Object.keys(rows[0] || {});
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
                // Add UTF-8 BOM for Excel compatibility
                const bom = '\uFEFF';
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `coo_loans_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }
            
            if (choice === 'xls') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `coo_loans_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }
            
            if (choice === 'doc') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;background:#f0f0f0;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><table style="border-collapse:collapse;width:100%;">${th}${trs}</table></body></html>`;
                this.downloadBlob(new Blob([html], { type: 'application/msword' }), `coo_loans_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }
            
            if (choice === 'pdf') {
                // Professional PDF export with enhanced design
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${h}</th>`).join('');
                const trs = rows.map((r, idx) => {
                    const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                    return `<tr style="background-color:${bgColor};">${headers.map(h => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`;
                }).join('');
                
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
                if (this.filters.applicationDate) {
                    const date = new Date(`${this.filters.applicationDate}T00:00:00`);
                    const dateLabel = Number.isNaN(date.getTime())
                        ? this.filters.applicationDate
                        : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                    filterParts.push(`Application Date: ${dateLabel}`);
                }
                if (this.filters.search) filterParts.push(`Search: "${this.filters.search}"`);
                const filterHtml = filterParts.length > 0 ? `<div class="filters"><strong>Applied Filters:</strong> ${filterParts.join(' | ')}</div>` : '';
                
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>COO Active Loans Export</title>
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
                            .summary { display: flex; gap: 15px; margin: 15px 0; }
                            .summary-box { flex: 1; background: #f8f9fa; padding: 12px; border-radius: 4px; text-align: center; border: 1px solid #dee2e6; }
                            .summary-box .label { font-size: 11px; color: #666; margin-bottom: 5px; }
                            .summary-box .value { font-size: 20px; font-weight: bold; color: #198754; }
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
                                    <h2>Active Loans Report - COO Office</h2>
                                </div>
                                <div class="report-info">
                                    <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                    <div><strong>Office:</strong> Chief Operating Officer</div>
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
                return;
            }
        } catch (error) {
            console.error('Error exporting loans:', error);
            // eslint-disable-next-line no-undef
            await swal.fire({
                icon: 'error',
                title: 'Export Failed',
                text: 'Failed to export loan data. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }

    closeViewLoanModal() {
        const viewLoanModalEl = document.getElementById('viewLoanModal');
        if (viewLoanModalEl) {
            bootstrap.Modal.getInstance(viewLoanModalEl)?.hide();
        }
    }

    async quickProcessLoan(loanId, actionType) {
        if (actionType === 'approve' && !this.permissions.approve) return;

        this.closeViewLoanModal();

        const payload = await confirmQuickLoanProcess({
            loanId,
            actionType,
            loans: this.loans,
            apiPath: 'coo/coo-loan-management.php',
        });
        if (!payload) return;

        try {
            const formData = new FormData();
            formData.append('action', 'process');
            formData.append('loanId', loanId);
            formData.append('processType', actionType);
            formData.append('amountApproved', payload.amountApproved || '');
            formData.append('remarks', payload.remarks);

            const response = await ApiService.postFormData('/coo/coo-loan-management.php', formData);

            if (response.success) {
                await showLoanProcessSuccess();
                await this.loadStats();
                await this.loadLoans();
            } else {
                throw new Error(response.message || 'Failed to process loan');
            }
        } catch (error) {
            console.error('Error processing loan:', error);
            await showLoanProcessError(error);
        }
    }

    async openActionModal(loanId, actionType) {
        if (actionType === 'approve' && !this.permissions.approve) return;
        if (actionType !== 'approve') return;
        this.closeViewLoanModal();
        
        const loanIdEl = document.getElementById('actionLoanId');
        const actionTypeEl = document.getElementById('actionType');
        const modalEl = document.getElementById('actionLoanModal');
        
        if (!loanIdEl || !actionTypeEl || !modalEl) return;
        
        const modal = new bootstrap.Modal(modalEl);
        const title = document.getElementById('actionLoanModalTitle');
        const form = document.getElementById('actionLoanForm');
        const header = document.getElementById('actionLoanModalHeader');
        
        // Reset form
        if (form) form.reset();

        loanIdEl.value = loanId;
        actionTypeEl.value = actionType;
        
        const loan = (this.loans || []).find((item) => Number(item.loan_id || item.loanId || item.id) === Number(loanId)) || {};
        const summaryStudent = document.getElementById('actionLoanSummaryStudent');
        const summaryAmount = document.getElementById('actionLoanSummaryAmount');
        const amountSection = document.getElementById('actionAmountSection');
        const remarksSection = document.getElementById('actionRemarksSection');
        const remarksTextarea = document.getElementById('actionRemarks');
        const submitBtn = document.getElementById('submitActionBtn');
        const amount = loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount_can_pay ?? loan.amount_approved ?? loan.approved_amount ?? 0;
        const formatPeso = (value) => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        if (summaryStudent) summaryStudent.textContent = loan.name || loan.student_name || loan.studentName || 'Student';
        
        if (actionType === 'approve') {
            // Approve mode
            if (title) title.textContent = 'Approve Loan';
            if (summaryAmount) summaryAmount.textContent = formatPeso(amount);
            const amountInput = document.getElementById('amountApproved');
            if (amountInput) amountInput.value = Number(amount) > 0 ? Number(amount).toFixed(2) : '';
            if (amountSection) amountSection.style.display = 'block';
            if (remarksSection) remarksSection.style.display = 'none';
            if (remarksTextarea) remarksTextarea.removeAttribute('required');
            if (submitBtn) {
                submitBtn.textContent = 'Approve Loan';
                submitBtn.className = 'btn btn-success';
            }
        }
        
        modal.show();
    }
    
    addNumberOnlyValidation(inputElement) {
        if (!inputElement) return;
        
        // Remove existing listeners by cloning the element
        const newInput = inputElement.cloneNode(true);
        inputElement.parentNode.replaceChild(newInput, inputElement);
        
        // Keyboard input validation
        newInput.addEventListener('keydown', (e) => {
            // Allow: backspace, delete, tab, escape, enter
            if ([8, 9, 27, 13, 46].indexOf(e.keyCode) !== -1 ||
                // Allow: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
                (e.keyCode === 65 && e.ctrlKey === true) ||
                (e.keyCode === 67 && e.ctrlKey === true) ||
                (e.keyCode === 86 && e.ctrlKey === true) ||
                (e.keyCode === 88 && e.ctrlKey === true) ||
                // Allow: home, end, left, right
                (e.keyCode >= 35 && e.keyCode <= 39)) {
                return;
            }
            
            // Allow decimal point (only one)
            if (e.key === '.' && !newInput.value.includes('.')) {
                return;
            }
            
            // Ensure that it is a number and stop the keypress
            if ((e.shiftKey || (e.keyCode < 48 || e.keyCode > 57)) && (e.keyCode < 96 || e.keyCode > 105)) {
                e.preventDefault();
            }
        });
        
        // Paste validation
        newInput.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedText = (e.clipboardData || window.clipboardData).getData('text');
            // Only allow numbers and decimal point
            const sanitized = pastedText.replace(/[^0-9.]/g, '');
            // Ensure only one decimal point
            const parts = sanitized.split('.');
            const finalValue = parts.length > 1 ? parts[0] + '.' + parts.slice(1).join('') : sanitized;
            newInput.value = finalValue;
        });
    }
    
    async submitAction() {
        const form = document.getElementById('actionLoanForm');
        if (!form || !form.checkValidity()) {
            if (form) form.reportValidity();
            return;
        }
        
        const loanId = document.getElementById('actionLoanId')?.value;
        const actionType = document.getElementById('actionType')?.value;
        const amountApproved = document.getElementById('amountApproved')?.value;
        const remarks = '';
        if (actionType === 'approve' && !this.permissions.approve) return;
        
        if (!loanId || actionType !== 'approve') {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Missing required fields',
                confirmButtonText: 'OK'
            });
            return;
        }
        
        try {
            const formData = new FormData();
            formData.append('action', 'process');
            formData.append('loanId', loanId);
            formData.append('processType', actionType);
            formData.append('amountApproved', amountApproved || '');
            formData.append('remarks', remarks);
            
            const response = await ApiService.postFormData('/coo/coo-loan-management.php', formData);
            
            if (response.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Loan processed successfully',
                    confirmButtonText: 'OK'
                });
                
                // Close action modal
                const actionModalEl = document.getElementById('actionLoanModal');
                if (actionModalEl) {
                    const actionModal = bootstrap.Modal.getInstance(actionModalEl);
                    if (actionModal) actionModal.hide();
                }
                
                await this.loadStats();
                await this.loadLoans();
            } else {
                throw new Error(response.message || 'Failed to process loan');
            }
        } catch (error) {
            console.error('Error processing loan:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message || 'Failed to process loan. Please try again.',
                confirmButtonText: 'OK'
            });
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
}

export default CooLoansManagementModule;
