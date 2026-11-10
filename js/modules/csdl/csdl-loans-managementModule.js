import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { setApproveAmountDisplay } from '../../shared/shared-loan-action-amount.js';
import {
    confirmQuickLoanProcess,
    showLoanProcessError,
    showLoanProcessSuccess,
} from '../../shared/shared-loan-quick-actions.js';
import { INLINE_ACTION_IGNORE } from '../../shared/shared-inline-actions.js';
import {
    CSDL_LOAN_MGMT_TABLE_COLSPAN,
    buildLoanMgmtTableRowHtml,
    fmtLoanMgmtDate,
    fmtLoanMgmtPeso,
    getLoanMgmtCountdownElementId,
    getLoanMgmtExpiryTimestamp,
    mapLoanMgmtExportRow,
    startLoanMgmtModalCountdowns,
} from '../../shared/shared-loan-management-table.js?v=20261018-overdue-countdown';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js?v=20260913-paid-partial-status';
import StaffLoanChatController from '../../shared/shared-staff-loan-chat.js?v=20260927-chat-deeplinks';

class CsdlLoansManagementModule {
    constructor() {
        this.currentPage = 1;
        this.perPage = 10;
        this.activeTab = 'active';
        this.selectedLoanIds = new Set();
        this.filters = {
            semester: '',
            schoolYear: '',
            period: '',
            campus: '',
            search: ''
        };
        this.loans = [];
        this.total = 0;
        this.totalPages = 0;
        this.permissions = {
            view: false,
            approve: false,
            endorse: false,
            decline: false,
            return: false,
            chat: false,
            archive: false
        };
        this.loanChat = new StaffLoanChatController({
            hasPermission: () => this.permissions.chat,
            getLoans: () => this.loans,
        });
    }
    
    async init() {
        await this.loadPermissions();
        await this.loadFilters();
        await this.loadStats();
        this.updateTabPresentation();
        await this.loadLoans();
        this.setupEventListeners();
        this.loanChat.bind();
        this.bindStatCards();
        this.applyActionVisibility();
        this.bindOutsideActionMenuClose();
        this.bindActionMenuPositionFix();
        this.setupMobileFilterClose();
    }

    async loadPermissions() {
        try {
            const response = await ApiService.get('/masterfiles/masterfiles-permissions.php', { action: 'get_my_permissions' });
            if (!response?.success || !Array.isArray(response.permissions)) return;
            const can = (key) => {
                const perm = response.permissions.find((p) => p.permission_key === key);
                return !!(perm && Number(perm.is_granted) === 1);
            };
            this.permissions = {
                view: can('csdl.loans.view'),
                approve: can('csdl.loans.approve'),
                endorse: can('csdl.loans.endorse') || can('csdl.loans.approve'),
                decline: can('csdl.loans.decline'),
                return: can('csdl.loans.return'),
                chat: can('csdl.loans.chat'),
                archive: can('csdl.loans.approve')
            };
        } catch (error) {
            console.error('Error loading CSDL loan permissions:', error);
        }
    }

    applyActionVisibility() {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.style.display = this.permissions.view ? '' : 'none';
        this.updateBulkArchiveButton();
    }
    
    async loadFilters() {
        if (!this.permissions.view) return;
        try {
            const response = await ApiService.get('/csdl/csdl-loans-management.php', { action: 'filters' });
            if (response.success) {
                // Populate semester filter
                const semesterSelect = document.getElementById('filterSemester');
                if (semesterSelect) {
                    // Clear existing options except the default "All Semesters"
                    const defaultOption = semesterSelect.querySelector('option[value=""]');
                    semesterSelect.innerHTML = '';
                    if (defaultOption) {
                        semesterSelect.appendChild(defaultOption);
                    } else {
                        // Add default option if it doesn't exist
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'All Semesters';
                        semesterSelect.appendChild(allOption);
                    }
                    
                    // Add semester options
                    response.semesters.forEach(semester => {
                        const option = document.createElement('option');
                        option.value = semester.semester_id;
                        option.textContent = semester.semester_name;
                        semesterSelect.appendChild(option);
                    });
                }
                
                // Populate school year filter
                const schoolYearSelect = document.getElementById('filterSchoolYear');
                if (schoolYearSelect) {
                    // Clear existing options except the default "All School Years"
                    const defaultOption = schoolYearSelect.querySelector('option[value=""]');
                    schoolYearSelect.innerHTML = '';
                    if (defaultOption) {
                        schoolYearSelect.appendChild(defaultOption);
                    } else {
                        // Add default option if it doesn't exist
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'All School Years';
                        schoolYearSelect.appendChild(allOption);
                    }
                    
                    // Add school year options
                    response.schoolYears.forEach(sy => {
                        const option = document.createElement('option');
                        option.value = sy.sy_id;
                        option.textContent = sy.sy_code;
                        schoolYearSelect.appendChild(option);
                    });
                }
                
                // Populate period filter
                const periodSelect = document.getElementById('filterPeriod');
                if (periodSelect) {
                    // Clear existing options except the default "All Periods"
                    const defaultOption = periodSelect.querySelector('option[value=""]');
                    periodSelect.innerHTML = '';
                    if (defaultOption) {
                        periodSelect.appendChild(defaultOption);
                    } else {
                        // Add default option if it doesn't exist
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'All Periods';
                        periodSelect.appendChild(allOption);
                    }
                    
                    // Add period options
                    response.periods.forEach(period => {
                        const option = document.createElement('option');
                        option.value = period.app_period_id;
                        option.textContent = period.app_period_name;
                        periodSelect.appendChild(option);
                    });
                }

                const campusSelect = document.getElementById('filterCampus');
                if (campusSelect) {
                    campusSelect.innerHTML = '<option value="">All Campuses</option>';
                    (response.campuses || []).forEach((campus) => {
                        const option = document.createElement('option');
                        option.value = campus.campus_id;
                        option.textContent = campus.campus_name;
                        campusSelect.appendChild(option);
                    });
                }
                
                // Populate mobile filter dropdowns (same data)
                // Mobile Semester
                const semesterSelectMobile = document.getElementById('filterSemesterMobile');
                if (semesterSelectMobile) {
                    semesterSelectMobile.innerHTML = '<option value="">All Semesters</option>';
                    response.semesters.forEach(semester => {
                        const option = document.createElement('option');
                        option.value = semester.semester_id;
                        option.textContent = semester.semester_name;
                        semesterSelectMobile.appendChild(option);
                    });
                }
                
                // Mobile School Year
                const schoolYearSelectMobile = document.getElementById('filterSchoolYearMobile');
                if (schoolYearSelectMobile) {
                    schoolYearSelectMobile.innerHTML = '<option value="">All School Years</option>';
                    response.schoolYears.forEach(sy => {
                        const option = document.createElement('option');
                        option.value = sy.sy_id;
                        option.textContent = sy.sy_code;
                        schoolYearSelectMobile.appendChild(option);
                    });
                }
                
                // Mobile Period
                const periodSelectMobile = document.getElementById('filterPeriodMobile');
                if (periodSelectMobile) {
                    periodSelectMobile.innerHTML = '<option value="">All Periods</option>';
                    response.periods.forEach(period => {
                        const option = document.createElement('option');
                        option.value = period.app_period_id;
                        option.textContent = period.app_period_name;
                        periodSelectMobile.appendChild(option);
                    });
                }

                const campusSelectMobile = document.getElementById('filterCampusMobile');
                if (campusSelectMobile) {
                    campusSelectMobile.innerHTML = '<option value="">All Campuses</option>';
                    (response.campuses || []).forEach((campus) => {
                        const option = document.createElement('option');
                        option.value = campus.campus_id;
                        option.textContent = campus.campus_name;
                        campusSelectMobile.appendChild(option);
                    });
                }
            }
        } catch (error) {
            console.error('Error loading filters:', error);
        }
    }
    
    async loadStats() {
        if (!this.permissions.view) return;
        try {
            const response = await ApiService.get('/csdl/csdl-loans-management.php', { action: 'stats' });
            if (response.success) {
                const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
                set('statPending', response.stats.pending);
                set('statOverdue', response.stats.overdue);
                set('statNewToday', response.stats.newToday);
                set('statNewThisWeek', response.stats.newThisWeek);
                set('activeLoansTabCount', response.stats.pending);
                set('allApplicationsTabCount', response.stats.allApplications);
                set('archivedApplicationsTabCount', response.stats.archivedApplications);
                this.updateMobileTabControl();
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }
    
    async loadLoans() {
        if (!this.permissions.view) {
            const tbody = document.querySelector('#loansTable tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="${CSDL_LOAN_MGMT_TABLE_COLSPAN}" class="text-center text-muted">You do not have permission to view loans</td></tr>`;
            return;
        }
        try {
            const params = {
                action: 'list',
                page: this.currentPage,
                perPage: this.perPage,
                scope: this.activeTab,
                ...this.filters
            };
            
            const response = await ApiService.get('/csdl/csdl-loans-management.php', params);
            
            if (response.success) {
                this.loans = response.data || [];
                this.total = response.total || 0;
                this.totalPages = response.totalPages || 0;
                if (this.currentPage > Math.max(1, this.totalPages)) {
                    this.currentPage = Math.max(1, this.totalPages);
                    return this.loadLoans();
                }
                this.selectedLoanIds.clear();
                
                this.renderTable();
                this.updatePagination();
                this.updateBulkArchiveButton();
            }
        } catch (error) {
            console.error('Error loading loans:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
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
        this.renderTableHeader();
        tbody.innerHTML = '';

        if (this.loans.length === 0) {
            const colspan = this.activeTab === 'archived' ? 14 : this.activeTab === 'all' ? 13 : CSDL_LOAN_MGMT_TABLE_COLSPAN;
            tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-muted py-4">No loan applications found</td></tr>`;
            return;
        }

        this.loans.forEach(loan => {
            const row = document.createElement('tr');
            row.classList.add('csdl-loan-row-clickable');
            row.setAttribute('data-loan-id', loan.loan_id);
            const displayStatusName = this.getDisplayStatusName(loan);
            const statusHtml = `<span class="badge ${this.getStatusBadgeClass(loan.loan_status_id)}">${escapeHtml(displayStatusName)}</span>`;
            const paymentStatusHtml = `<span class="badge ${this.getPaymentStatusBadgeClass(loan.payment_status)}">${escapeHtml(this.getPaymentStatusName(loan))}</span>`;
            const pnStatusHtml = `<span class="badge ${this.getPnStatusBadgeClass(loan.pn_status)}">${escapeHtml(this.getPnStatusName(loan))}</span>`;
            const actionsHtml = this.activeTab === 'active' ? this.renderLoanProcessActions(loan) : '';

            row.innerHTML = this.activeTab !== 'active'
                ? this.renderAllApplicationsRow(loan, statusHtml, paymentStatusHtml, pnStatusHtml)
                : buildLoanMgmtTableRowHtml({
                    loan,
                    escapeHtml,
                    statusHtml,
                    paymentStatusHtml,
                    pnStatusHtml,
                    actionsHtml,
                    formatCountdown: (ts) => this.formatCountdown(ts),
                    columnPreset: 'csdl',
                });

            row.addEventListener('click', (e) => {
                if (!e.target.closest(`${INLINE_ACTION_IGNORE}, button, input, label`)) {
                    this.viewLoan(loan.loan_id);
                }
            });

            tbody.appendChild(row);

            const expiry = this.activeTab === 'active' ? getLoanMgmtExpiryTimestamp(loan) : null;
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

                this.openApprovalModal(loanId);
            });
        });

        tbody.querySelectorAll('.action-endorse').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (loanId) this.openActionModal(loanId, 'endorse');
            });
        });

        tbody.querySelectorAll('.action-return').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const loanId = parseInt(btn.getAttribute('data-loan-id'), 10);
                if (loanId) this.openActionModal(loanId, 'return');
            });
        });

        tbody.querySelectorAll('.action-loan-chat').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.loanChat.open(Number(btn.dataset.loanId));
            });
        });

        tbody.querySelectorAll('.loan-archive-checkbox').forEach((input) => {
            input.addEventListener('click', (event) => event.stopPropagation());
            input.addEventListener('change', () => {
                const id = Number(input.dataset.loanId);
                if (input.checked) this.selectedLoanIds.add(id);
                else this.selectedLoanIds.delete(id);
                this.updateBulkArchiveButton();
            });
        });
        tbody.querySelectorAll('.action-archive-loan, .action-restore-loan').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.changeArchiveState([Number(button.dataset.loanId)], this.activeTab === 'archived' ? 'restore' : 'archive');
            });
        });
        const selectAll = document.getElementById('selectVisibleLoans');
        if (selectAll) selectAll.addEventListener('change', () => {
            tbody.querySelectorAll('.loan-archive-checkbox:not(:disabled)').forEach((input) => {
                input.checked = selectAll.checked;
                const id = Number(input.dataset.loanId);
                if (selectAll.checked) this.selectedLoanIds.add(id);
                else this.selectedLoanIds.delete(id);
            });
            this.updateBulkArchiveButton();
        });

    }

    renderTableHeader() {
        const thead = document.getElementById('loansTableHead');
        if (!thead) return;

        if (this.activeTab !== 'active') {
            thead.innerHTML = `<tr>
                <th class="text-center"><input type="checkbox" class="form-check-input" id="selectVisibleLoans" aria-label="Select all eligible applications on this page" ${this.permissions.archive ? '' : 'disabled'}></th>
                <th class="text-center">Application No.</th>
                <th class="text-center">Student ID</th>
                <th class="text-center">Student Name</th>
                <th class="text-center">Campus</th>
                <th class="text-center">Amount Can Pay</th>
                <th class="text-center">Amount Paid</th>
                <th class="text-center">Current Office</th>
                <th class="text-center">Loan Status</th>
                <th class="text-center">Payment Status</th>
                <th class="text-center">PN Status</th>
                <th class="text-center">Date Applied</th>
                ${this.activeTab === 'archived' ? '<th class="text-center">Archived On</th>' : ''}
                <th class="text-center">Actions</th>
            </tr>`;
            return;
        }

        thead.innerHTML = `<tr>
            <th class="text-center">Application No.</th>
            <th class="text-center">Student Name</th>
            <th class="text-center">Total Balance</th>
            <th class="text-center">Advised to Pay</th>
            <th class="text-center">Amount Can Pay</th>
            <th class="text-center">Amount Paid</th>
            <th class="text-center">Due Date</th>
            <th class="text-center">Status</th>
            <th class="text-center">Payment Status</th>
            <th class="text-center">PN Status</th>
            <th class="text-center">Timestamp</th>
            <th class="text-center">Actions</th>
        </tr>`;
    }

    renderAllApplicationsRow(loan, statusHtml, paymentStatusHtml, pnStatusHtml) {
        const office = this.getCurrentOffice(loan);
        const archived = this.activeTab === 'archived';
        const eligible = archived || this.canArchiveLoan(loan);
        const action = this.permissions.archive && eligible
            ? `<button type="button" class="inline-action-btn inline-action-btn--${archived ? 'return' : 'edit'} action-${archived ? 'restore' : 'archive'}-loan" data-loan-id="${Number(loan.loan_id)}" title="${archived ? 'Restore' : 'Archive'} application" aria-label="${archived ? 'Restore' : 'Archive'} application"><i class="bi bi-${archived ? 'arrow-counterclockwise' : 'archive'}"></i></button>`
            : `<span class="badge text-nowrap ${this.permissions.archive ? 'bg-warning text-dark' : 'bg-secondary'}" title="${this.permissions.archive ? 'Only completed and fully paid or cancelled applications can be archived' : 'You do not have permission to archive applications'}">${this.permissions.archive ? 'Not ready' : 'No action'}</span>`;
        return `
            <td class="text-center" data-label="Select"><input type="checkbox" class="form-check-input loan-archive-checkbox" data-loan-id="${Number(loan.loan_id)}" aria-label="Select application ${escapeHtml(String(loan.loan_application_no || loan.loan_id))}" ${!this.permissions.archive || !eligible ? 'disabled' : ''}></td>
            <td class="text-center" data-label="Application No."><span class="fw-semibold text-nowrap">${escapeHtml(String(loan.loan_application_no || '-'))}</span></td>
            <td class="text-center text-nowrap" data-label="Student ID">${escapeHtml(String(loan.student_school_id || '-'))}</td>
            <td class="text-center" data-label="Student Name"><span class="fw-semibold">${escapeHtml(String(loan.student_name || '-'))}</span></td>
            <td class="text-center" data-label="Campus">${escapeHtml(String(loan.campus_name || 'Unassigned'))}</td>
            <td class="text-center" data-label="Amount Can Pay">${fmtLoanMgmtPeso(loan.loan_amount_can_pay)}</td>
            <td class="text-center" data-label="Amount Paid">${fmtLoanMgmtPeso(loan.loan_recorded_payment_amount)}</td>
            <td class="text-center" data-label="Current Office"><span class="csdl-office-badge">${escapeHtml(office)}</span></td>
            <td class="text-center" data-label="Loan Status">${statusHtml}</td>
            <td class="text-center" data-label="Payment Status">${paymentStatusHtml}</td>
            <td class="text-center" data-label="PN Status">${pnStatusHtml}</td>
            <td class="text-center text-nowrap" data-label="Date Applied">${fmtLoanMgmtDate(loan.loan_application_date)}</td>
            ${archived ? `<td class="text-center text-nowrap" data-label="Archived On">${fmtLoanMgmtDate(loan.loan_archived_at)}</td>` : ''}
            <td class="text-center" data-label="Actions">${action}</td>
        `;
    }

    canArchiveLoan(loan) {
        if (Number(loan.loan_status_id) === 9) {
            return Number(loan.loan_payment_status_id) === 1 && Number(loan.loan_recorded_payment_amount || 0) <= 0;
        }
        return Number(loan.loan_status_id) === 5
            && Number(loan.loan_payment_status_id) === 3
            && Number(loan.loan_amount_can_pay) > 0
            && Number(loan.loan_recorded_payment_amount) >= Number(loan.loan_amount_can_pay);
    }

    updateBulkArchiveButton() {
        const button = document.getElementById('bulkArchiveBtn');
        const label = document.getElementById('bulkArchiveLabel');
        if (!button || !label) return;
        const visible = this.permissions.archive && this.activeTab !== 'active';
        button.classList.toggle('d-none', !visible);
        button.disabled = this.selectedLoanIds.size === 0;
        label.textContent = `${this.activeTab === 'archived' ? 'Restore' : 'Archive'} selected (${this.selectedLoanIds.size})`;
    }

    async changeArchiveState(ids, action) {
        if (!this.permissions.archive || !ids.length || !['archive', 'restore'].includes(action)) return;
        const label = action === 'archive' ? 'Archive' : 'Restore';
        const confirmation = await Swal.fire({
            icon: 'question', title: `${label} ${ids.length} application${ids.length === 1 ? '' : 's'}?`,
            text: action === 'archive' ? 'The applications will move out of All Applications. Their loan history will be kept.' : 'The applications will return to All Applications.',
            showCancelButton: true, confirmButtonText: label, confirmButtonColor: '#03600f'
        });
        if (!confirmation.isConfirmed) return;
        try {
            const result = await ApiService.post('/csdl/csdl-loans-management.php', { action, loanIds: ids });
            if (!result?.success) throw new Error(result?.message || 'Unable to update applications');
            await Promise.all([this.loadStats(), this.loadLoans()]);
            await Swal.fire({ icon: 'success', title: `${label} complete`, text: result.message, confirmButtonColor: '#03600f' });
        } catch (error) {
            await Swal.fire({ icon: 'error', title: `${label} failed`, text: error?.response?.data?.message || error?.message || 'Please try again.', confirmButtonColor: '#03600f' });
        }
    }

    getCurrentOffice(loan) {
        const offices = {
            1: 'CSDL',
            2: 'Cashier',
            3: 'Branch Admin',
            4: 'COO',
            5: 'Completed',
            8: 'Student',
            10: 'Cancelled',
            11: 'Assessment'
        };
        const stepId = Number(loan?.loan_current_step_id);
        return offices[stepId] || String(loan?.current_step_name || 'Completed');
    }

    getStatusBadgeClass(statusId) {
        const classes = {
            1: 'bg-warning text-dark', // Pending
            2: 'bg-success', // Approved
            5: 'bg-success', // Completed
            6: 'bg-warning text-dark', // Returned
            9: 'bg-secondary', // Cancelled
            11: 'bg-warning text-dark', // Partial Payment
            12: 'bg-success', // Endorsed
        };
        return classes[statusId] || 'bg-secondary';
    }

    getDisplayStatusName(loan) {
        const statusId = parseInt(loan?.loan_status_id, 10);
        const statusName = String(loan?.loan_status_name || '-');
        return statusName;
    }

    getPaymentStatusName(loan) {
        return String(loan?.payment_status || loan?.payment_status_name || 'Not Paid');
    }

    getPaymentStatusBadgeClass(statusName) {
        const status = String(statusName || '').toLowerCase();
        if (status === 'paid') return 'bg-success';
        if (status === 'paid pending') return 'bg-warning text-dark';
        if (status === 'paid partial') return 'bg-warning text-dark';
        if (status === 'partial payment') return 'bg-warning text-dark';
        return 'bg-secondary';
    }

    getPnStatusName(loan) {
        return String(loan?.pn_status || loan?.pn_status_name || 'Not Tagged');
    }

    getPnStatusBadgeClass(statusName) {
        return String(statusName || '').toLowerCase() === 'tagged' ? 'bg-success' : 'bg-secondary';
    }
    
    formatCountdown(expiryTimestamp) {
        if (!expiryTimestamp) return '-';
        
        const expiry = new Date(expiryTimestamp);
        const now = new Date();
        const diff = expiry - now;
        if (Number.isNaN(diff)) return '-';
        
        // Calculate absolute values for display
        const absDiff = Math.abs(diff);
        const days = Math.floor(absDiff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((absDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((absDiff % (1000 * 60)) / 1000);
        
        // If overdue (negative), show with minus sign and red badge
        if (diff <= 0) {
            if (days > 0) {
                return `<span class="badge bg-danger">Overdue -${days}d ${hours}h ${minutes}m ${seconds}s</span>`;
            } else if (hours > 0) {
                return `<span class="badge bg-danger">Overdue -${hours}h ${minutes}m ${seconds}s</span>`;
            } else if (minutes > 0) {
                return `<span class="badge bg-danger">Overdue -${minutes}m ${seconds}s</span>`;
            } else {
                return `<span class="badge bg-danger">Overdue -${seconds}s</span>`;
            }
        }
        
        // If time remaining (positive), show normal countdown
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
    
    canProcess(loan) {
        // Only allow processing if status is Pending (1)
        return Number(loan.loan_status_id) === 1;
    }

    requiresAssessmentEndorsement(loan) {
        const totalBalance = Number(loan?.balance_total_balance ?? loan?.totalBalance ?? 0);
        const amountCanPay = Number(loan?.loan_amount_can_pay ?? loan?.amountCanPay ?? 0);
        return Math.max(0, totalBalance - amountCanPay) > 3000;
    }

    renderLoanProcessActions(loan) {
        const canProcess = this.canProcess(loan);
        if (!canProcess && !this.permissions.chat) {
            return '<span class="text-muted">—</span>';
        }

        const loanId = Number(loan.loan_id);
        const buttons = [];

        const requiresEndorsement = this.requiresAssessmentEndorsement(loan);
        if (canProcess && requiresEndorsement && this.permissions.endorse) {
            buttons.push(`<button type="button" class="inline-action-btn inline-action-btn--edit action-endorse" title="Endorse to Assessment" aria-label="Endorse to Assessment" data-loan-id="${loanId}"><i class="bi bi-send"></i></button>`);
        }
        if (canProcess && !requiresEndorsement && this.permissions.approve) {
            buttons.push(`<button type="button" class="inline-action-btn inline-action-btn--approve action-approve" title="Approve" aria-label="Approve" data-loan-id="${loanId}"><i class="bi bi-check-lg"></i></button>`);
        }
        if (canProcess && this.permissions.return) {
            buttons.push(`<button type="button" class="inline-action-btn inline-action-btn--return action-return" title="Return" aria-label="Return" data-loan-id="${loanId}"><i class="bi bi-arrow-return-left"></i></button>`);
        }
        if (this.permissions.chat) {
            buttons.push(`<button type="button" class="inline-action-btn inline-action-btn--info action-loan-chat" title="Chat with student" aria-label="Chat with student" data-loan-id="${loanId}"><i class="bi bi-chat-dots"></i></button>`);
        }

        if (buttons.length === 0) {
            return '<span class="text-muted">—</span>';
        }
        return `<span class="d-inline-flex justify-content-center w-100 loan-actions-cell"><div class="inline-row-actions" role="group" aria-label="Loan actions">${buttons.join('')}</div></span>`;
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

    setupEventListeners() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };

        document.querySelectorAll('[data-loan-tab]').forEach((tab) => {
            tab.addEventListener('click', () => {
                const nextTab = ['active', 'all', 'archived'].includes(tab.dataset.loanTab) ? tab.dataset.loanTab : 'active';
                if (nextTab === this.activeTab) return;
                this.activeTab = nextTab;
                this.selectedLoanIds.clear();
                this.currentPage = 1;
                this.updateTabPresentation();
                this.updateBulkArchiveButton();
                this.loadLoans();
            });
        });
        
        // Filter changes
        on('#filterSemester', 'change', (e) => {
            this.filters.semester = e.target.value;
            this.currentPage = 1;
            this.loadLoans();
        });
        
        on('#filterSchoolYear', 'change', (e) => {
            this.filters.schoolYear = e.target.value;
            this.currentPage = 1;
            this.loadLoans();
        });
        
        on('#filterPeriod', 'change', (e) => {
            this.filters.period = e.target.value;
            this.currentPage = 1;
            this.loadLoans();
        });

        on('#filterCampus', 'change', (e) => {
            this.filters.campus = e.target.value;
            this.currentPage = 1;
            this.loadLoans();
        });
        
        // Mobile filter apply button
        on('#applyMobileFiltersBtn', 'click', () => {
            const semesterMobile = document.getElementById('filterSemesterMobile');
            const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
            const periodMobile = document.getElementById('filterPeriodMobile');
            const campusMobile = document.getElementById('filterCampusMobile');
            
            if (semesterMobile) {
                this.filters.semester = semesterMobile.value;
                // Sync with desktop filter
                const desktopSemester = document.getElementById('filterSemester');
                if (desktopSemester) desktopSemester.value = semesterMobile.value;
            }
            if (schoolYearMobile) {
                this.filters.schoolYear = schoolYearMobile.value;
                // Sync with desktop filter
                const desktopSchoolYear = document.getElementById('filterSchoolYear');
                if (desktopSchoolYear) desktopSchoolYear.value = schoolYearMobile.value;
            }
            if (periodMobile) {
                this.filters.period = periodMobile.value;
                // Sync with desktop filter
                const desktopPeriod = document.getElementById('filterPeriod');
                if (desktopPeriod) desktopPeriod.value = periodMobile.value;
            }
            if (campusMobile) {
                this.filters.campus = campusMobile.value;
                const desktopCampus = document.getElementById('filterCampus');
                if (desktopCampus) desktopCampus.value = campusMobile.value;
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
        
        // Search - Real-time with debounce (desktop and mobile)
        let searchTimeout;
        const handleSearch = (searchValue) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.filters.search = searchValue.trim();
                this.currentPage = 1;
                this.loadLoans();
            }, 300);
        };
        
        on('#searchLoans', 'input', (e) => {
            const searchValue = e.target.value;
            handleSearch(searchValue);
            // Sync with mobile search
            const mobileSearch = document.getElementById('searchLoansMobile');
            if (mobileSearch) mobileSearch.value = searchValue;
        });
        
        on('#searchLoansMobile', 'input', (e) => {
            const searchValue = e.target.value;
            handleSearch(searchValue);
            // Sync with desktop search
            const desktopSearch = document.getElementById('searchLoans');
            if (desktopSearch) desktopSearch.value = searchValue;
        });
        
        // Per page
        on('#perPageSelect', 'change', (e) => {
            this.perPage = parseInt(e.target.value);
            this.currentPage = 1;
            this.loadLoans();
        });
        
        // Pagination is now handled by page number buttons in updatePagination()
        
        // Refresh
        on('#refreshBtn', 'click', async () => {
            // Reset to first page and clear filters FIRST
            this.currentPage = 1;
            
            // Reset filter dropdowns and filter values
            const semesterSelect = document.getElementById('filterSemester');
            const schoolYearSelect = document.getElementById('filterSchoolYear');
            const periodSelect = document.getElementById('filterPeriod');
            const campusSelect = document.getElementById('filterCampus');
            const searchInput = document.getElementById('searchLoans');
            
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
            if (campusSelect) {
                campusSelect.value = '';
                this.filters.campus = '';
            }
            if (searchInput) {
                searchInput.value = '';
                this.filters.search = '';
            }
            
            // Reload filters, stats, and loans (with cleared filters)
            await Promise.all([
                this.loadFilters(),
                this.loadStats(),
                this.loadLoans()
            ]);
        });
        
        // Export
        on('#exportBtn', 'click', () => {
            this.exportLoans();
        });
        on('#bulkArchiveBtn', 'click', () => {
            this.changeArchiveState(Array.from(this.selectedLoanIds), this.activeTab === 'archived' ? 'restore' : 'archive');
        });
        
        // Stat card clicks are now handled by bindStatCards()

        // Action form submit
        on('#submitActionBtn', 'click', () => {
            this.submitAction();
        });
        
        // Approval confirmation
        on('#confirmApprovalBtn', 'click', () => {
            this.submitApproval();
        });
        
    }

    updateMobileTabControl() {
        const views = {
            active: { label: 'Active Loans', icon: 'bi-inbox', countId: 'activeLoansTabCount' },
            all: { label: 'All Applications', icon: 'bi-diagram-3', countId: 'allApplicationsTabCount' },
            archived: { label: 'Archived', icon: 'bi-archive', countId: 'archivedApplicationsTabCount' }
        };
        document.querySelectorAll('[data-mobile-loan-tab-count]').forEach((count) => {
            const view = views[count.dataset.mobileLoanTabCount];
            count.textContent = document.getElementById(view.countId)?.textContent || '0';
        });
        const selected = views[this.activeTab];
        const label = document.getElementById('mobileLoanTabLabel');
        const icon = document.getElementById('mobileLoanTabIcon');
        const count = document.getElementById('mobileLoanTabCount');
        if (label) label.textContent = selected.label;
        if (icon) icon.className = `bi ${selected.icon}`;
        if (count) count.textContent = document.getElementById(selected.countId)?.textContent || '0';
    }

    updateTabPresentation() {
        document.body.classList.toggle('csdl-all-applications-view', this.activeTab !== 'active');
        document.querySelectorAll('[data-loan-tab]').forEach((tab) => {
            const selected = tab.dataset.loanTab === this.activeTab;
            tab.classList.toggle('active', selected);
            tab.setAttribute(tab.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-checked', selected ? 'true' : 'false');
        });
        this.updateMobileTabControl();

        const title = document.getElementById('loanListTitle');
        if (title) title.textContent = this.activeTab === 'all' ? 'All Loan Applications' : this.activeTab === 'archived' ? 'Archived Applications' : 'Pending Applications';
    }
    
    filterByView(view) {
        // Note: Status filtering removed - Active Loans only shows Pending
        // This method is kept for compatibility but doesn't filter by status anymore
        // Stat cards can still be clicked to show modal with loans of that status
    }
    
    // ===== Stat cards modal binding =====
    bindStatCards() {
        const cards = document.querySelectorAll('.stat-card[data-view]');
        if (!cards.length) return;
        // eslint-disable-next-line no-undef
        this.loansListModal = new bootstrap.Modal(document.getElementById('loansListModal'));
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                this.populateLoansListModal(view);
            });
        });
    }
    
    async populateLoansListModal(view) {
        const titleEl = document.getElementById('loansModalTitle');
        const tbody = document.getElementById('loansModalTableBody');
        const head1 = document.getElementById('loanHeadCol1');
        const head2 = document.getElementById('loanHeadCol2');
        const head3 = document.getElementById('loanHeadCol3');
        const head4 = document.getElementById('loanHeadCol4');
        const head5 = document.getElementById('loanHeadCol5');
        const head6 = document.getElementById('loanHeadCol6');
        const head7 = document.getElementById('loanHeadCol7');
        const recordCountEl = document.getElementById('loansListModalRecordCount');
        if (!titleEl || !tbody || !head1 || !head2 || !head3 || !head4 || !head5 || !head6) return;
        
        let title = 'Loans';
        let params = {
            action: 'list',
            page: 1,
            perPage: 10000, // Large number to get all
            status: '1' // Always pending for this page
        };
        
        let isOverdueView = false;
        
        // Set title and add specific filters based on view
        if (view === 'pending') {
            title = 'Pending applications';
        } else if (view === 'overdue') {
            title = 'Overdue follow-up';
            params.overdue = '1';
            isOverdueView = true;
        } else if (view === 'newToday') {
            title = 'New today';
            params.newToday = '1';
        } else if (view === 'newThisWeek') {
            title = 'New this week';
            params.newThisWeek = '1';
        } else {
            return; // Unknown view
        }
        
        titleEl.textContent = title;
        if (recordCountEl) recordCountEl.textContent = 'Loading records…';
        
        // Show/hide timestamp column based on view
        if (head7) {
            head7.style.display = isOverdueView ? '' : 'none';
            head7.textContent = isOverdueView ? 'Time Overdue' : 'Time Remaining';
        }
        
        try {
            // Fetch all loans matching the filter (API handles filtering server-side)
            const response = await ApiService.get('/csdl/csdl-loans-management.php', params);
            
            const loans = response.success ? (response.data || []) : [];
            this.stopOverdueCountdowns?.();
            this.stopOverdueCountdowns = null;
            
            const colspan = isOverdueView ? '7' : '6';
            
            if (!loans || loans.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-muted">No loans found</td></tr>`;
            } else {
                tbody.innerHTML = loans.map(loan => {
                    const statusBadge = `<span class="badge ${this.getStatusBadgeClass(loan.loan_status_id)}">${escapeHtml(this.getDisplayStatusName(loan))}</span>`;
                    const timestampCell = isOverdueView ? '<td class="text-center" data-loan-countdown></td>' : '';
                    return `
                        <tr style="cursor: pointer;" onclick="window.loansManagementModule.viewLoan(${loan.loan_id})">
                            <td class="text-center">${escapeHtml(loan.loan_application_no || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.student_school_id || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.student_name || '-')}</td>
                            <td class="text-center">₱${parseFloat(loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="text-center">${statusBadge}</td>
                            <td class="text-center">${escapeHtml(loan.loan_application_date || '-')}</td>
                            ${timestampCell}
                        </tr>
                    `;
                }).join('');
                if (isOverdueView) {
                    this.stopOverdueCountdowns = startLoanMgmtModalCountdowns(
                        document.getElementById('loansListModal'), tbody,
                        loans.map(loan => getLoanMgmtExpiryTimestamp(loan)),
                        timestamp => this.formatCountdown(timestamp)
                    );
                }
            }

            if (recordCountEl) {
                recordCountEl.textContent = loans.length === 0
                    ? 'No records'
                    : loans.length === 1
                        ? 'Showing 1 record'
                        : `Showing all ${loans.length} records`;
            }
            
            this.loansListModal && this.loansListModal.show();
        } catch (error) {
            console.error('Error loading loans for modal:', error);
            tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-danger">Error loading loans</td></tr>`;
            if (recordCountEl) recordCountEl.textContent = 'Unable to load records';
        }
    }
    
    async viewLoan(loanId) {
        if (!this.permissions.view) return;
        try {
            const response = await ApiService.get('/csdl/csdl-loans-management.php', { action: 'details', loanId });
            
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
                }
                
                const showDetailsModal = () => modal.show();
                const listModalEl = document.getElementById('loansListModal');
                if (listModalEl?.classList.contains('show')) {
                    listModalEl.addEventListener('hidden.bs.modal', showDetailsModal, { once: true });
                    this.loansListModal?.hide();
                } else {
                    showDetailsModal();
                }
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
        const canProcess = this.canProcess(loan);
        if (!canProcess && !this.permissions.chat) {
            return '';
        }

        const buttons = [];
        const requiresEndorsement = this.requiresAssessmentEndorsement(loan);
        if (canProcess && requiresEndorsement && this.permissions.endorse) {
            buttons.push(`<button type="button" class="btn btn-sm btn-primary" onclick="window.loansManagementModule.openActionModal(${loan.loan_id}, 'endorse')"><i class="bi bi-send me-1"></i>Endorse to Assessment</button>`);
        }
        if (canProcess && !requiresEndorsement && this.permissions.approve) {
            buttons.push(`<button type="button" class="btn btn-sm btn-success" onclick="window.loansManagementModule.openApprovalModal(${loan.loan_id})">Approve</button>`);
        }
        if (canProcess && this.permissions.return) {
            buttons.push(`<button type="button" class="btn btn-sm btn-outline-warning" onclick="window.loansManagementModule.openActionModal(${loan.loan_id}, 'return')">Return</button>`);
        }
        if (this.permissions.chat) {
            buttons.push(`<button type="button" class="btn btn-sm btn-outline-success" onclick="window.loansManagementModule.openLoanChat(${loan.loan_id})"><i class="bi bi-chat-dots me-1"></i>Chat</button>`);
        }
        return buttons.join('\n');
    }

    openLoanChat(loanId) {
        this.loanChat.open(Number(loanId));
    }
    
    renderLoanDetails(loan) {
        return renderModernLoanDetails(
            loan,
            (statusId) => this.getStatusBadgeClass(statusId),
            (loanObj) => this.getDisplayStatusName(loanObj),
            {
                showVerifyButton: this.permissions.approve === true,
                verifyFunctionName: 'verifyDocument',
                moduleName: 'loansManagementModule',
                paymentStatusBadgeClass: 'bg-warning text-dark',
                pnStatusBadgeClass: 'bg-warning text-dark'
            }
        );
    }

    closeViewLoanModal() {
        const viewLoanModalEl = document.getElementById('viewLoanModal');
        if (viewLoanModalEl) {
            bootstrap.Modal.getInstance(viewLoanModalEl)?.hide();
        }
    }

    async quickProcessLoan(loanId, actionType) {
        if (actionType === 'approve' && !this.permissions.approve) return;
        if (actionType === 'decline' && !this.permissions.decline) return;
        if (actionType === 'return' && !this.permissions.return) return;

        this.closeViewLoanModal();

        const payload = await confirmQuickLoanProcess({
            loanId,
            actionType,
            loans: this.loans,
            apiPath: 'csdl/csdl-loans-management.php',
            requireRemarks: actionType === 'return',
            remarksLabel: 'Reason for returning this application',
        });
        if (!payload) return;

        try {
            const response = await ApiService.post('/csdl/csdl-loans-management.php', {
                action: 'process',
                loanId,
                processType: actionType,
                amountApproved: payload.amountApproved,
                remarks: payload.remarks,
            });

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

    openActionModal(loanId, actionType) {
        if (actionType === 'approve' && !this.permissions.approve) return;
        if (actionType === 'decline' && !this.permissions.decline) return;
        if (actionType === 'return' && !this.permissions.return) return;
        if (actionType === 'endorse' && !this.permissions.endorse) return;
        
        const loan = this.loans.find((item) => String(item.loan_id) === String(loanId));
        if (!loan) {
            Swal.fire({ icon: 'error', title: 'Loan Not Found', text: 'Please refresh the loan list and try again.' });
            return;
        }

        this.closeViewLoanModal();
        
        const loanIdEl = document.getElementById('actionLoanId');
        const actionTypeEl = document.getElementById('actionType');
        const modalEl = document.getElementById('actionLoanModal');
        
        if (!loanIdEl || !actionTypeEl || !modalEl) return;

        const modal = new bootstrap.Modal(modalEl);
        const title = document.getElementById('actionLoanModalTitle');
        const form = document.getElementById('actionLoanForm');
        const remarksField = document.getElementById('actionRemarks');
        const remarksLabel = document.getElementById('actionRemarksLabel');
        const remarksContainer = document.getElementById('actionRemarksContainer');
        const submitButton = document.getElementById('submitActionBtn');
        const studentEl = document.getElementById('actionStudentName');
        const amountEl = document.getElementById('actionAmountCanPay');

        if (form) form.reset();

        loanIdEl.value = loanId;
        actionTypeEl.value = actionType;
        
        // Set modal content
        const amount = Number(loan.loan_amount_can_pay ?? loan.amountCanPay ?? 0);
        const studentName = loan.student_name || loan.name || 'Student';
        
        if (studentEl) studentEl.textContent = studentName;
        if (amountEl) amountEl.textContent = `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        
        // Set title
        if (title) {
            const titleMap = {
                'return': 'Return Application',
                'endorse': 'Endorse to Assessment'
            };
            title.textContent = titleMap[actionType] || `${actionType.charAt(0).toUpperCase() + actionType.slice(1)} Application`;
        }
        
        // Remarks belong to Return only; endorsement needs no extra input.
        if (remarksContainer) remarksContainer.classList.toggle('d-none', actionType === 'endorse');
        if (remarksField) {
            remarksField.required = (actionType === 'return');
            remarksField.placeholder = 'Enter remarks or reason...';
        }
        if (remarksLabel) remarksLabel.innerHTML = 'Return Remarks <span class="text-danger">*</span>';
        if (submitButton) submitButton.textContent = actionType === 'return' ? 'Return Application' : 'Endorse to Assessment';
        
        modal.show();
    }
    
    getApprovalDestination(loan) {
        // CSDL authority is based on the balance left after the student's
        // declared payment, not on the Amount Can Pay itself.
        const totalBalance = Number(loan?.balance_total_balance ?? loan?.totalBalance ?? 0);
        const amountCanPay = Number(loan?.loan_amount_can_pay ?? loan?.amountCanPay ?? 0);
        const remainingBalance = Math.max(0, totalBalance - amountCanPay);

        // Loans in the CSDL queue are already limited to this threshold by
        // the API. Keep the fallback accurate if an out-of-scope record is
        // opened from a stale page.
        return remainingBalance <= 3000 ? 'Cashier Office' : 'Assessment Office';
    }

    getApprovalAction(loan) {
        const destination = this.getApprovalDestination(loan);
        return {
            processType: 'approve',
            title: 'Approve Application',
            buttonLabel: 'Approve',
            prompt: `Approve this application? It will be sent to ${destination} for the next step.`,
            destination,
            destinationLabel: 'Next Office'
        };
    }

    openApprovalModal(loanId) {
        if (!this.permissions.approve) return;

        const loan = this.loans.find((item) => String(item.loan_id) === String(loanId));
        if (!loan) {
            Swal.fire({ icon: 'error', title: 'Loan Not Found', text: 'Please refresh the loan list and try again.' });
            return;
        }

        const amount = Number(loan.loan_amount_can_pay ?? loan.amountCanPay ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) {
            Swal.fire({ icon: 'warning', title: 'Amount Required', text: 'This loan has no valid Amount Can Pay to approve.' });
            return;
        }

        this.closeViewLoanModal();

        const modalEl = document.getElementById('approveLoanModal');
        const loanIdEl = document.getElementById('approveLoanId');
        const studentEl = document.getElementById('approveStudentName');
        const amountEl = document.getElementById('approveAmountCanPay');
        
        if (!modalEl || !loanIdEl || !studentEl || !amountEl) return;

        const studentName = loan.student_name || loan.name || 'Student';

        loanIdEl.value = String(loanId);
        studentEl.textContent = studentName;
        const formattedAmount = `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        amountEl.textContent = formattedAmount;

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
    }

    async submitApproval() {
        if (!this.permissions.approve) return;

        const loanId = document.getElementById('approveLoanId')?.value;
        const loan = this.loans.find((item) => String(item.loan_id) === String(loanId));
        const amount = Number(loan?.loan_amount_can_pay ?? loan?.amountCanPay ?? 0);
        if (!loanId || !Number.isFinite(amount) || amount <= 0) {
            Swal.fire({ icon: 'error', title: 'Unable to Approve', text: 'The loan amount cannot be determined.' });
            return;
        }

        const confirmBtn = document.getElementById('confirmApprovalBtn');
        if (confirmBtn) confirmBtn.disabled = true;

        const approvalAction = this.getApprovalAction(loan);

        try {
            const response = await ApiService.post('/csdl/csdl-loans-management.php', {
                action: 'process',
                loanId,
                processType: approvalAction.processType,
                amountApproved: amount,
                remarks: '' // Auto-generated on backend
            });
            if (!response.success) throw new Error(response.message || `Unable to ${approvalAction.buttonLabel.toLowerCase()} the loan.`);

            bootstrap.Modal.getInstance(document.getElementById('approveLoanModal'))?.hide();
            await Swal.fire({
                icon: 'success',
                title: 'Application Approved',
                text: response.message || `The loan was sent to ${approvalAction.destination}.`,
                confirmButtonText: 'OK'
            });
            await this.loadStats();
            await this.loadLoans();
        } catch (error) {
            console.error('Error approving loan:', error);
            Swal.fire({ icon: 'error', title: `${approvalAction.buttonLabel} Failed`, text: error.message || `Unable to ${approvalAction.buttonLabel.toLowerCase()} the loan.` });
        } finally {
            if (confirmBtn) confirmBtn.disabled = false;
        }
    }

    async submitAction() {
        const loanId = document.getElementById('actionLoanId')?.value;
        const actionType = document.getElementById('actionType')?.value;
        const remarks = document.getElementById('actionRemarks')?.value?.trim();

        if (!loanId || !actionType) {
            Swal.fire({ icon: 'error', title: 'Missing Information', text: 'Please provide all required information.' });
            return;
        }

        // Validate remarks for return action
        if (actionType === 'return' && !remarks) {
            Swal.fire({ icon: 'warning', title: 'Remarks Required', text: 'Please enter the reason for returning this application.' });
            return;
        }

        const submitBtn = document.getElementById('submitActionBtn');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const response = await ApiService.post('/csdl/csdl-loans-management.php', {
                action: 'process',
                loanId,
                processType: actionType,
                amountApproved: 0,
                remarks: remarks || '' // Auto-generated on backend if empty
            });

            if (!response.success) throw new Error(response.message || 'Failed to process loan.');

            bootstrap.Modal.getInstance(document.getElementById('actionLoanModal'))?.hide();
            await Swal.fire({
                icon: 'success',
                title: 'Success',
                text: response.message || 'Loan processed successfully.',
                confirmButtonText: 'OK'
            });
            await this.loadStats();
            await this.loadLoans();
        } catch (error) {
            console.error('Error processing loan:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to process loan.' });
        } finally {
            if (submitBtn) submitBtn.disabled = false;
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
    
    async verifyDocument(loanId, documentId) {
        try {
            // eslint-disable-next-line no-undef
            const result = await Swal.fire({
                title: 'Record CSDL Review',
                text: 'Confirm you inspected the uploaded guardian ID and checked its holder name and document type. This records staff review, not issuer authentication.',
                icon: 'question',
                showCancelButton: true,
                confirmButtonColor: '#03600f',
                cancelButtonColor: '#6c757d',
                confirmButtonText: 'Record review',
                cancelButtonText: 'Cancel'
            });
            
            if (!result.isConfirmed) {
                return;
            }
            
            const response = await ApiService.post('/csdl/csdl-loans-management.php', {
                action: 'verifyDocument',
                loanId: loanId,
                documentId: documentId
            });
            
            if (response.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Guardian ID review recorded.',
                    confirmButtonText: 'OK'
                });
                
                // Reload loan details
                await this.viewLoan(loanId);
            } else {
                throw new Error(response.message || 'Failed to verify document');
            }
        } catch (error) {
            console.error('Error verifying document:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message || 'Failed to verify document',
                confirmButtonText: 'OK'
            });
        }
    }
    
    async exportLoans() {
        if (!rbacUtil.requireModulePermission(this.permissions.view, 'export loans data')) {
            return;
        }
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        
        // First, fetch all loans matching current filters for export
        try {
            // Fetch every page that matches the current filters.
            const params = {
                action: 'list',
                page: 1,
                perPage: 100,
                scope: this.activeTab,
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                period: this.filters.period || '',
                campus: this.filters.campus || '',
                search: this.filters.search || ''
            };
            
            // Remove empty parameters
            Object.keys(params).forEach(key => {
                if (params[key] === '' || key === 'page') {
                    if (key !== 'page' && key !== 'perPage') delete params[key];
                }
            });
            
            const exportLoans = [];
            for (let page = 1; ; page += 1) {
                params.page = page;
                const response = await ApiService.get('/csdl/csdl-loans-management.php', params);
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
            const rows = exportLoans.map((r) => {
                if (this.activeTab === 'all') {
                    return {
                        'Application No.': r.loan_application_no || '',
                        'Student ID': r.student_school_id || '',
                        'Student Name': r.student_name || '',
                        Campus: r.campus_name || 'Unassigned',
                        'Amount Can Pay': fmtLoanMgmtPeso(r.loan_amount_can_pay).replace(/^₱/, ''),
                        'Amount Paid': fmtLoanMgmtPeso(r.loan_recorded_payment_amount).replace(/^₱/, ''),
                        'Current Office': this.getCurrentOffice(r),
                        'Loan Status': this.getDisplayStatusName(r),
                        'Payment Status': this.getPaymentStatusName(r),
                        'PN Status': this.getPnStatusName(r),
                        'Date Applied': fmtLoanMgmtDate(r.loan_application_date),
                    };
                }
                return mapLoanMgmtExportRow(
                    r,
                    this.getDisplayStatusName(r),
                    this.getPaymentStatusName(r),
                    this.getPnStatusName(r)
                );
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
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `csdl_loans_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }
            
            if (choice === 'xls') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `csdl_loans_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }
            
            if (choice === 'doc') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;background:#f0f0f0;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><table style="border-collapse:collapse;width:100%;">${th}${trs}</table></body></html>`;
                this.downloadBlob(new Blob([html], { type: 'application/msword' }), `csdl_loans_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }
            
            if (choice === 'pdf') {
                const now = new Date();
                const dateStr = now.toLocaleDateString();
                const timeStr = now.toLocaleTimeString();
                
                // Build filter summary
                const filterParts = [];
                if (this.filters.semester) {
                    const semSelect = document.getElementById('filterSemester');
                    const semText = semSelect?.selectedOptions[0]?.textContent || this.filters.semester;
                    filterParts.push(`Semester: ${escapeHtml(semText)}`);
                }
                if (this.filters.schoolYear) {
                    const sySelect = document.getElementById('filterSchoolYear');
                    const syText = sySelect?.selectedOptions[0]?.textContent || this.filters.schoolYear;
                    filterParts.push(`School Year: ${escapeHtml(syText)}`);
                }
                if (this.filters.period) {
                    const periodSelect = document.getElementById('filterPeriod');
                    const periodText = periodSelect?.selectedOptions[0]?.textContent || this.filters.period;
                    filterParts.push(`Period: ${escapeHtml(periodText)}`);
                }
                if (this.filters.campus) {
                    const campusSelect = document.getElementById('filterCampus');
                    const campusText = campusSelect?.selectedOptions[0]?.textContent || this.filters.campus;
                    filterParts.push(`Campus: ${escapeHtml(campusText)}`);
                }
                if (this.filters.search) {
                    filterParts.push(`Search: ${escapeHtml(this.filters.search)}`);
                }
                const filterHtml = filterParts.length > 0 
                    ? `<div class="filter-info"><strong>Applied Filters:</strong> ${filterParts.join(' | ')}</div>`
                    : '';

                // Build table from rows
                const headers = Object.keys(rows[0] || {});
                const thCells = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
                const bodyRows = rows.map((row, idx) => {
                    const cells = headers.map(h => `<td>${escapeHtml(String(row[h] ?? ''))}</td>`).join('');
                    return `<tr class="${idx % 2 === 0 ? 'even' : 'odd'}">${cells}</tr>`;
                }).join('');

                const printHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>CSDL Loans Management Report</title>
    <style>
        @media print {
            @page { size: landscape; margin: 15mm; }
            body { margin: 0; }
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: 10px;
            color: #333;
            line-height: 1.4;
        }
        .header {
            display: grid;
            grid-template-columns: 68px minmax(0, 1fr) minmax(170px, auto);
            column-gap: 14px;
            align-items: center;
            text-align: left;
            margin-bottom: 20px;
            border-bottom: 2px solid #198754;
            padding-bottom: 15px;
            break-inside: avoid;
        }
        .logo {
            width: 60px;
            height: 60px;
            object-fit: contain;
            grid-column: 1;
            grid-row: 1 / 4;
            margin: 0;
        }
        .system-title, .office-title, .report-title {
            grid-column: 2;
        }
        .metadata {
            grid-column: 3;
            grid-row: 1 / 4;
            text-align: right;
        }
        .system-title {
            font-size: 18px;
            font-weight: bold;
            color: #198754;
            margin: 5px 0;
        }
        .office-title {
            font-size: 14px;
            color: #666;
            margin: 5px 0;
        }
        .report-title {
            font-size: 16px;
            font-weight: bold;
            color: #333;
            margin: 10px 0 5px;
        }
        .metadata {
            font-size: 10px;
            color: #666;
            margin-top: 5px;
        }
        .filter-info {
            background: #f8f9fa;
            padding: 10px;
            margin: 15px 0;
            border-left: 4px solid #198754;
            font-size: 10px;
            color: #555;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 6px;
            text-align: left;
            font-size: 9px;
        }
        th {
            background-color: #198754;
            color: white;
            font-weight: 600;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            text-align: center;
        }
        tr.even {
            background-color: #f8f9fa;
        }
        tr.odd {
            background-color: white;
        }
        .footer {
            margin-top: 20px;
            padding-top: 10px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 9px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="header">
        <img src="${new URL('../../assets/images/i.png', document.baseURI).href}" alt="Logo" class="logo">
        <div class="system-title">Student Financial Assistance</div>
        <div class="office-title">Central Student Development and Linkages Office</div>
        <div class="report-title">CSDL Loans Management Report</div>
        <div class="metadata">Generated on ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)} | Total Records: ${rows.length}</div>
    </div>
    ${filterHtml}
    <table>
        <thead>
            <tr>${thCells}</tr>
        </thead>
        <tbody>
            ${bodyRows}
        </tbody>
    </table>
    <div class="footer">
        <p>&copy; ${now.getFullYear()} Central Student Development and Linkages Office. All rights reserved.</p>
        <p>This document is for official use only. Please handle with confidentiality.</p>
    </div>
    <script>
        window.onload = function() { 
            window.print(); 
        };
    </script>
</body>
</html>`;

                const printWindow = window.open('', '_blank');
                if (printWindow) {
                    printWindow.document.write(printHtml);
                    printWindow.document.close();
                }
                return;
            }
        } catch (error) {
            console.error('Error exporting loans:', error);
            await swal.fire({
                icon: 'error',
                title: 'Export Failed',
                text: 'Failed to export loan data. Please try again.',
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
        if (actionType === 'approve' && !this.permissions.approve) return;
        if (actionType === 'decline' && !this.permissions.decline) return;
        if (actionType === 'return' && !this.permissions.return) return;
        
        const amountApproved = document.getElementById('amountApproved')?.value;
        const remarks = document.getElementById('actionRemarks')?.value?.trim() || '';

        if (!loanId || !actionType || (actionType === 'return' && !remarks)) {
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
            const response = await ApiService.post('/csdl/csdl-loans-management.php', {
                action: 'process',
                loanId,
                processType: actionType,
                amountApproved,
                remarks: actionType === 'endorse' ? '' : remarks
            });
            
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
     * Row actions use <details> + absolutely positioned menu inside .table-responsive.
     * That scroll container clips overflow and forces a tiny scrollable menu. When open,
     * pin the menu with position:fixed to the viewport so all items show without scrolling.
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

export default CsdlLoansManagementModule;
