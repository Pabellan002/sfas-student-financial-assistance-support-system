import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import ApiService from '../../services/services-apiService.js';
import { setApproveAmountDisplay } from '../../shared/shared-loan-action-amount.js';
import {
    confirmQuickLoanProcess,
    showLoanProcessError,
    showLoanProcessSuccess,
} from '../../shared/shared-loan-quick-actions.js';
import { INLINE_ACTION_IGNORE, loanProcessActions } from '../../shared/shared-inline-actions.js';
import {
    LOAN_MGMT_TABLE_COLSPAN,
    buildLoanMgmtTableRowHtml,
    getLoanMgmtCountdownElementId,
    getLoanMgmtExpiryTimestamp,
    mapLoanMgmtExportRow,
} from '../../shared/shared-loan-management-table.js';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js?v=20260913-paid-partial-status';

class FinanceLoansManagementModule {
    constructor() {
        this.currentPage = 1;
        this.perPage = 10;
        this.filters = {
            status: '',
            period: '',
            campus: '',
            search: ''
        };
        this.loans = [];
        this.total = 0;
        this.totalPages = 0;
        this.modal = null;
        this.permissions = {
            view: false,
            markPaid: false,
            markPartial: false,
            markPaidPending: false,
            decline: false,
            endorse: false,
            export: false
        };
    }

    async getCsrfToken() {
        let token = document.querySelector('meta[name="csrf-token"]')?.content;
        if (!token) {
            token = await ApiService.refreshCSRFToken();
        }
        return token || '';
    }

    async appendCsrfToFormData(formData) {
        const token = await this.getCsrfToken();
        if (token) {
            formData.append('csrf_token', token);
        }
    }

    async init() {
        await this.ensureSession();
        await this.loadPermissions();
        await this.loadFilters();
        await this.loadStats();
        await this.loadLoans();
        this.bindEvents();
        this.bindCardFilters();
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
                view: can('cashier.loans.view'),
                markPaid: can('cashier.loans.mark_paid'),
                markPartial: can('cashier.loans.partial_payment'),
                markPaidPending: can('cashier.loans.mark_paid_pending'),
                decline: false,
                endorse: false,
                export: can('cashier.loans.view')
            };
        } catch (error) {
            console.error('Error loading finance loan permissions:', error);
        }
    }

    applyActionVisibility() {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.style.display = this.permissions.export ? '' : 'none';
    }

    async loadStats() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch('../../api/cashier/cashier-loan-management.php?action=payment_tagging_stats', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success && response.stats) {
                const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
                set('statPending', response.stats.readyForPayment);
                set('statPaidPending', response.stats.paidPending);
                const liveCount = Math.max(0, Number(response.stats.readyForPayment) || 0);
                document.querySelectorAll('[data-live-count-path="stats.readyForPayment"]').forEach((badge) => {
                    badge.textContent = liveCount > 99 ? '99+' : String(liveCount);
                    badge.setAttribute('title', `${liveCount} loans ready for payment`);
                    badge.setAttribute('aria-label', `${liveCount} loans ready for payment`);
                });
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    bindCardFilters() {
        document.querySelectorAll('[data-view]').forEach(card => {
            card.addEventListener('click', async () => {
                const view = card.getAttribute('data-view');
                if (view === 'ready') {
                    await this.showPendingModal();
                } else if (view === 'paid-pending') {
                    await this.showPaidPendingModal();
                }
            });
        });
    }

    async showPendingModal() {
        try {
            const params = new URLSearchParams({
                action: 'payment_tagging_list',
                page: '1',
                perPage: '1000',
                campus: this.filters.campus || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                period: this.filters.period || '',
                search: this.filters.search || ''
            });
            params.set('view', 'ready');
            const res = await fetch(`../../api/cashier/cashier-loan-management.php?${params.toString()}`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const loans = response.rows || [];
            const tbody = document.getElementById('pendingModalTableBody');
            if (!tbody) return;
            const count = document.querySelector('#pendingModal [data-card-modal-count]');
            if (count) count.textContent = loans.length ? `Showing ${loans.length} record${loans.length === 1 ? '' : 's'}` : 'No records';
            
            if (loans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No loans are ready for payment</td></tr>';
            } else {
                tbody.innerHTML = loans.map(loan => `
                    <tr>
                        <td class="text-center">${escapeHtml(loan.applicationNo || loan.loan_application_no)}</td>
                        <td class="text-center">${escapeHtml(loan.studentId || loan.schoolId || loan.student_school_id || '-')}</td>
                        <td class="text-center">${escapeHtml(loan.studentName || loan.name || loan.student_name || '-')}</td>
                        <td class="text-center">₱${parseFloat(loan.amountCanPay || loan.amount || loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td class="text-center">${this.formatPaymentAmount(loan.recordedPaymentAmount)}</td>
                        <td class="text-center"><span class="badge ${this.getPaymentStatusBadgeClass(loan.paymentStatus || loan.payment_status)}">${escapeHtml(this.getPaymentStatusName(loan))}</span></td>
                        <td class="text-center">${loan.dueDate || loan.loan_due_date || '-'}</td>
                    </tr>
                `).join('');
            }
            
            const modal = new bootstrap.Modal(document.getElementById('pendingModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading pending loans:', error);
        }
    }

    async showPaidPendingModal() {
        try {
            const params = new URLSearchParams({
                action: 'payment_tagging_list',
                page: '1',
                perPage: '1000',
                campus: this.filters.campus || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                period: this.filters.period || '',
                search: this.filters.search || ''
            });
            params.set('view', 'paid_pending');
            const res = await fetch(`../../api/cashier/cashier-loan-management.php?${params.toString()}`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const loans = response.rows || [];
            const tbody = document.getElementById('paidPendingModalTableBody');
            if (!tbody) return;
            const count = document.querySelector('#paidPendingModal [data-card-modal-count]');
            if (count) count.textContent = loans.length ? `Showing ${loans.length} record${loans.length === 1 ? '' : 's'}` : 'No records';
            
            if (loans.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No paid-pending loans</td></tr>';
            } else {
                tbody.innerHTML = loans.map(loan => `
                    <tr>
                        <td class="text-center">${escapeHtml(loan.applicationNo || loan.loan_application_no)}</td>
                        <td class="text-center">${escapeHtml(loan.studentId || loan.schoolId || loan.student_school_id)}</td>
                        <td class="text-center">${escapeHtml(loan.studentName || loan.name || loan.student_name)}</td>
                        <td class="text-center">₱${parseFloat(loan.amountCanPay || loan.amount || loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td class="text-center">${this.formatPaymentAmount(loan.recordedPaymentAmount)}</td>
                        <td class="text-center"><span class="badge ${this.getPaymentStatusBadgeClass(loan.paymentStatus || loan.payment_status)}">${escapeHtml(this.getPaymentStatusName(loan))}</span></td>
                        <td class="text-center">${escapeHtml(loan.currentStepName || '-')}</td>
                        <td class="text-center">${this.formatPaymentDate(loan.paymentRecordedAtEpoch)}</td>
                    </tr>
                `).join('');
            }
            
            const modal = new bootstrap.Modal(document.getElementById('paidPendingModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading paid-pending loans:', error);
        }
    }

    getStatusColor(statusId) {
        const colors = {
            1: 'warning',      // Pending
            2: 'success',      // Approved
            5: 'secondary',    // Completed
            6: 'warning',      // Returned
            9: 'secondary',    // Cancelled
            11: 'warning'      // Partial Payment
        };
        return colors[statusId] || 'secondary';
    }


    async loadFilters() {
        try {
            const res = await fetch('../../api/cashier/cashier-loan-management.php?action=payment_tagging_filters', { credentials: 'same-origin', cache: 'no-store' });
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
                    
                    // Only show Pending (1) status
                    const allowedStatusIds = [1];
                    response.statuses
                        .filter(status => allowedStatusIds.includes(parseInt(status.loan_status_id)))
                        .forEach(status => {
                            const option = document.createElement('option');
                            option.value = status.loan_status_id;
                            option.textContent = status.loan_status_name;
                            if (status.loan_status_id === '1') {
                                option.selected = true;
                            }
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
                        option.value = sy.id;
                        option.textContent = sy.code;
                        select.appendChild(option);
                    });
                });

                const campuses = response.campuses || [];
                const campusSelect = document.getElementById('filterCampus');
                const campusSelectMobile = document.getElementById('filterCampusMobile');
                [campusSelect, campusSelectMobile].forEach((select) => {
                    if (!select) return;
                    select.innerHTML = '<option value="">All Campuses</option>';
                    campuses.forEach((campus) => {
                        const option = document.createElement('option');
                        option.value = campus.campus_id;
                        option.textContent = campus.campus_name;
                        select.appendChild(option);
                    });
                });
            }
        } catch (error) {
            console.error('Error loading filters:', error);
        }
    }

    bindEvents() {
        const campusSelect = document.getElementById('filterCampus');
        const semesterSelect = document.getElementById('filterSemester');
        const schoolYearSelect = document.getElementById('filterSchoolYear');
        const periodSelect = document.getElementById('filterPeriod');
        const searchInput = document.getElementById('searchLoans');
        const refreshBtn = document.getElementById('refreshBtn');
        const exportBtn = document.getElementById('exportBtn');
        const perPageSelect = document.getElementById('perPageSelect');
        const tbody = document.querySelector('#loansTable tbody');

        if (campusSelect) {
            campusSelect.addEventListener('change', (e) => {
                this.filters.campus = e.target.value;
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
        
        // Mobile search
        const searchInputMobile = document.getElementById('searchLoansMobile');
        if (searchInputMobile) {
            let searchTimeout;
            searchInputMobile.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const searchValue = e.target.value.trim();
                searchTimeout = setTimeout(() => {
                    this.filters.search = searchValue;
                    this.currentPage = 1;
                    // Sync with desktop search
                    if (searchInput) searchInput.value = searchValue;
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
                const campusMobile = document.getElementById('filterCampusMobile');
                
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
                if (campusMobile) {
                    this.filters.campus = campusMobile.value;
                    if (campusSelect) campusSelect.value = campusMobile.value;
                }
                
                // Close mobile dropdown
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
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
                if (periodSelect) {
                    periodSelect.value = '';
                    this.filters.period = '';
                }
                if (campusSelect) {
                    campusSelect.value = '';
                    this.filters.campus = '';
                }
                if (searchInput) {
                    searchInput.value = '';
                    this.filters.search = '';
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
                const row = e.target.closest('tr[data-loan-id]');
                if (!row) return;
                const loanId = row.getAttribute('data-loan-id');
                if (loanId) {
                    this.viewLoan(loanId);
                }
            });
        }
        
        // Action form submit
        const submitActionBtn = document.getElementById('submitActionBtn');
        if (submitActionBtn) {
            submitActionBtn.addEventListener('click', () => {
                this.submitAction();
            });
        }
        const submitCashierPaymentBtn = document.getElementById('submitCashierPaymentBtn');
        if (submitCashierPaymentBtn) {
            submitCashierPaymentBtn.addEventListener('click', () => this.submitPaymentStatus());
        }
        const submitMarkPaidBtn = document.getElementById('submitMarkPaidBtn');
        if (submitMarkPaidBtn) {
            submitMarkPaidBtn.addEventListener('click', () => {
                const loanId = Number(document.getElementById('markPaidLoanId')?.value || 0);
                const paymentAmount = Number(document.getElementById('markPaidAmount')?.value || 0);
                if (loanId > 0 && paymentAmount > 0) this.submitMarkAsPaid(loanId, paymentAmount);
            });
        }
        document.getElementById('cashierPaymentForm')?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.submitPaymentStatus();
        });
        
    }

    async loadLoans() {
        if (!this.permissions.view) {
            const tbody = document.querySelector('#loansTable tbody');
                if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-3">You do not have permission to view active loans</td></tr>';
            return;
        }
        try {
            const params = {
                action: 'payment_tagging_list',
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
            
            const res = await fetch(`../../api/cashier/cashier-loan-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            
            if (response.success) {
                this.loans = (response.rows || []).map((loan) => ({
                    ...loan,
                    loan_id: loan.loanId,
                    loan_application_no: loan.applicationNo,
                    student_school_id: loan.studentId,
                    student_name: loan.studentName,
                    loan_amount_can_pay: loan.amountCanPay,
                    loan_due_date: loan.dueDate,
                    loan_expiry_timestamp: loan.expiryTimestamp,
                    loan_current_step_id: loan.stepId || loan.loan_current_step_id,
                    loan_status_id: loan.statusId || loan.loan_status_id || 1,
                    loan_payment_status_id: loan.paymentStatusId || loan.loan_payment_status_id || 1,
                    loan_status_name: loan.statusName || loan.loan_status_name || 'Pending',
                    statusId: loan.statusId || loan.loan_status_id || 1,
                    statusName: loan.statusName || loan.loan_status_name || 'Pending',
                    payment_status: loan.paymentStatus || loan.payment_status || 'Not Paid',
                    pn_status: loan.pnStatus || loan.pn_status || 'Not Tagged'
                }));
                this.total = response.total || 0;
                this.totalPages = Math.max(1, Math.ceil(this.total / this.perPage));
                
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
        // Calculate stats from all loans (not just current page)
        // We need to fetch all loans for stats or calculate from server
        // For now, we'll calculate from current loans array
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // Calculate start of current week (Monday)
        const dayOfWeek = now.getDay(); // 0 (Sunday) to 6 (Saturday)
        const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Days to subtract to get to Monday
        const weekStart = new Date(today);
        weekStart.setDate(weekStart.getDate() - daysToMonday);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        
        // Date 7 days from now for expiring soon
        const expiringSoonDate = new Date(today);
        expiringSoonDate.setDate(expiringSoonDate.getDate() + 7);
        
        const counts = { 
            endorsed: 0, 
            expiringSoon: 0, 
            daily: 0, 
            weekly: 0 
        };
        
        for (const r of this.loans) {
            // Endorsed applications (statusId 8 is Endorsed based on filter)
            if (String(r.statusId) === '8' || String(r.statusId) === '7') {
                counts.endorsed++;
            }
            
            // Expiring soon (within next 7 days)
            if (r.expiryTimestamp) {
                const expiryDate = new Date(r.expiryTimestamp);
                if (expiryDate >= today && expiryDate <= expiringSoonDate) {
                    counts.expiringSoon++;
                }
            }
            
            // Daily applications (applied today)
            if (r.dateApplied) {
                const appliedDate = new Date(r.dateApplied);
                const appliedDateOnly = new Date(appliedDate.getFullYear(), appliedDate.getMonth(), appliedDate.getDate());
                if (appliedDateOnly.getTime() === today.getTime()) {
                    counts.daily++;
                }
                
                // Weekly applications (applied in current week, Monday to Sunday)
                if (appliedDateOnly >= weekStart && appliedDateOnly < weekEnd) {
                    counts.weekly++;
                }
            }
        }
        
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val || 0); };
        set('statEndorsed', counts.endorsed);
        set('statExpiringSoon', counts.expiringSoon);
        set('statDaily', counts.daily);
        set('statWeekly', counts.weekly);
        
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

    async viewLoan(loanId) {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`../../api/cashier/cashier-loan-management.php?action=details&loanId=${loanId}`, { credentials: 'same-origin', cache: 'no-store' });
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
                const actionButtons = document.getElementById('loanActionButtons');
                
                if (content) {
                    content.innerHTML = this.renderLoanDetails(loan);
                }
                
                // Render action buttons
                if (actionButtons) {
                    actionButtons.innerHTML = this.renderActionButtons(loan);
                    this.bindPaymentActionButtons(actionButtons);
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
    
    renderActionButtons(loan, { showCompletedMark = false } = {}) {
        const stepId = Number(loan.loan_current_step_id || loan.stepId || 0);
        const statusId = Number(loan.loan_status_id || loan.statusId);
        const paymentStatusId = Number(loan.loan_payment_status_id || loan.paymentStatusId || 1);
        const paymentStatusName = String(loan.payment_status || loan.paymentStatus || '').toLowerCase();
        const completedMark = '<span class="badge bg-success text-nowrap" title="Payment complete">Complete</span>';
        const noAction = '<span class="badge bg-secondary text-nowrap" title="No payment action available">No action</span>';

        if (statusId === 5) {
            return showCompletedMark ? completedMark : noAction;
        }
        if (paymentStatusId === 3 || paymentStatusName === 'paid') {
            return showCompletedMark ? completedMark : noAction;
        }
        if (statusId === 9) {
            return noAction;
        }
        if (stepId === 2 && statusId === 2) {
            const amountCanPay = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0);
            const amountPaid = Number(loan.recordedPaymentAmount ?? loan.loan_recorded_payment_amount ?? 0);
            const remainingAmount = Math.max(0, amountCanPay - amountPaid);
            const actions = [];
            if (this.permissions.markPartial && paymentStatusId !== 4 && remainingAmount > 0.01) {
                actions.push(`<button type="button" class="inline-action-btn inline-action-btn--return action-mark-partial" data-loan-id="${loan.loan_id}" title="Mark as Partial Paid" aria-label="Mark as Partial Paid"><i class="bi bi-pie-chart-fill"></i></button>`);
            }
            if (this.permissions.markPaid) {
                actions.push(`<button type="button" class="inline-action-btn inline-action-btn--approve action-mark-paid" data-loan-id="${loan.loan_id}" title="Mark as Paid" aria-label="Mark as Paid"><i class="bi bi-cash-coin"></i></button>`);
            }
            return actions.length
                ? `<span class="inline-row-actions" role="group" aria-label="Payment actions">${actions.join('')}</span>`
                : noAction;
        }
        if (this.permissions.markPaidPending && paymentStatusId !== 4 && paymentStatusName !== 'paid pending') {
            return `<span class="inline-row-actions" role="group" aria-label="Payment actions"><button type="button" class="inline-action-btn inline-action-btn--edit action-paid-pending" data-loan-id="${loan.loan_id}" title="Mark as Pending Loan Approval" aria-label="Mark as Pending Loan Approval"><i class="bi bi-hourglass-split"></i></button></span>`;
        }
        return noAction;
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

    getPaymentStatusName(loan) {
        return String(loan?.payment_status || loan?.paymentStatus || 'Not Paid');
    }

    getPaymentStatusBadgeClass(statusName) {
        const status = String(statusName || '').toLowerCase();
        if (status === 'paid') return 'bg-success';
        if (status === 'paid pending') return 'bg-warning text-dark';
        if (status === 'paid partial') return 'bg-warning text-dark';
        if (status === 'partial payment') return 'bg-warning text-dark';
        return 'bg-secondary';
    }

    formatPaymentAmount(value) {
        if (value === null || value === undefined || value === '') return '-';
        const amount = Number(value);
        if (!Number.isFinite(amount)) return '-';
        return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    formatPaymentDate(epochSeconds) {
        if (epochSeconds === null || epochSeconds === undefined || epochSeconds === '') return '-';
        const date = new Date(Number(epochSeconds) * 1000);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('en-US', {
            timeZone: 'Asia/Manila',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    getPnStatusName(loan) {
        return String(loan?.pn_status || loan?.pnStatus || 'Not Tagged');
    }

    getPnStatusBadgeClass(statusName) {
        return String(statusName || '').toLowerCase() === 'tagged' ? 'bg-success' : 'bg-secondary';
    }

    getStatusBadgeClass(statusId) {
        const classes = {
            1: 'bg-warning text-dark', // Pending
            2: 'bg-success', // Approved
            5: 'bg-success', // Completed
            6: 'bg-warning text-dark', // Returned
            9: 'bg-secondary', // Cancelled
            11: 'bg-warning text-dark', // Partial Payment
            12: 'bg-success' // Endorsed
        };
        return classes[statusId] || 'bg-secondary';
    }

    canProcess(loan) {
        // Only allow processing if status is Pending (1)
        return loan.statusId === 1;
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
        const duration = days > 0 ? `${days}d ${hours}h ${minutes}m` : (hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : (minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`));

        if (diff <= 0) return `<span class="badge bg-danger">Overdue -${duration}</span>`;
        
        if (days > 0) {
            return `<span class="badge ${days <= 1 ? 'bg-warning' : 'bg-info'}">${days}d ${hours}h ${minutes}m</span>`;
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
            const expiry = new Date(expiryTimestamp);
            const now = new Date();
            const diff = expiry - now;
            
            if (diff <= 0) {
                element.innerHTML = this.formatCountdown(expiryTimestamp);
                return;
            }
            
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);
            
            if (days > 0) {
                element.innerHTML = `<span class="badge ${days <= 1 ? 'bg-warning' : 'bg-info'}">${days}d ${hours}h ${minutes}m ${seconds}s</span>`;
            } else if (hours > 0) {
                element.innerHTML = `<span class="badge bg-warning">${hours}h ${minutes}m ${seconds}s</span>`;
            } else if (minutes > 0) {
                element.innerHTML = `<span class="badge bg-danger">${minutes}m ${seconds}s</span>`;
            } else {
                element.innerHTML = `<span class="badge bg-danger">${seconds}s</span>`;
            }
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
            tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-3">No active loans found</td></tr>';
            return;
        }

        this.loans.forEach(loan => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            const rowLoanId = loan.loan_id || loan.loanId || loan.id || '';
            row.setAttribute('data-loan-id', rowLoanId);

            const status = escapeHtml(loan.statusName || loan.loan_status_name || 'Pending');
            const paymentStatus = escapeHtml(this.getPaymentStatusName(loan));
            const pnStatus = escapeHtml(this.getPnStatusName(loan));
            const actionsHtml = this.renderActionButtons(loan, { showCompletedMark: true });
            const amount = Number(loan.amountCanPay || loan.loan_amount_can_pay || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            row.innerHTML = `
                <td class="text-center">${escapeHtml(loan.applicationNo || loan.loan_application_no || '-')}</td>
                <td class="text-center">${escapeHtml(loan.studentId || loan.student_school_id || '-')}</td>
                <td class="text-center">${escapeHtml(loan.studentName || loan.student_name || '-')}</td>
                <td class="text-center">₱${amount}</td>
                <td class="text-center">${this.formatPaymentAmount(loan.recordedPaymentAmount)}</td>
                <td class="text-center"><span class="badge ${this.getStatusBadgeClass(loan.statusId || loan.loan_status_id)}">${status}</span></td>
                <td class="text-center"><span class="badge ${this.getPaymentStatusBadgeClass(loan.paymentStatus || loan.payment_status)}">${paymentStatus}</span></td>
                <td class="text-center"><span class="badge ${this.getPnStatusBadgeClass(loan.pnStatus || loan.pn_status)}">${pnStatus}</span></td>
                <td class="text-center">${escapeHtml(loan.dueDate || loan.loan_due_date || '-')}</td>
                <td class="text-center">${this.formatPaymentDate(loan.paymentRecordedAtEpoch)}</td>
                <td class="text-center">${actionsHtml}</td>`;

            row.addEventListener('click', (e) => {
                if (!e.target.closest(INLINE_ACTION_IGNORE)) {
                    this.viewLoan(rowLoanId);
                }
            });

            tbody.appendChild(row);
        });

        this.bindPaymentActionButtons(tbody);
    }

    bindPaymentActionButtons(container) {
        if (!container) return;
        container.querySelectorAll('.action-mark-paid').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (!loanId) return;
                this.confirmPayment(loanId);
            });
        });
        container.querySelectorAll('.action-mark-partial').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (!loanId) return;
                this.openPartialPaymentModal(loanId);
            });
        });
        container.querySelectorAll('.action-paid-pending').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (!loanId) return;
                this.recordPaidPending(loanId);
            });
        });
    }

    async confirmPayment(loanId) {
        if (!this.permissions.markPaid) return;
        const loan = this.loans.find((item) => Number(item.loan_id || item.loanId) === Number(loanId)) || {};
        const amountCanPay = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0);
        const amountPaid = Number(loan.recordedPaymentAmount ?? loan.loan_recorded_payment_amount ?? 0);
        const isPaidPending = Number(loan.paymentStatusId ?? loan.loan_payment_status_id ?? 0) === 4;
        const paymentAmount = isPaidPending || (amountPaid > 0 && amountPaid >= amountCanPay)
            ? amountPaid
            : Math.max(0, amountCanPay - amountPaid);
        if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            await window.Swal?.fire({ icon: 'error', title: 'Unable to mark as paid', text: 'No valid payment amount is recorded for this loan.' });
            return;
        }
        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        };
        const loanIdInput = document.getElementById('markPaidLoanId');
        const amountInput = document.getElementById('markPaidAmount');
        if (loanIdInput) loanIdInput.value = String(loanId);
        if (amountInput) amountInput.value = paymentAmount.toFixed(2);
        setText('markPaidStudentName', loan.studentName || loan.student_name || '-');
        setText('markPaidApplicationNo', loan.applicationNo || loan.loan_application_no || '-');
        setText('markPaidAmountLabel', amountPaid > 0 && !isPaidPending ? 'Remaining Payment' : 'Payment Amount');
        setText('markPaidAmountDisplay', this.formatPaymentAmount(paymentAmount));
        const modalEl = document.getElementById('markPaidModal');
        if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }

    recordPaidPending(loanId) {
        if (!this.permissions.markPaidPending) return;
        this.openPaymentModal(loanId, 'payment_tagging_mark_paid_pending');
    }

    async submitMarkAsPaid(loanId, paymentAmount) {
        const submitButton = document.getElementById('submitMarkPaidBtn');
        if (submitButton) submitButton.disabled = true;
        try {
            const formData = new FormData();
            formData.append('action', 'payment_tagging_mark_paid');
            formData.append('loanId', String(loanId));
            formData.append('paymentAmount', Number(paymentAmount).toFixed(2));
            await this.appendCsrfToFormData(formData);
            const response = await fetch('../../api/cashier/cashier-loan-management.php?action=payment_tagging_mark_paid', {
                method: 'POST', body: formData, credentials: 'same-origin'
            });
            const data = await response.json();
            if (!data?.success) throw new Error(data?.message || 'Unable to mark the loan as paid.');
            bootstrap.Modal.getInstance(document.getElementById('markPaidModal'))?.hide();
            await window.Swal.fire({ icon: 'success', title: 'Payment Confirmed', text: data.message });
            await Promise.all([this.loadStats(), this.loadLoans()]);
        } catch (error) {
            console.error('Cashier mark-as-paid error:', error);
            await window.Swal?.fire({ icon: 'error', title: 'Unable to mark as paid', text: error.message || 'Please try again.' });
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    }

    openPaymentModal(loanId, action) {
        if (action === 'payment_tagging_mark_paid_pending' && !this.permissions.markPaidPending) return;
        const loan = this.loans.find((item) => Number(item.loan_id || item.loanId) === Number(loanId)) || {};
        const suggestedAmount = Number(loan.recordedPaymentAmount || loan.amountCanPay || loan.loan_amount_can_pay || 0);
        const form = document.getElementById('cashierPaymentForm');
        form?.reset();
        form?.classList.remove('was-validated');
        const amountInput = document.getElementById('cashierPaymentAmount');
        if (amountInput) {
            amountInput.value = suggestedAmount > 0 ? suggestedAmount.toFixed(2) : '';
            amountInput.setCustomValidity('');
        }
        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        };
        const loanIdInput = document.getElementById('cashierPaymentLoanId');
        const actionInput = document.getElementById('cashierPaymentAction');
        if (loanIdInput) loanIdInput.value = String(loanId);
        if (actionInput) actionInput.value = action;
        setText('cashierPaymentStudentName', loan.studentName || loan.student_name || '-');
        setText('cashierPaymentApplicationNo', loan.applicationNo || loan.loan_application_no || '-');
        setText('cashierPaymentAmountCanPay', this.formatPaymentAmount(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0));
        const title = document.getElementById('cashierPaymentModalTitle');
        if (title) title.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Mark as Pending Loan Approval';
        setText('cashierPaymentHelp', 'The loan will remain with its current officer and continue through approval.');
        const submitLabel = document.querySelector('#submitCashierPaymentBtn span');
        if (submitLabel) submitLabel.textContent = 'Mark as Pending Loan Approval';
        const modalEl = document.getElementById('cashierPaymentModal');
        if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
        window.setTimeout(() => amountInput?.focus(), 250);
    }

    async submitPaymentStatus() {
        const loanId = Number(document.getElementById('cashierPaymentLoanId')?.value || 0);
        const action = document.getElementById('cashierPaymentAction')?.value || '';
        if (action !== 'payment_tagging_mark_paid_pending' || !this.permissions.markPaidPending) return;
        const form = document.getElementById('cashierPaymentForm');
        const amountInput = document.getElementById('cashierPaymentAmount');
        const rawAmount = String(amountInput?.value || '').trim();
        const amount = Number(rawAmount);
        const validAmount = /^\d+(?:\.\d{1,2})?$/.test(rawAmount) && Number.isFinite(amount) && amount > 0;
        if (amountInput) amountInput.setCustomValidity(validAmount ? '' : 'Enter a valid payment amount.');
        form?.classList.add('was-validated');
        if (!loanId || !action || !validAmount || !form?.checkValidity()) {
            form?.reportValidity();
            return;
        }
        const submitButton = document.getElementById('submitCashierPaymentBtn');
        if (submitButton) submitButton.disabled = true;

        try {
            const formData = new FormData();
            formData.append('action', action);
            formData.append('loanId', String(loanId));
            formData.append('paymentAmount', amount.toFixed(2));
            await this.appendCsrfToFormData(formData);
            const response = await fetch(`../../api/cashier/cashier-loan-management.php?action=${encodeURIComponent(action)}`, {
                method: 'POST', body: formData, credentials: 'same-origin'
            });
            const data = await response.json();
            if (!data?.success) throw new Error(data?.message || 'Unable to update the payment status.');
            bootstrap.Modal.getInstance(document.getElementById('cashierPaymentModal'))?.hide();
            await window.Swal.fire({ icon: 'success', title: 'Pending Loan Approval Saved', text: data.message });
            await Promise.all([this.loadStats(), this.loadLoans()]);
        } catch (error) {
            console.error('Cashier payment status error:', error);
            await window.Swal?.fire({ icon: 'error', title: 'Unable to update payment', text: error.message || 'Please try again.' });
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
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
        if (!rbacUtil.requireModulePermission(this.permissions.export, 'export loans data')) {
            return;
        }
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        
        try {
            // Fetch every page that matches the current filters.
            const params = {
                action: 'payment_tagging_list',
                page: 1,
                perPage: 1000,
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
                const res = await fetch(`../../api/cashier/cashier-loan-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
                const response = await res.json();
                if (!response.success || !Array.isArray(response.rows)) {
                    throw new Error('Failed to fetch loan data for export');
                }
                exportLoans.push(...response.rows);
                if (page >= Math.max(1, Math.ceil(Number(response.total || 0) / Number(response.perPage || 1000)))) break;
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
            
            // Map loans data to export format - pass payment and PN status labels
            const rows = exportLoans.map(r => {
                const statusLabel = r.statusName || r.loan_status_name || '';
                const paymentStatusLabel = this.getPaymentStatusName(r);
                const pnStatusLabel = this.getPnStatusName(r);
                const row = mapLoanMgmtExportRow(r, statusLabel, paymentStatusLabel, pnStatusLabel, 'branch-admin');
                return {
                    ...row,
                    'Amount Paid': r.recordedPaymentAmount === null || r.recordedPaymentAmount === undefined
                        ? ''
                        : Number(r.recordedPaymentAmount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                    'Current Step': r.currentStepName || '',
                    Campus: r.campusName || ''
                };
            });
            
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
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `cashier_active_loans_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }
            
            if (choice === 'xls') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `cashier_active_loans_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }
            
            if (choice === 'doc') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;background:#f0f0f0;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><table style="border-collapse:collapse;width:100%;">${th}${trs}</table></body></html>`;
                this.downloadBlob(new Blob([html], { type: 'application/msword' }), `cashier_active_loans_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }
            
            if (choice === 'pdf') {
                this.exportPDF(rows);
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

    exportPDF(rows) {
        // Professional PDF export with enhanced design using HTML print
        const headers = Object.keys(rows[0] || {});
        
        // Build filter summary
        const filterParts = [];
        const campusSelect = document.getElementById('filterCampus') || document.getElementById('filterCampusMobile');
        const semesterSelect = document.getElementById('filterSemester') || document.getElementById('filterSemesterMobile');
        const schoolYearSelect = document.getElementById('filterSchoolYear') || document.getElementById('filterSchoolYearMobile');
        const periodSelect = document.getElementById('filterPeriod') || document.getElementById('filterPeriodMobile');
        
        if (this.filters.campus && campusSelect) {
            const selectedOption = Array.from(campusSelect.options).find(opt => opt.value === this.filters.campus);
            if (selectedOption) filterParts.push(`Campus: ${selectedOption.text}`);
        }
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
                <title>Cashier Active Loans Report</title>
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
                            <h2>Active Loans Report - Cashier Office</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Office:</strong> Cashier</div>
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

    closeViewLoanModal() {
        const viewLoanModalEl = document.getElementById('viewLoanModal');
        if (viewLoanModalEl) {
            bootstrap.Modal.getInstance(viewLoanModalEl)?.hide();
        }
    }

    async quickProcessLoan(loanId, actionType) {
        if (actionType === 'approve' && !this.permissions.approve) return;
        if ((actionType === 'decline' || actionType === 'return') && !this.permissions.decline) return;

        this.closeViewLoanModal();

        const payload = await confirmQuickLoanProcess({
            loanId,
            actionType,
            loans: this.loans,
            apiPath: 'assessment/assessment-loan-management.php',
        });
        if (!payload) return;

        try {
            const formData = new FormData();
            formData.append('action', 'process');
            formData.append('loanId', loanId);
            formData.append('processType', actionType);
            formData.append('amountApproved', payload.amountApproved || '');
            formData.append('remarks', payload.remarks);
            await this.appendCsrfToFormData(formData);

            const res = await fetch('../../api/cashier/cashier-loan-management.php', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin',
            });
            const response = await res.json();

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
        if (['approve', 'decline', 'return'].includes(actionType)) {
            return this.quickProcessLoan(loanId, actionType);
        }
        this.closeViewLoanModal();
        
        const loanIdEl = document.getElementById('actionLoanId');
        const actionTypeEl = document.getElementById('actionType');
        const modalEl = document.getElementById('actionLoanModal');
        
        if (!loanIdEl || !actionTypeEl || !modalEl) return;
        
        const modal = new bootstrap.Modal(modalEl);
        const title = document.getElementById('actionLoanModalTitle');
        const form = document.getElementById('actionLoanForm');
        
        // Reset form
        if (form) form.reset();

        loanIdEl.value = loanId;
        actionTypeEl.value = actionType;
        
        // Set title
        if (title) {
            const titleMap = {
                'approve': 'Approve Loan',
                'decline': 'Decline Loan',
                'return': 'Return Loan',
                'endorsed': 'Endorse Loan',
                'endorsed_to_bukas': 'Endorse to Bukas Loan'
            };
            title.textContent = titleMap[actionType] || `${actionType.charAt(0).toUpperCase() + actionType.slice(1)} Loan`;
        }
        
        await setApproveAmountDisplay({
            loanId,
            loans: this.loans,
            apiPath: 'assessment/assessment-loan-management.php',
            show: actionType === 'approve'
        });
        
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
    
    async openEndorsedModal(loanId) {
        // Close loan details modal first
        const viewLoanModalEl = document.getElementById('viewLoanModal');
        if (viewLoanModalEl) {
            const viewLoanModal = bootstrap.Modal.getInstance(viewLoanModalEl);
            if (viewLoanModal) {
                viewLoanModal.hide();
            }
        }
        
        this.openActionModal(loanId, 'endorsed');
    }
    
    async openBukasModal(loanId) {
        const modalEl = document.getElementById('bukasEndorsementModal');
        const loanIdEl = document.getElementById('bukasLoanId');
        const form = document.getElementById('bukasEndorsementForm');
        
        if (!modalEl || !loanIdEl || !form) return;

        form.reset();
        loanIdEl.value = loanId;

        // Fetch loan details to get student name
        try {
            const res = await fetch(`../../api/cashier/cashier-loan-management.php?action=details&loanId=${loanId}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success && response.loan) {
                const studentName = response.loan.student_name || '';
                const personalizedDescription = buildBukasDescription(studentName);
                
                // Update the description field
                const descEl = document.getElementById('bukasDescription');
                if (descEl) {
                    descEl.value = personalizedDescription;
                }
                
                // Update the display in the alert
                const descDisplay = document.getElementById('bukasDescriptionDisplay');
                if (descDisplay) {
                    descDisplay.textContent = personalizedDescription;
                }
            }
        } catch (error) {
            console.error('Error fetching loan details:', error);
            // Continue with default description if fetch fails
        }
        
        // Open modal
        const modal = new bootstrap.Modal(modalEl);
        modal.show();
    }
    
    async submitBukasEndorsement() {
        const form = document.getElementById('bukasEndorsementForm');
        if (!form || !form.checkValidity()) {
            if (form) form.reportValidity();
            return;
        }
        
        const loanId = document.getElementById('bukasLoanId')?.value;
        const reference = document.getElementById('bukasReference')?.value || 'BUKAS-REF';
        const title = document.getElementById('bukasTitle')?.value || 'EXTEND your tuition payment with a Bukas Tuition Plan!';
        const description = document.getElementById('bukasDescription')?.value || buildBukasDescription();
        const learnMoreUrl = document.getElementById('bukasLearnMoreUrl')?.value || 'https://www.bukas.ph';
        const imagePath = document.getElementById('bukasImagePath')?.value || 'uploads/images/June-2023-MK-Enrollment-1-1.jpg';
        const remarks = document.getElementById('bukasRemarks')?.value;
        
        if (!loanId || !remarks) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Please fill in all required fields',
                confirmButtonText: 'OK'
            });
            return;
        }
        
        try {
            const formData = new FormData();
            formData.append('action', 'endorseToBukas');
            formData.append('loanId', loanId);
            formData.append('reference', reference);
            formData.append('title', title);
            formData.append('description', description);
            formData.append('learnMoreUrl', learnMoreUrl);
            formData.append('imagePath', imagePath);
            formData.append('remarks', remarks);
            await this.appendCsrfToFormData(formData);

            const res = await fetch('../../api/cashier/cashier-loan-management.php', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin'
            });

            const response = await res.json();

            if (response.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Loan endorsed to Bukas successfully',
                    confirmButtonText: 'OK'
                });
                
                // Close modal
                const modalEl = document.getElementById('bukasEndorsementModal');
                if (modalEl) {
                    const modal = bootstrap.Modal.getInstance(modalEl);
                    if (modal) {
                        modal.hide();
                    }
                }
                
                // Reload stats and loans
                await this.loadStats();
                await this.loadLoans();
            } else {
                throw new Error(response.message || 'Failed to endorse loan to Bukas');
            }
        } catch (error) {
            console.error('Error endorsing to Bukas:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message || 'Failed to endorse loan to Bukas. Please try again.',
                confirmButtonText: 'OK'
            });
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
        const remarks = document.getElementById('actionRemarks')?.value;
        
        if (!loanId || !actionType || !remarks) {
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
            await this.appendCsrfToFormData(formData);

            const res = await fetch('../../api/cashier/cashier-loan-management.php', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin'
            });

            const response = await res.json();

            if (response.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({
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
    
    openPartialPaymentModal(loanId) {
        if (!this.permissions.markPartial) return;
        // Close loan details modal first
        const viewLoanModalEl = document.getElementById('viewLoanModal');
        if (viewLoanModalEl) {
            const viewLoanModal = bootstrap.Modal.getInstance(viewLoanModalEl);
            if (viewLoanModal) {
                viewLoanModal.hide();
            }
        }
        
        const modalEl = document.getElementById('partialPaymentModal');
        const loanIdEl = document.getElementById('partialPaymentLoanId');
        const form = document.getElementById('partialPaymentForm');
        
        if (!modalEl || !loanIdEl || !form) return;

        form.reset();
        form.classList.remove('was-validated');
        loanIdEl.value = loanId;

        const loan = this.loans.find((item) => Number(item.loan_id || item.loanId) === Number(loanId)) || {};
        const amountCanPay = Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0);
        const amountPaid = Number(loan.recordedPaymentAmount ?? loan.loan_recorded_payment_amount ?? 0);
        const remainingAmount = Math.max(0, amountCanPay - amountPaid);
        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        };
        setText('partialPaymentStudentName', loan.studentName || loan.student_name || '-');
        setText('partialPaymentApplicationNo', loan.applicationNo || loan.loan_application_no || '-');
        setText('partialPaymentAmountCanPay', this.formatPaymentAmount(amountCanPay));
        setText('partialPaymentAlreadyPaid', this.formatPaymentAmount(amountPaid));
        setText('partialPaymentRemaining', this.formatPaymentAmount(remainingAmount));

        const amountInput = document.getElementById('partialPaymentAmount');
        if (amountInput) {
            amountInput.value = '';
            amountInput.max = Math.max(0, remainingAmount - 0.01).toFixed(2);
            amountInput.setCustomValidity('');
        }
        
        // Open modal
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
        
        // Setup submit button handler
        const submitBtn = document.getElementById('submitPartialPaymentBtn');
        if (submitBtn) {
            submitBtn.onclick = () => this.submitPartialPayment();
        }
    }
    
    async submitPartialPayment() {
        const form = document.getElementById('partialPaymentForm');
        if (!form || !form.checkValidity()) {
            if (form) form.reportValidity();
            return;
        }

        const loanId = document.getElementById('partialPaymentLoanId')?.value;
        const amount = document.getElementById('partialPaymentAmount')?.value;
        const loan = this.loans.find((item) => Number(item.loan_id || item.loanId) === Number(loanId)) || {};
        const remainingAmount = Math.max(
            0,
            Number(loan.amountCanPay ?? loan.loan_amount_can_pay ?? 0)
                - Number(loan.recordedPaymentAmount ?? loan.loan_recorded_payment_amount ?? 0)
        );
        const amountValue = Number(amount);
        const validAmount = Number.isFinite(amountValue) && amountValue > 0 && amountValue < remainingAmount;
        const amountInput = document.getElementById('partialPaymentAmount');
        amountInput?.setCustomValidity(validAmount ? '' : 'Partial paid amount must be greater than zero and less than the remaining amount.');
        form.classList.add('was-validated');

        if (!loanId || !validAmount) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid partial paid amount',
                text: 'Enter an amount greater than zero and less than the remaining payment.',
                confirmButtonText: 'OK'
            });
            return;
        }

        const submitBtn = document.getElementById('submitPartialPaymentBtn');
        if (submitBtn) submitBtn.disabled = true;
        try {
            const formData = new FormData();
            formData.append('action', 'payment_tagging_mark_partial');
            formData.append('loanId', loanId);
            formData.append('paymentAmount', amountValue.toFixed(2));
            await this.appendCsrfToFormData(formData);
            const response = await ApiService.postFormData('/cashier/cashier-loan-management.php?action=payment_tagging_mark_partial', formData);
            
            if (response.success) {
                Swal.fire({
                    icon: 'success',
                    title: 'Marked as Paid Partial',
                    text: response.message,
                    confirmButtonText: 'OK'
                });
                
                const modalEl = document.getElementById('partialPaymentModal');
                if (modalEl) {
                    const modalInstance = bootstrap.Modal.getInstance(modalEl);
                    if (modalInstance) modalInstance.hide();
                }
                
                await this.loadStats();
                await this.loadLoans();
            } else {
                throw new Error(response.message || 'Failed to mark the partial payment');
            }
        } catch (error) {
            console.error('Error recording a partial paid amount:', error);
            Swal.fire({
                icon: 'error',
                title: 'Unable to mark partial payment',
                text: error.message || 'Failed to mark the partial payment. Please try again.',
                confirmButtonText: 'OK'
            });
        } finally {
            if (submitBtn) submitBtn.disabled = false;
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

    /**
     * Row actions use <details> + menu inside .table-responsive; overflow clips the menu.
     * When open, pin the menu with position:fixed (same pattern as CSDL / Assessment).
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
}

export default FinanceLoansManagementModule;
