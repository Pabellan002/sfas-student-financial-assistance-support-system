import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import { setApproveAmountDisplay } from '../../shared/shared-loan-action-amount.js';
import {
    confirmQuickLoanProcess,
    showLoanProcessError,
    showLoanProcessSuccess,
} from '../../shared/shared-loan-quick-actions.js';
import { INLINE_ACTION_IGNORE, loanProcessActions } from '../../shared/shared-inline-actions.js?v=20260909-partial-amount-only';
import {
    BRANCH_ADMIN_LOAN_MGMT_TABLE_COLSPAN,
    buildLoanMgmtTableRowHtml,
    getLoanMgmtCountdownElementId,
    getLoanMgmtExpiryTimestamp,
    mapLoanMgmtExportRow,
    startLoanMgmtModalCountdowns,
} from '../../shared/shared-loan-management-table.js?v=20261018-overdue-countdown';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js?v=20260913-paid-partial-status';
import StaffLoanChatController from '../../shared/shared-staff-loan-chat.js?v=20260927-chat-deeplinks';
import StaffPartialPaymentController from '../../shared/shared-staff-partial-payment.js?v=20260920-additive-partial';

export default class BranchAdminLoansManagementModule {
    constructor() {
        this.currentPage = 1;
        this.perPage = 10;
        this.filters = {
            status: '',
            period: '',
            semester: '',
            schoolYear: '',
            search: ''
        };

        this.loans = [];
        this.total = 0;
        this.totalPages = 0;
        this.stats = { pending: 0, overdue: 0 };
        this.selectedLoanIds = new Set();
        this.permissions = { view: false, approve: false, partialPayment: false, chat: false };
        this.loanChat = new StaffLoanChatController({
            hasPermission: () => this.permissions.chat,
            getLoans: () => this.loans,
        });
        this.partialPayment = new StaffPartialPaymentController({
            apiPath: '/branch-admin/branch-admin-loan-management.php',
            hasPermission: () => this.permissions.partialPayment,
            getLoans: () => this.loans,
            onUpdated: async () => {
                await this.loadLoans();
                window.dispatchEvent(new Event('sidebar-live-counts:refresh'));
            },
        });
    }

    async init() {
        await this.ensureSession();
        await this.loadPermissions();
        await this.loadFilters();
        await this.loadLoans();
        this.bindEvents();
        this.loanChat.bind();
        this.partialPayment.bind();
        this.applyActionVisibility();
        this.bindOutsideActionMenuClose();
        this.bindActionMenuPositionFix();
        this.setupMobileFilterClose();
        this.bindCardClicks();

        // Drop legacy ?loanId= from URL (notifications used to open the details modal automatically).
        const url = new URL(window.location.href);
        if (url.searchParams.has('loanId')) {
            url.searchParams.delete('loanId');
            const next = url.pathname + (url.search ? url.search : '') + url.hash;
            window.history.replaceState({}, '', next);
        }
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
    }

    async loadPermissions() {
        try {
            const response = await ApiService.get('/masterfiles/masterfiles-permissions.php', { action: 'get_my_permissions' });
            if (!response?.success || !Array.isArray(response.permissions)) return;
            const can = (key) => response.permissions.some((permission) => permission.permission_key === key && Number(permission.is_granted) === 1);
            this.permissions = {
                view: can('branch_admin.loans.view'),
                approve: can('branch_admin.loans.approve'),
                partialPayment: can('branch_admin.loans.partial_payment'),
                chat: can('branch_admin.loans.chat'),
            };
        } catch (error) {
            console.error('Error loading Branch Admin loan permissions:', error);
        }
    }

    applyActionVisibility() {
        const exportButton = document.getElementById('exportBtn');
        if (exportButton) exportButton.style.display = this.permissions.view ? '' : 'none';
        const bulkButton = document.getElementById('bulkApproveBtn');
        if (bulkButton) bulkButton.style.display = this.permissions.approve ? '' : 'none';
    }

    async loadFilters() {
        try {
            const res = await fetch(
                '../../api/branch-admin/branch-admin-loan-management.php?action=filters',
                { credentials: 'same-origin', cache: 'no-store' }
            );
            const response = await res.json();

            if (!response.success) return;

            const allowedStatusIds = [1, 12];

            const statusSelect = document.getElementById('filterStatus');
            if (statusSelect) {
                statusSelect.innerHTML = '';
                const all = document.createElement('option');
                all.value = '';
                all.textContent = 'All Status';
                statusSelect.appendChild(all);

                (response.statuses || [])
                    .filter(s => allowedStatusIds.includes(parseInt(s.loan_status_id, 10)))
                    .forEach(s => {
                        const opt = document.createElement('option');
                        opt.value = s.loan_status_id;
                        opt.textContent = s.loan_status_name;
                        statusSelect.appendChild(opt);
                    });
            }

            // Populate period filter (desktop and mobile)
            const periodSelect = document.getElementById('filterPeriod');
            const periodSelectMobile = document.getElementById('filterPeriodMobile');
            [periodSelect, periodSelectMobile].forEach(select => {
                if (select) {
                    select.innerHTML = '';
                    const all = document.createElement('option');
                    all.value = '';
                    all.textContent = 'All Periods';
                    select.appendChild(all);

                    (response.periods || []).forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.app_period_id;
                        opt.textContent = p.app_period_name;
                        select.appendChild(opt);
                    });
                }
            });

            const semesterSelect = document.getElementById('filterSemester');
            const semesterSelectMobile = document.getElementById('filterSemesterMobile');
            [semesterSelect, semesterSelectMobile].forEach((select) => {
                if (select) {
                    select.innerHTML = '';
                    const allSem = document.createElement('option');
                    allSem.value = '';
                    allSem.textContent = 'All Semesters';
                    select.appendChild(allSem);
                    (response.semesters || []).forEach((semester) => {
                        const option = document.createElement('option');
                        option.value = semester.semester_id;
                        option.textContent = semester.semester_name;
                        select.appendChild(option);
                    });
                }
            });

            const schoolYearSelect = document.getElementById('filterSchoolYear');
            const schoolYearSelectMobile = document.getElementById('filterSchoolYearMobile');
            [schoolYearSelect, schoolYearSelectMobile].forEach((select) => {
                if (select) {
                    select.innerHTML = '';
                    const allSy = document.createElement('option');
                    allSy.value = '';
                    allSy.textContent = 'All School Years';
                    select.appendChild(allSy);
                    (response.schoolYears || []).forEach((sy) => {
                        const option = document.createElement('option');
                        option.value = sy.id;
                        option.textContent = sy.code;
                        select.appendChild(option);
                    });
                }
            });
        } catch (_) {
            // Fail silently; table still loads with default filters.
        }
    }

    async resolveCsrfToken() {
        let t = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')?.trim();
        if (!t) {
            t = await ApiService.refreshCSRFToken();
        }
        return t || null;
    }

    bindEvents() {
        const semesterSelect = document.getElementById('filterSemester');
        const schoolYearSelect = document.getElementById('filterSchoolYear');
        const periodSelect = document.getElementById('filterPeriod');
        const searchInput = document.getElementById('searchLoans');
        const searchInputMobile = document.getElementById('searchLoansMobile');
        const refreshBtn = document.getElementById('refreshBtn');
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

        if (searchInput) {
            let t;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(t);
                const val = e.target.value.trim();
                t = setTimeout(() => {
                    this.filters.search = val;
                    this.currentPage = 1;
                    this.loadLoans();
                }, 300);
            });
        }

        // Mobile search input
        if (searchInputMobile) {
            let t;
            searchInputMobile.addEventListener('input', (e) => {
                clearTimeout(t);
                const val = e.target.value.trim();
                t = setTimeout(() => {
                    this.filters.search = val;
                    // Sync with desktop search
                    if (searchInput) searchInput.value = val;
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
                this.currentPage = 1;
                this.filters = { status: '', period: '', semester: '', schoolYear: '', search: '' };

                const statusSelect = document.getElementById('filterStatus');
                const semesterSelect = document.getElementById('filterSemester');
                const schoolYearSelect = document.getElementById('filterSchoolYear');
                
                if (statusSelect) statusSelect.value = '';
                if (periodSelect) periodSelect.value = '';
                if (semesterSelect) semesterSelect.value = '';
                if (schoolYearSelect) schoolYearSelect.value = '';
                if (searchInput) searchInput.value = '';
                if (searchInputMobile) searchInputMobile.value = '';

                await this.loadFilters();
                await this.loadLoans();
            });
        }

        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportToExcel());
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
                // Check if clicked on action button
                const actionBtn = e.target.closest('button[data-action="view"]');
                if (actionBtn) {
                    e.stopPropagation();
                    const loanId = actionBtn.getAttribute('data-loan-id');
                    if (loanId) this.viewLoan(loanId);
                    return;
                }

                if (e.target.closest(INLINE_ACTION_IGNORE)) return;

                // Otherwise handle row click
                const row = e.target.closest('tr[data-loan-id]');
                if (!row) return;
                const loanId = row.getAttribute('data-loan-id');
                if (loanId) this.viewLoan(loanId);
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
            this.loans.filter((loan) => this.canProcess(loan)).forEach((loan) => {
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
    }

    async loadLoans() {
        if (!this.permissions.view) {
            const tbody = document.querySelector('#loansTable tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="${BRANCH_ADMIN_LOAN_MGMT_TABLE_COLSPAN + 1}" class="text-center text-muted py-3">You do not have permission to view loans</td></tr>`;
            return;
        }
        try {
            const params = {
                action: 'list',
                page: this.currentPage,
                perPage: this.perPage,
                status: this.filters.status || '',
                period: this.filters.period || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                search: this.filters.search || ''
            };

            const qs = new URLSearchParams();
            Object.keys(params).forEach((k) => {
                if (params[k] !== '') qs.set(k, params[k]);
            });

            const res = await fetch(`../../api/branch-admin/branch-admin-loan-management.php?${qs.toString()}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const response = await res.json(); // Debug log

            if (!response.success) return;

            this.loans = Array.isArray(response.data) ? response.data : [];
            this.total = response.total || 0;
            this.totalPages = response.totalPages || 0;
            this.stats = response.stats || { pending: 0, overdue: 0 }; // Debug log
            this.selectedLoanIds.clear();

            this.renderTable();
            this.updatePagination();
            this.updateStats();
        } catch (err) {
            console.error('Load loans error:', err); // Debug log
            window.Swal?.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load loans. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }

    renderTable() {
        const tbody = document.querySelector('#loansTable tbody');
        if (!tbody) return;

        this.cleanupCountdowns();
        tbody.innerHTML = '';

        if (this.loans.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${BRANCH_ADMIN_LOAN_MGMT_TABLE_COLSPAN + 1}" class="text-center text-muted py-3">No loans found</td></tr>`;
            this.updateBulkApprovalControls();
            return;
        }

        this.loans.forEach((loan) => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            const rowLoanId = loan.loan_id || loan.loanId || loan.id || '';
            row.setAttribute('data-loan-id', rowLoanId);

            const statusHtml = `<span class="badge ${this.getStatusBadgeClass(loan.statusId)}">${escapeHtml(loan.statusName || '-')}</span>`;
            const paymentStatusHtml = loan.payment_status_name 
                ? `<span class="badge ${this.getPaymentStatusBadgeClass(loan.payment_status_id)}">${escapeHtml(loan.payment_status_name)}</span>`
                : '<span class="badge bg-secondary">Not Paid</span>';
            const pnStatusHtml = loan.pn_status_name
                ? `<span class="badge ${this.getPnStatusBadgeClass(loan.pn_status_id)}">${escapeHtml(loan.pn_status_name)}</span>`
                : '<span class="badge bg-secondary">Not Set</span>';
            const actionsHtml = this.renderLoanProcessActions(loan, rowLoanId);

            row.innerHTML = `<td class="text-center bulk-select-col" data-label="Select">
                ${this.canProcess(loan) && this.permissions.approve
                    ? `<input class="form-check-input loan-select-checkbox" type="checkbox" data-loan-id="${escapeHtml(String(rowLoanId))}" aria-label="Select ${escapeHtml(String(loan.applicationNo || loan.loan_application_no || 'loan'))}">`
                    : '<span class="text-muted">—</span>'}
            </td>` + buildLoanMgmtTableRowHtml({
                loan,
                escapeHtml,
                statusHtml,
                paymentStatusHtml,
                pnStatusHtml,
                actionsHtml,
                formatCountdown: (ts) => this.formatCountdown(ts),
                columnPreset: 'branch-admin',
            });

            row.addEventListener('click', (e) => {
                if (!e.target.closest('.loan-select-checkbox') && !e.target.closest(INLINE_ACTION_IGNORE)) {
                    this.viewLoan(rowLoanId);
                }
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
                this.openApprovalAction(loanId);
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

    updateBulkApprovalControls() {
        const selectableIds = this.loans
            .filter((loan) => this.canProcess(loan))
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
        if (!this.permissions.approve) return;
        const selectedLoans = this.loans.filter((loan) => {
            const loanId = Number(loan.loan_id || loan.loanId || loan.id || 0);
            return this.selectedLoanIds.has(loanId) && this.canProcess(loan);
        });
        if (!selectedLoans.length) return;

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
        let token = null;
        try {
            token = await this.resolveCsrfToken();
        } catch (error) {
            this.updateBulkApprovalControls();
            await window.Swal?.fire({ icon: 'error', title: 'Unable to approve loans', text: error.message || 'Unable to validate this request.' });
            return;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-CSRF-Token'] = token;
        let approved = 0;
        const failures = [];
        for (const loan of selectedLoans) {
            const loanId = Number(loan.loan_id || loan.loanId || loan.id || 0);
            const amount = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount_can_pay ?? 0);
            try {
                const res = await fetch('../../api/branch-admin/branch-admin-loan-management.php', {
                    method: 'POST',
                    headers,
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        action: 'process',
                        loanId,
                        processType: 'approve',
                        amountApproved: amount,
                        remarks: '',
                    }),
                });
                const response = await res.json();
                if (!response?.success) throw new Error(response?.message || 'Approval failed');
                approved += 1;
            } catch (error) {
                failures.push(`${loan.applicationNo || loan.loan_application_no || `Loan ${loanId}`}: ${error.message || 'Approval failed'}`);
            }
        }

        await this.loadLoans();
        window.dispatchEvent(new Event('sidebar-live-counts:refresh'));
        await window.Swal?.fire({
            icon: failures.length ? 'warning' : 'success',
            title: failures.length ? 'Bulk approval completed with errors' : 'Loans approved',
            html: failures.length
                ? `<p>${approved} approved; ${failures.length} failed.</p><div class="text-start small">${failures.map((message) => `<div>${escapeHtml(message)}</div>`).join('')}</div>`
                : `${approved} loan application${approved === 1 ? '' : 's'} approved and sent to Cashier.`,
        });
    }

    getLoanAmountForRouting(loan) {
        return Number(loan?.loan_amount_can_pay ?? loan?.amountCanPay ?? loan?.amount ?? 0);
    }

    getBranchApprovalAction(loan) {
        const amount = this.getLoanAmountForRouting(loan);
        if (amount <= 3000) {
            return { type: 'approve', label: 'Approve', title: 'Approve for PN Tagging', destination: 'Assessment Office' };
        }
        return {
            type: 'endorse',
            label: 'Endorse',
            title: amount <= 7500 ? 'Endorse to Cashier' : 'Endorse to COO',
            destination: amount <= 7500 ? 'Cashier Office' : 'COO Office',
        };
    }

    renderLoanProcessActions(loan, loanId) {
        return loanProcessActions({
            loanId,
            canProcess: this.canProcess(loan),
            permissions: {
                approve: this.permissions.approve,
                partial: this.permissions.partialPayment,
                chat: this.permissions.chat,
            },
        });
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

    updateStats() {
        const pendingEl = document.getElementById('statPending');
        const overdueEl = document.getElementById('statOverdue'); // Debug log // Debug log

        const setText = (el, v) => { if (el) el.textContent = String(v ?? 0); };

        // Use statistics from API response instead of calculating from filtered data
        const pending = this.stats?.pending ?? 0;
        const overdue = this.stats?.overdue ?? 0; // Debug log

        setText(pendingEl, pending);
        setText(overdueEl, overdue);

        const totalBadge = document.getElementById('totalCount');
        if (totalBadge) totalBadge.textContent = `${this.total} applications`;
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

    getPaymentStatusBadgeClass(paymentStatusId) {
        const classes = {
            1: 'bg-danger', // Not Paid
            2: 'bg-warning text-dark', // Partially Paid
            3: 'bg-success', // Fully Paid
            4: 'bg-info text-dark', // Paid Pending
            5: 'bg-warning text-dark', // Paid Partial
        };
        return classes[paymentStatusId] || 'bg-secondary';
    }

    getPnStatusBadgeClass(pnStatusId) {
        const classes = {
            1: 'bg-secondary', // Not Set
            2: 'bg-info', // Set
            3: 'bg-success', // Validated
        };
        return classes[pnStatusId] || 'bg-secondary';
    }

    canProcess(loan) {
        // Branch Admin only processes Assessment-endorsed applications.
        // Check stepId (API returns this) or currentStepId/loan_current_step_id (fallback)
        return Number(loan?.statusId ?? loan?.loan_status_id) === 12
            && Number(loan?.stepId ?? loan?.currentStepId ?? loan?.loan_current_step_id) === 3;
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
        const duration = days > 0 ? `${days}d ${hours}h ${minutes}m ${seconds}s`
            : hours > 0 ? `${hours}h ${minutes}m ${seconds}s`
            : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        if (diff <= 0) return `<span class="badge bg-danger">Overdue -${duration}</span>`;

        if (days > 0) return `<span class="badge ${days <= 1 ? 'bg-warning' : 'bg-info'}">${duration}</span>`;
        if (hours > 0) return `<span class="badge bg-warning">${duration}</span>`;
        return `<span class="badge bg-danger">${duration}</span>`;
    }

    async viewLoan(loanId) {
        try {
            const res = await fetch(`../../api/branch-admin/branch-admin-loan-management.php?action=details&loanId=${encodeURIComponent(loanId)}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const response = await res.json();
            if (!response.success) return;

            const loan = response.loan || {};
            const modalEl = document.getElementById('viewLoanModal');
            if (!modalEl) return;

            let modal = bootstrap.Modal.getInstance(modalEl);
            if (!modal) modal = new bootstrap.Modal(modalEl);

            const content = document.getElementById('loanDetailsContent');
            if (content) content.innerHTML = this.renderLoanDetails(loan);

            modal.show();
        } catch (error) {
            window.Swal?.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load loan details.',
                confirmButtonText: 'OK'
            });
        }
    }

    bindCardClicks() {
        const cardPending = document.getElementById('cardPending');
        const cardOverdue = document.getElementById('cardOverdue');

        if (cardPending) {
            cardPending.addEventListener('click', () => this.showPendingModal());
        }
        if (cardOverdue) {
            cardOverdue.addEventListener('click', () => this.showOverdueModal());
        }
    }

    async showPendingModal() {
        try {
            // Branch Admin handles endorsed applications (status=12) at their step (step=3)
            const res = await fetch(`../../api/branch-admin/branch-admin-loan-management.php?action=list&status=12&period=&search=&page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const loans = response.data || [];
            const tbody = document.getElementById('pendingModalTableBody');
            if (!tbody) return;
            
            if (loans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No pending loans</td></tr>';
            } else {
                tbody.innerHTML = loans.map(loan => {
                    const paymentStatusBadge = loan.payment_status_name 
                        ? `<span class="badge ${this.getPaymentStatusBadgeClass(loan.payment_status_id)}">${escapeHtml(loan.payment_status_name)}</span>`
                        : '<span class="badge bg-secondary">Not Paid</span>';
                    const pnStatusBadge = loan.pn_status_name
                        ? `<span class="badge ${this.getPnStatusBadgeClass(loan.pn_status_id)}">${escapeHtml(loan.pn_status_name)}</span>`
                        : '<span class="badge bg-secondary">Not Set</span>';
                    const dueDate = loan.dueDate || loan.loan_due_date ? new Date(loan.dueDate || loan.loan_due_date).toLocaleDateString() : 'N/A';
                    
                    return `
                        <tr>
                            <td class="text-center">${escapeHtml(loan.applicationNo)}</td>
                            <td class="text-center">${escapeHtml(loan.schoolId)}</td>
                            <td class="text-center">${escapeHtml(loan.name)}</td>
                            <td class="text-center">₱${parseFloat(loan.amountCanPay || loan.amount || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="text-center"><span class="badge ${this.getStatusBadgeClass(loan.statusId)}">${escapeHtml(loan.statusName)}</span></td>
                            <td class="text-center">${paymentStatusBadge}</td>
                            <td class="text-center">${pnStatusBadge}</td>
                            <td class="text-center">${dueDate}</td>
                        </tr>
                    `;
                }).join('');
            }
            
            const modal = new bootstrap.Modal(document.getElementById('pendingModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading pending loans:', error);
        }
    }

    async showOverdueModal() {
        try {
            const res = await fetch(`../../api/branch-admin/branch-admin-loan-management.php?action=list&status=&period=&search=&page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const now = new Date();
            
            const loans = (response.data || []).filter(loan => {
                if (!loan.expiryTimestamp) return false;
                const expiryDate = new Date(loan.expiryTimestamp);
                return expiryDate < now;
            });
            
            const tbody = document.getElementById('overdueModalTableBody');
            if (!tbody) return;
            this.stopOverdueCountdowns?.();
            
            if (loans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No overdue loans</td></tr>';
            } else {
                tbody.innerHTML = loans.map(loan => {
                    const paymentStatusBadge = loan.payment_status_name 
                        ? `<span class="badge ${this.getPaymentStatusBadgeClass(loan.payment_status_id)}">${escapeHtml(loan.payment_status_name)}</span>`
                        : '<span class="badge bg-secondary">Not Paid</span>';
                    const pnStatusBadge = loan.pn_status_name
                        ? `<span class="badge ${this.getPnStatusBadgeClass(loan.pn_status_id)}">${escapeHtml(loan.pn_status_name)}</span>`
                        : '<span class="badge bg-secondary">Not Set</span>';
                    const dueDate = loan.dueDate || loan.loan_due_date ? new Date(loan.dueDate || loan.loan_due_date).toLocaleDateString() : 'N/A';
                    
                    return `
                        <tr>
                            <td class="text-center">${escapeHtml(loan.applicationNo)}</td>
                            <td class="text-center">${escapeHtml(loan.schoolId)}</td>
                            <td class="text-center">${escapeHtml(loan.name)}</td>
                            <td class="text-center">₱${parseFloat(loan.amountCanPay || loan.amount || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="text-center"><span class="badge ${this.getStatusBadgeClass(loan.statusId)}">${escapeHtml(loan.statusName)}</span></td>
                            <td class="text-center">${paymentStatusBadge}</td>
                            <td class="text-center">${pnStatusBadge}</td>
                            <td class="text-center">${dueDate}</td>
                            <td class="text-center" data-loan-countdown></td>
                        </tr>
                    `;
                }).join('');
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

    renderLoanDetails(loan) {
        return renderModernLoanDetails(
            loan,
            (statusId) => this.getStatusBadgeClass(statusId),
            (loanObj) => loanObj.loan_status_name || '-',
            {
                showVerifyButton: false,
                verifyFunctionName: 'verifyDocument',
                moduleName: 'branchAdminLoansManagementModule'
            }
        );
    }

    async exportToExcel() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            // Build params to fetch all matching loans
            const params = {
                action: 'list',
                page: 1,
                perPage: 100,
                status: this.filters.status || '',
                period: this.filters.period || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                search: this.filters.search || ''
            };

            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => {
                if (params[key] !== '' || key === 'action' || key === 'page' || key === 'perPage') {
                    qs.set(key, params[key]);
                }
            });

            // Show format selection dialog first
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
                    confirmButton: 'btn btn-success px-4 me-2', 
                    cancelButton: 'btn btn-secondary px-4'
                }
            });

            if (!result.isConfirmed) return;

            const exportLoans = [];
            for (let page = 1; ; page += 1) {
                qs.set('page', String(page));
                const res = await fetch(`../../api/branch-admin/branch-admin-loan-management.php?${qs.toString()}`, {
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

            // Check if there's data to export AFTER format selection
            if (exportLoans.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'There is no data to export.',
                    confirmButtonColor: '#198754'
                });
                return;
            }

            // Map loans data to export format
            const rows = exportLoans.map(r => mapLoanMgmtExportRow(
                r, 
                r.statusName || '', 
                r.payment_status_name || 'Not Paid', 
                r.pn_status_name || 'Not Set',
                'branch-admin'
            ));

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
                link.download = `branch-admin-loans-${new Date().toISOString().split('T')[0]}.csv`;
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
                link.download = `branch-admin-loans-${new Date().toISOString().split('T')[0]}.xls`;
                link.click();
            } else if (choice === 'doc') {
                const headers = Object.keys(rows[0] || {});
                let html = '<html><head><meta charset="utf-8"><title>Loans Export</title></head><body>';
                html += '<h1>Branch Admin Loans Export</h1>';
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
                link.download = `branch-admin-loans-${new Date().toISOString().split('T')[0]}.doc`;
                link.click();
            } else if (choice === 'pdf') {
                // Professional PDF export with enhanced design
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
                const trs = rows.map((r, idx) => {
                    const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                    return `<tr style="background-color:${bgColor};">${headers.map(h => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(r[h] ?? ''))}</td>`).join('')}</tr>`;
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
                if (this.filters.search) filterParts.push(`Search: "${this.filters.search}"`);
                const filterHtml = filterParts.length > 0 ? `<div class="filters"><strong>Applied Filters:</strong> ${filterParts.join(' | ')}</div>` : '';
                
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>Branch Admin Active Loans Export</title>
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
                                    <h2>Active Loans Report - Branch Office</h2>
                                </div>
                                <div class="report-info">
                                    <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                    <div><strong>Office:</strong> Branch Administrator</div>
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

            await swal.fire({
                icon: 'success',
                title: 'Exported',
                text: `Loans exported successfully as ${choice.toUpperCase()}`,
                confirmButtonText: 'OK'
            });

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

    closeViewLoanModal() {
        const viewLoanModalEl = document.getElementById('viewLoanModal');
        if (viewLoanModalEl) {
            bootstrap.Modal.getInstance(viewLoanModalEl)?.hide();
        }
    }

    async openApprovalAction(loanId) {
        return this.openActionModal(loanId, 'approve');
        /* Legacy endorsement flow retained below for compatibility with old records. */
        const loan = this.loans.find((item) => Number(item.loan_id || item.loanId || item.id) === Number(loanId));
        if (!loan) {
            await window.Swal?.fire({ icon: 'error', title: 'Loan not found', text: 'Refresh the list and try again.' });
            return;
        }

        const amount = this.getLoanAmountForRouting(loan);
        if (!(amount > 0)) {
            await window.Swal?.fire({ icon: 'warning', title: 'Amount required', text: 'This loan has no valid Amount Can Pay to process.' });
            return;
        }

        const action = this.getBranchApprovalAction(loan);
        if (action.type === 'approve') {
            return this.quickProcessLoan(loanId, 'approve');
        }

        this.closeViewLoanModal();
        const studentName = escapeHtml(loan.student_name || loan.name || 'Student');
        const applicationNo = escapeHtml(loan.loan_application_no || loan.applicationNo || '-');
        const formattedAmount = amount.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
        const confirmed = await window.Swal?.fire({
            icon: 'question',
            title: 'Endorse Application',
            html: `<p class="mb-2">Endorse this application to the next office for review?</p><p class="mb-1"><strong>${studentName}</strong> · ${applicationNo}</p><p class="mb-0">Amount Can Pay: <strong>${formattedAmount}</strong><br>Next office: <strong>${action.destination}</strong></p>`,
            showCancelButton: true,
            confirmButtonText: 'Endorse',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#007319',
            cancelButtonColor: '#6c757d',
        });
        if (!confirmed?.isConfirmed) return;

        try {
            const token = await this.resolveCsrfToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['X-CSRF-Token'] = token;

            const res = await fetch('../../api/branch-admin/branch-admin-loan-management.php', {
                method: 'POST',
                headers,
                credentials: 'same-origin',
                body: JSON.stringify({
                    action: 'process',
                    loanId,
                    processType: 'endorse',
                    amountApproved: amount,
                    remarks: '',
                }),
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message || 'Failed to endorse loan');

            await window.Swal?.fire({
                icon: 'success',
                title: 'Application Endorsed',
                text: `The application was endorsed to ${action.destination}.`,
                confirmButtonText: 'OK',
            });
            await this.loadLoans();
        } catch (error) {
            console.error('Error endorsing loan:', error);
            await showLoanProcessError(error);
        }
    }

    async quickProcessLoan(loanId, actionType) {
        this.closeViewLoanModal();

        const payload = await confirmQuickLoanProcess({
            loanId,
            actionType,
            loans: this.loans,
            apiPath: 'branch-admin/branch-admin-loan-management.php',
        });
        if (!payload) return;

        try {
            const token = await this.resolveCsrfToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['X-CSRF-Token'] = token;

            const res = await fetch('../../api/branch-admin/branch-admin-loan-management.php', {
                method: 'POST',
                headers,
                credentials: 'same-origin',
                body: JSON.stringify({
                    action: 'process',
                    loanId,
                    processType: actionType,
                    amountApproved: payload.amountApproved,
                    remarks: payload.remarks,
                }),
            });
            const response = await res.json();

            if (response.success) {
                await showLoanProcessSuccess();
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
        if (actionType === 'decline') {
            return this.quickProcessLoan(loanId, actionType);
        }
        if (actionType !== 'approve') return;
        this.closeViewLoanModal();
        
        const loanIdEl = document.getElementById('actionLoanId');
        const actionTypeEl = document.getElementById('actionType');
        const modalEl = document.getElementById('actionLoanModal');
        
        if (!loanIdEl || !actionTypeEl || !modalEl) return;

        const modal = new bootstrap.Modal(modalEl);
        const title = document.getElementById('actionLoanModalTitle');
        const form = document.getElementById('actionLoanForm');

        if (form) form.reset();

        loanIdEl.value = loanId;
        actionTypeEl.value = actionType;
        
        const loan = (this.loans || []).find((item) => Number(item.loan_id || item.loanId || item.id) === Number(loanId)) || {};
        const summaryStudent = document.getElementById('actionLoanSummaryStudent');
        const summaryAmount = document.getElementById('actionLoanSummaryAmount');
        const submitBtn = document.getElementById('submitActionBtn');
        const remarksSection = document.getElementById('actionRemarksSection');
        const remarksTextarea = document.getElementById('actionRemarks');
        const amountSection = document.getElementById('actionAmountSection');
        const amount = loan.amountCanPay ?? loan.loan_amount_can_pay ?? loan.amount_can_pay ?? loan.amount_approved ?? loan.approved_amount ?? 0;
        const formatPeso = (value) => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        {
            if (title) title.textContent = 'Approve Loan';
            if (remarksSection) remarksSection.style.display = 'none';
            if (remarksTextarea) remarksTextarea.removeAttribute('required');
            if (amountSection) amountSection.style.display = 'block';
            if (submitBtn) {
                submitBtn.textContent = 'Approve Loan';
                submitBtn.className = 'btn btn-success';
            }
        }
        
        if (summaryStudent) summaryStudent.textContent = loan.name || loan.student_name || loan.studentName || 'Student';
        if (summaryAmount) summaryAmount.textContent = formatPeso(amount);
        const amountInput = document.getElementById('amountApproved');
        if (amountInput) amountInput.value = Number(amount) > 0 ? Number(amount).toFixed(2) : '';
        
        modal.show();
        
        // Setup submit button handler
        if (submitBtn) {
            submitBtn.onclick = () => this.submitAction();
        }
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
        
        if (!loanId || actionType !== 'approve') {
            window.Swal?.fire({
                icon: 'error',
                title: 'Error',
                text: 'Missing required fields',
                confirmButtonText: 'OK'
            });
            return;
        }
        
        try {
            const token = await this.resolveCsrfToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['X-CSRF-Token'] = token;

            const res = await fetch('../../api/branch-admin/branch-admin-loan-management.php', {
                method: 'POST',
                headers,
                credentials: 'same-origin',
                body: JSON.stringify({
                    action: 'process',
                    loanId,
                    processType: actionType,
                    amountApproved,
                    remarks
                })
            });
            
            const response = await res.json();
            
            if (response.success) {
                window.Swal?.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Loan processed successfully',
                    confirmButtonText: 'OK'
                });
                
                const modalEl = document.getElementById('actionLoanModal');
                if (modalEl) {
                    const modalInstance = bootstrap.Modal.getInstance(modalEl);
                    if (modalInstance) modalInstance.hide();
                }
                
                await this.loadLoans();
            } else {
                throw new Error(response.message || 'Failed to process loan');
            }
        } catch (error) {
            console.error('Error processing loan:', error);
            window.Swal?.fire({
                icon: 'error',
                title: 'Error',
                text: error.message || 'Failed to process loan. Please try again.',
                confirmButtonText: 'OK'
            });
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
    
    setupMobileFilterClose() {
        // Close mobile filter dropdown when sidebar opens on mobile
        const sidebarToggle = document.getElementById('sidebarToggle');
        const mobileFilterBtn = document.getElementById('mobileFilterBtn');
        
        if (sidebarToggle && mobileFilterBtn) {
            sidebarToggle.addEventListener('click', () => {
                // Check if we're on mobile (sidebar toggle is visible)
                if (window.innerWidth < 768) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                    if (dropdownInstance) {
                        dropdownInstance.hide();
                    }
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
    
    cleanupCountdowns() {
        if (this.countdownIntervals) {
            Object.values(this.countdownIntervals).forEach(intervalId => {
                clearInterval(intervalId);
            });
            this.countdownIntervals = {};
        }
    }
}
