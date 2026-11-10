import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import ApiService from '../../services/services-apiService.js?v=20260909-formdata-csrf';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import {
    INLINE_ACTION_IGNORE,
    balanceRowActions,
    inlineActionButton,
    inlineActionsRow,
} from '../../shared/shared-inline-actions.js';

const BALANCE_CSV_HEADERS = [
    'Student ID',
    'Student Name',
    'School Year',
    'Period',
    'Total Balance',
    'Previous Balance',
    'Current Balance',
    'Advice to Pay',
    'As of Date',
    'Internal Scholarship',
    'External Scholarships'
];
const MAX_BALANCE_IMPORT_BYTES = 250 * 1024 * 1024;

function formatImportElapsed(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(remainingSeconds).padStart(2, '0');
    return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

class FinanceBalancesManagementModule {
    constructor() {
        this.debugActions = false;
        this.currentPage = 1;
        this.perPage = 10;
        this.filters = {
            schoolYearId: '',
            semesterId: '',
            periodId: '',
            search: ''
        };
        this.balances = [];
        this.total = 0;
        this.totalPages = 0;
        this.schoolYears = [];
        this.semesters = [];
        this.students = [];
        this.periods = [];
        this.activePeriods = [];
        this.pendingFinanceRegistrations = 0;
        this.pendingFinanceStudents = [];
        this.pendingCurrentPage = 1;
        this.pendingPerPage = 10;
        this.pendingTotal = 0;
        this.pendingTotalPages = 1;
        this.pendingFinanceProgramCount = 0;
        this.pendingFinanceYearLevelCount = 0;
        this.pendingFinanceProgramSummary = [];
        this.pendingFinanceYearLevelSummary = [];
        this.selectedBalanceIds = new Set();
        this.selectedPendingStudentIds = new Set();
        this._pendingRequestId = 0;
        this._pendingSearchTimer = null;
        this.presetStudentId = '';
        this._pendingTableBound = false;
        this.programs = [];
        this.yearLevels = [];
        this.pendingSearchTerm = '';
        this.currentPendingViewStudent = null;
        this.isEditMode = false;
        this.selectedStudentId = '';
        this.modalRequestToken = 0;
        this.permissions = {
            view: false,
            create: false,
            edit: false,
            delete: false
        };
    }

    async init() {
        await this.ensureSession();
        await this.loadPermissions();
        await this.loadFilters();
        await Promise.all([
            this.loadOverallStats(),
            this.loadBalances(),
        ]);
        this.applyActionVisibility();
        this.bindTableActions(); // Bind action handlers once
        this.bindPendingFinanceTableActions();
        this.bindBulkDeleteControls();
        this.bindViewPendingFinanceActions();
        this.bindEvents();
        this.setupModalEvents();
        this.setupMobileFilterClose();
        this.bindBalancesTabs();
        this.bindPendingFinanceStatCards();
        this.activateTabFromHash();
    }

    bindBalancesTabs() {
        const refreshPendingBtn = document.getElementById('refreshPendingBtn');
        if (refreshPendingBtn) {
            refreshPendingBtn.addEventListener('click', async () => {
                this.pendingSearchTerm = '';
                const pendingSearch = document.getElementById('searchPendingFinance');
                const pendingSearchMobile = document.getElementById('searchPendingFinanceMobile');
                const pendingProgram = document.getElementById('filterPendingFinanceProgram');
                const pendingProgramMobile = document.getElementById('filterPendingFinanceProgramMobile');
                const pendingYearLevel = document.getElementById('filterPendingFinanceYearLevel');
                const pendingYearLevelMobile = document.getElementById('filterPendingFinanceYearLevelMobile');

                [pendingSearch, pendingSearchMobile].forEach(input => {
                    if (input) input.value = '';
                });
                [pendingProgram, pendingProgramMobile, pendingYearLevel, pendingYearLevelMobile].forEach(select => {
                    if (select) select.value = '';
                });
                this.pendingCurrentPage = 1;
                await this.loadFilters();
            });
        }

        const pendingExportBtn = document.getElementById('pendingExportBtn');
        if (pendingExportBtn) {
            pendingExportBtn.addEventListener('click', () => this.exportPendingRegistrations());
        }

        const searchPendingFinance = document.getElementById('searchPendingFinance');
        if (searchPendingFinance) {
            searchPendingFinance.addEventListener('input', (e) => {
                this.pendingSearchTerm = e.target.value || '';
                const mobile = document.getElementById('searchPendingFinanceMobile');
                if (mobile) mobile.value = this.pendingSearchTerm;
                window.clearTimeout(this._pendingSearchTimer);
                this._pendingSearchTimer = window.setTimeout(() => {
                    this.pendingCurrentPage = 1;
                    this.loadPendingFinanceBalances();
                }, 300);
            });
        }

        const searchPendingFinanceMobile = document.getElementById('searchPendingFinanceMobile');
        if (searchPendingFinanceMobile) {
            searchPendingFinanceMobile.addEventListener('input', (e) => {
                this.pendingSearchTerm = e.target.value || '';
                if (searchPendingFinance) searchPendingFinance.value = this.pendingSearchTerm;
                window.clearTimeout(this._pendingSearchTimer);
                this._pendingSearchTimer = window.setTimeout(() => {
                    this.pendingCurrentPage = 1;
                    this.loadPendingFinanceBalances();
                }, 300);
            });
        }

        const applyPendingFilters = () => {
            this.pendingCurrentPage = 1;
            this.loadPendingFinanceBalances();
        };
        const filterPendingProgram = document.getElementById('filterPendingFinanceProgram');
        const filterPendingYearLevel = document.getElementById('filterPendingFinanceYearLevel');
        if (filterPendingProgram) filterPendingProgram.addEventListener('change', applyPendingFilters);
        if (filterPendingYearLevel) filterPendingYearLevel.addEventListener('change', applyPendingFilters);

        const applyPendingFinanceMobileFiltersBtn = document.getElementById('applyPendingFinanceMobileFiltersBtn');
        if (applyPendingFinanceMobileFiltersBtn) {
            applyPendingFinanceMobileFiltersBtn.addEventListener('click', () => {
                const programMobile = document.getElementById('filterPendingFinanceProgramMobile');
                const yearLevelMobile = document.getElementById('filterPendingFinanceYearLevelMobile');
                if (programMobile && filterPendingProgram) filterPendingProgram.value = programMobile.value;
                if (yearLevelMobile && filterPendingYearLevel) filterPendingYearLevel.value = yearLevelMobile.value;
                applyPendingFilters();
                const mobileDropdown = document.getElementById('mobileFilterPendingFinanceBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }

        document.getElementById('pendingBalancePagination')?.addEventListener('click', (event) => {
            const page = Number(event.target.closest('button[data-page]')?.dataset.page);
            if (!Number.isInteger(page) || page < 1 || page > this.pendingTotalPages || page === this.pendingCurrentPage) return;
            this.pendingCurrentPage = page;
            this.loadPendingFinanceBalances();
        });
        document.getElementById('pendingPerPageSelect')?.addEventListener('change', (event) => {
            this.pendingPerPage = parseInt(event.target.value, 10) || 10;
            this.pendingCurrentPage = 1;
            this.loadPendingFinanceBalances();
        });
    }

    bindPendingFinanceStatCards() {
        const cards = document.querySelectorAll('#pendingRegistrationPanel [data-pending-finance-view]');
        cards.forEach((card) => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-pending-finance-view');
                if (view === 'uniquePrograms') {
                    this.showPendingFinanceProgramsModal();
                } else if (view === 'uniqueYearLevels') {
                    this.showPendingFinanceYearLevelsModal();
                } else {
                    this.showPendingFinanceStudentsModal();
                }
            });
        });
    }

    bindViewPendingFinanceActions() {
        const addBtn = document.getElementById('viewPendingFinanceAddBalanceBtn');
        if (addBtn && !addBtn.dataset.bound) {
            addBtn.dataset.bound = '1';
            addBtn.addEventListener('click', () => {
                const studentId = parseInt(this.currentPendingViewStudent?.student_id, 10);
                if (!studentId) return;
                const modalEl = document.getElementById('viewPendingFinanceModal');
                if (modalEl && window.bootstrap?.Modal) {
                    window.bootstrap.Modal.getInstance(modalEl)?.hide();
                }
                this.openModal(null, studentId);
            });
        }
    }

    getPendingFinanceRowById(studentId) {
        const key = String(studentId ?? '');
        return (this.pendingFinanceStudents || []).find((r) => String(r.student_id) === key) || null;
    }

    fmtPendingForwardedDate(val) {
        if (!val) return '—';
        const date = new Date(val);
        return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    openPendingFinanceViewModal(student) {
        if (!student) return;
        this.currentPendingViewStudent = student;
        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val || '—';
        };
        setText('viewPendingFinanceSchoolId', student.student_school_id);
        setText('viewPendingFinanceName', student.student_name);
        setText('viewPendingFinanceProgram', student.program_name);
        setText('viewPendingFinanceYearLevel', student.year_level_name);
        setText('viewPendingFinanceInternalScholarship', student.internal_scholarship_name || student.scholarship_name || 'None');
        setText('viewPendingFinanceExternalScholarships', student.external_scholarship_names || 'None');
        setText('viewPendingFinanceDepartment', student.department_name || '—');
        const addBtn = document.getElementById('viewPendingFinanceAddBalanceBtn');
        if (addBtn) {
            addBtn.classList.toggle('d-none', !this.permissions.create);
        }
        const modalEl = document.getElementById('viewPendingFinanceModal');
        if (modalEl && window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }
    }

    showPendingFinanceStudentsModal() {
        if (!this.permissions.view) return;
        const rows = Array.isArray(this.pendingFinanceStudents) ? this.pendingFinanceStudents : [];
        const tbody = document.getElementById('pendingFinanceStudentsModalBody');
        if (tbody) {
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">No pending students</td></tr>';
            } else {
                tbody.innerHTML = rows.map((student) => `
                    <tr>
                        <td class="text-center">${escapeHtml(student.student_school_id || '—')}</td>
                        <td class="text-center">${escapeHtml(student.student_name || '—')}</td>
                        <td class="text-center">${escapeHtml(student.program_name || '—')}</td>
                        <td class="text-center">${escapeHtml(student.year_level_name || '—')}</td>
                        <td class="text-center">${escapeHtml(student.department_name || '—')}</td>
                        <td class="text-center"><span class="badge bg-warning text-dark">Pending</span></td>
                    </tr>
                `).join('');
            }
        }
        const counter = document.querySelector('#pendingFinanceStudentsModal [data-card-modal-count]');
        if (counter) counter.textContent = `Showing ${rows.length} of ${this.pendingTotal} students on the current filtered page`;
        const modalEl = document.getElementById('pendingFinanceStudentsModal');
        if (modalEl && window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }
    }

    showPendingFinanceProgramsModal() {
        if (!this.permissions.view) return;
        const list = (this.pendingFinanceProgramSummary || []).map((row) => ({
            program: row.label || 'Unknown',
            count: Number(row.total || 0),
        }));
        const tbody = document.getElementById('pendingFinanceProgramsModalBody');
        if (tbody) {
            if (!list.length) {
                tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted py-3">No data</td></tr>';
            } else {
                tbody.innerHTML = list.map((r) => `
                    <tr>
                        <td class="text-center">${escapeHtml(r.program)}</td>
                        <td class="text-center">${escapeHtml(String(r.count))}</td>
                    </tr>
                `).join('');
            }
        }
        this.updateCardModalCount('pendingFinanceProgramsModal', list.length, 'programs');
        const modalEl = document.getElementById('pendingFinanceProgramsModal');
        if (modalEl && window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }
    }

    showPendingFinanceYearLevelsModal() {
        if (!this.permissions.view) return;
        const list = (this.pendingFinanceYearLevelSummary || []).map((row) => ({
            yearLevel: row.label || 'Unknown',
            count: Number(row.total || 0),
        }));
        const tbody = document.getElementById('pendingFinanceYearLevelsModalBody');
        if (tbody) {
            if (!list.length) {
                tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted py-3">No data</td></tr>';
            } else {
                tbody.innerHTML = list.map((r) => `
                    <tr>
                        <td class="text-center">${escapeHtml(r.yearLevel)}</td>
                        <td class="text-center">${escapeHtml(String(r.count))}</td>
                    </tr>
                `).join('');
            }
        }
        this.updateCardModalCount('pendingFinanceYearLevelsModal', list.length, 'year levels');
        const modalEl = document.getElementById('pendingFinanceYearLevelsModal');
        if (modalEl && window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }
    }

    activateTabFromHash() {
        const hash = window.location.hash;
        if (hash !== '#pendingFinanceSection' && hash !== '#pendingRegistrationPanel') return;

        const pendingTab = document.getElementById('pending-registration-tab');
        if (pendingTab && window.bootstrap?.Tab) {
            window.bootstrap.Tab.getOrCreateInstance(pendingTab).show();
        }

        const section = document.getElementById('pendingFinanceSection');
        if (section) {
            window.setTimeout(() => {
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 150);
        }
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
    }

    async loadPermissions() {
        try {
            const response = await fetch('../../api/masterfiles/masterfiles-permissions.php?action=get_my_permissions', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const data = await response.json();
            if (!data?.success || !Array.isArray(data.permissions)) {
                // Fail closed for action controls when permission payload is unavailable.
                this.permissions = { view: false, create: false, edit: false, delete: false };
                return;
            }

            const can = (key) => {
                const perm = data.permissions.find((p) => p.permission_key === key);
                return !!(perm && Number(perm.is_granted) === 1);
            };

            this.permissions = {
                view: can('assessment.balances.view'),
                create: can('assessment.balances.create'),
                edit: can('assessment.balances.edit'),
                delete: can('assessment.balances.delete')
            };
        } catch (error) {
            console.error('Error loading finance balance permissions:', error);
            this.permissions = { view: false, create: false, edit: false, delete: false };
        }
    }

    applyActionVisibility() {
        const importExportBtn = document.getElementById('importExportBtn');
        const pendingExportBtn = document.getElementById('pendingExportBtn');
        const bulkDeleteBalancesBtn = document.getElementById('bulkDeleteBalancesBtn');
        const bulkDeletePendingBtn = document.getElementById('bulkDeletePendingBtn');
        if (importExportBtn) importExportBtn.style.display = this.permissions.create ? '' : 'none';
        if (pendingExportBtn) pendingExportBtn.style.display = this.permissions.view ? '' : 'none';
        if (bulkDeleteBalancesBtn) bulkDeleteBalancesBtn.classList.toggle('d-none', !this.permissions.delete);
        if (bulkDeletePendingBtn) bulkDeletePendingBtn.classList.toggle('d-none', !this.permissions.delete);
        document.querySelectorAll('[data-balance-selection-column], [data-pending-selection-column]').forEach((column) => {
            column.classList.toggle('d-none', !this.permissions.delete);
        });
    }

    bindBulkDeleteControls() {
        if (this._bulkDeleteControlsBound) return;
        this._bulkDeleteControlsBound = true;

        document.getElementById('bulkDeleteBalancesBtn')?.addEventListener('click', () => this.bulkDeleteSelectedBalances());
        document.getElementById('bulkDeletePendingBtn')?.addEventListener('click', () => this.bulkDeleteSelectedPending());

        document.getElementById('balancesTable')?.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.id === 'selectAllBalances') {
                this.getRenderedBalanceCheckboxes().forEach((checkbox) => {
                    const id = Number(checkbox.dataset.balanceId || 0);
                    checkbox.checked = target.checked;
                    if (target.checked) this.selectedBalanceIds.add(id);
                    else this.selectedBalanceIds.delete(id);
                });
            } else if (target.classList.contains('balance-select-checkbox')) {
                const id = Number(target.dataset.balanceId || 0);
                if (target.checked) this.selectedBalanceIds.add(id);
                else this.selectedBalanceIds.delete(id);
            } else {
                return;
            }
            this.updateBalanceBulkDeleteControls();
        });

        document.getElementById('pendingFinanceTable')?.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.id === 'selectAllPendingBalances') {
                this.getRenderedPendingCheckboxes().forEach((checkbox) => {
                    const id = Number(checkbox.dataset.studentId || 0);
                    checkbox.checked = target.checked;
                    if (target.checked) this.selectedPendingStudentIds.add(id);
                    else this.selectedPendingStudentIds.delete(id);
                });
            } else if (target.classList.contains('pending-balance-select-checkbox')) {
                const id = Number(target.dataset.studentId || 0);
                if (target.checked) this.selectedPendingStudentIds.add(id);
                else this.selectedPendingStudentIds.delete(id);
            } else {
                return;
            }
            this.updatePendingBulkDeleteControls();
        });

        this.updateBalanceBulkDeleteControls();
        this.updatePendingBulkDeleteControls();
    }

    getRenderedBalanceCheckboxes() {
        return Array.from(document.querySelectorAll('#balancesTable tbody .balance-select-checkbox'));
    }

    getRenderedPendingCheckboxes() {
        return Array.from(document.querySelectorAll('#pendingFinanceTableBody .pending-balance-select-checkbox'));
    }

    updateBalanceBulkDeleteControls() {
        const count = this.selectedBalanceIds.size;
        const button = document.getElementById('bulkDeleteBalancesBtn');
        const countElement = document.getElementById('bulkDeleteBalancesCount');
        if (button) button.disabled = count === 0;
        if (countElement) countElement.textContent = String(count);

        const checkboxes = this.getRenderedBalanceCheckboxes();
        const selectedOnPage = checkboxes.filter((checkbox) => this.selectedBalanceIds.has(Number(checkbox.dataset.balanceId || 0))).length;
        const selectAll = document.getElementById('selectAllBalances');
        if (selectAll) {
            selectAll.disabled = checkboxes.length === 0;
            selectAll.checked = checkboxes.length > 0 && selectedOnPage === checkboxes.length;
            selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < checkboxes.length;
        }
    }

    updatePendingBulkDeleteControls() {
        const count = this.selectedPendingStudentIds.size;
        const button = document.getElementById('bulkDeletePendingBtn');
        const countElement = document.getElementById('bulkDeletePendingCount');
        if (button) button.disabled = count === 0;
        if (countElement) countElement.textContent = String(count);

        const checkboxes = this.getRenderedPendingCheckboxes();
        const selectedOnPage = checkboxes.filter((checkbox) => this.selectedPendingStudentIds.has(Number(checkbox.dataset.studentId || 0))).length;
        const selectAll = document.getElementById('selectAllPendingBalances');
        if (selectAll) {
            selectAll.disabled = checkboxes.length === 0;
            selectAll.checked = checkboxes.length > 0 && selectedOnPage === checkboxes.length;
            selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < checkboxes.length;
        }
    }

    async showBulkDeleteResult({ deletedCount, failed, itemLabel }) {
        if (failed.length > 0) {
            const protectedLabels = failed.slice(0, 4).map((item) => item.label || item.reason || itemLabel);
            const remaining = failed.length - protectedLabels.length;
            await Swal.fire({
                icon: deletedCount > 0 ? 'warning' : 'error',
                title: deletedCount > 0 ? 'Batch delete partially completed' : 'Selected records were kept',
                text: `${deletedCount} deleted. Could not delete: ${protectedLabels.join(', ')}${remaining > 0 ? ` and ${remaining} more` : ''}.`,
                confirmButtonColor: '#03600f',
            });
            return;
        }
        await Swal.fire({
            icon: 'success',
            title: 'Delete Complete',
            text: `${deletedCount} ${itemLabel}${deletedCount === 1 ? '' : 's'} deleted successfully.`,
            confirmButtonColor: '#03600f',
        });
    }

    async bulkDeleteSelectedBalances() {
        if (!this.permissions.delete) {
            rbacUtil.requireModulePermission(false, 'delete balances');
            return;
        }
        const ids = Array.from(this.selectedBalanceIds);
        if (ids.length === 0) return;

        const confirmation = await Swal.fire({
            icon: 'warning',
            title: `Delete ${ids.length} selected balance record${ids.length === 1 ? '' : 's'}?`,
            text: 'Balance records linked to loan applications will be kept and reported.',
            showCancelButton: true,
            confirmButtonText: 'Delete Selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc3545',
            reverseButtons: true,
        });
        if (!confirmation.isConfirmed) return;

        const button = document.getElementById('bulkDeleteBalancesBtn');
        if (button) button.setAttribute('aria-busy', 'true');
        try {
            const response = await ApiService.post('/assessment/assessment-balances-management.php', {
                action: 'bulk_delete_balances',
                balance_ids: ids,
            });
            const deletedCount = Number(response?.deleted_count || 0);
            const failed = Array.isArray(response?.failed) ? response.failed : [];
            this.selectedBalanceIds.clear();
            await Promise.all([this.loadBalances(), this.loadOverallStats()]);
            await this.showBulkDeleteResult({ deletedCount, failed, itemLabel: 'balance record' });
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Batch Delete Failed',
                text: error?.response?.data?.message || error?.message || 'Unable to delete the selected balance records.',
                confirmButtonColor: '#03600f',
            });
        } finally {
            if (button) button.removeAttribute('aria-busy');
            this.updateBalanceBulkDeleteControls();
        }
    }

    async bulkDeleteSelectedPending() {
        if (!this.permissions.delete) {
            rbacUtil.requireModulePermission(false, 'delete pending balance registrations');
            return;
        }
        const ids = Array.from(this.selectedPendingStudentIds);
        if (ids.length === 0) return;

        const confirmation = await Swal.fire({
            icon: 'warning',
            title: `Delete ${ids.length} pending registration${ids.length === 1 ? '' : 's'}?`,
            text: 'This permanently deletes the selected pending student registrations. Linked records will be kept and reported.',
            showCancelButton: true,
            confirmButtonText: 'Delete Selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc3545',
            reverseButtons: true,
        });
        if (!confirmation.isConfirmed) return;

        const button = document.getElementById('bulkDeletePendingBtn');
        if (button) button.setAttribute('aria-busy', 'true');
        try {
            const response = await ApiService.post('/assessment/assessment-balances-management.php', {
                action: 'bulk_delete_pending',
                student_ids: ids,
            });
            const deletedCount = Number(response?.deleted_count || 0);
            const failed = Array.isArray(response?.failed) ? response.failed : [];
            this.selectedPendingStudentIds.clear();
            await this.loadFilters();
            await this.showBulkDeleteResult({ deletedCount, failed, itemLabel: 'pending registration' });
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Batch Delete Failed',
                text: error?.response?.data?.message || error?.message || 'Unable to delete the selected pending registrations.',
                confirmButtonColor: '#03600f',
            });
        } finally {
            if (button) button.removeAttribute('aria-busy');
            this.updatePendingBulkDeleteControls();
        }
    }

    async loadFilters() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch('../../api/assessment/assessment-balances-management.php?action=filters', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success) {
                this.schoolYears = response.schoolYears || [];
                this.semesters = response.semesters || [];
                this.students = response.students || [];
                this.periods = response.periods || [];
                this.activePeriods = response.activePeriods || [];
                this.pendingFinanceRegistrations = Number(response.pendingFinanceRegistrations || 0);
                const pendingStats = response.pendingFinanceStats || {};
                this.pendingFinanceProgramCount = Number(pendingStats.uniquePrograms || 0);
                this.pendingFinanceYearLevelCount = Number(pendingStats.uniqueYearLevels || 0);
                this.pendingFinanceProgramSummary = response.pendingFinanceProgramSummary || [];
                this.pendingFinanceYearLevelSummary = response.pendingFinanceYearLevelSummary || [];
                this.programs = response.programs || [];
                this.yearLevels = response.yearLevels || [];
                this.populatePendingFinanceFilterDropdowns();
                this.hydratePendingFinanceCounts();
                await this.loadPendingFinanceBalances();
                
                // Populate school year filter (desktop and mobile)
                const sySelect = document.getElementById('filterSchoolYear');
                const sySelectMobile = document.getElementById('filterSchoolYearMobile');
                
                [sySelect, sySelectMobile].forEach(select => {
                    if (select) {
                        const defaultOption = select.querySelector('option[value=""]');
                        select.innerHTML = '';
                        if (defaultOption) {
                            select.appendChild(defaultOption);
                        } else {
                            const allOption = document.createElement('option');
                            allOption.value = '';
                            allOption.textContent = 'All School Years';
                            select.appendChild(allOption);
                        }
                        
                        this.schoolYears.forEach(sy => {
                            const option = document.createElement('option');
                            option.value = sy.sy_id;
                            option.textContent = sy.sy_code;
                            select.appendChild(option);
                        });
                    }
                });

                const fillReferenceSelect = (ids, items, valueKey, labelKey, allText) => {
                    ids.forEach((id) => {
                        const select = document.getElementById(id);
                        if (!select) return;
                        select.innerHTML = `<option value="">${allText}</option>`;
                        items.forEach((item) => {
                            const option = document.createElement('option');
                            option.value = item[valueKey];
                            option.textContent = item[labelKey];
                            select.appendChild(option);
                        });
                    });
                };
                fillReferenceSelect(['filterSemester', 'filterSemesterMobile'], this.semesters, 'semester_id', 'semester_name', 'All Semesters');
                fillReferenceSelect(['filterPeriod', 'filterPeriodMobile'], this.periods, 'app_period_id', 'app_period_name', 'All Periods');
                
                // Populate school year dropdown in modal
                const modalSySelect = document.getElementById('balanceSchoolYearId');
                if (modalSySelect) {
                    const defaultOption = modalSySelect.querySelector('option[value=""]');
                    modalSySelect.innerHTML = '';
                    if (defaultOption) {
                        modalSySelect.appendChild(defaultOption);
                    } else {
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'Select school year...';
                        modalSySelect.appendChild(allOption);
                    }
                    
                    this.schoolYears.forEach(sy => {
                        const option = document.createElement('option');
                        option.value = sy.sy_id;
                        option.textContent = sy.sy_code;
                        modalSySelect.appendChild(option);
                    });
                }
                
                // Populate period dropdown in modal
                const periodSelect = document.getElementById('balancePeriodId');
                if (periodSelect) {
                    const defaultOption = periodSelect.querySelector('option[value=""]');
                    periodSelect.innerHTML = '';
                    if (defaultOption) {
                        periodSelect.appendChild(defaultOption);
                    } else {
                        const allOption = document.createElement('option');
                        allOption.value = '';
                        allOption.textContent = 'Select period...';
                        periodSelect.appendChild(allOption);
                    }
                    
                    this.activePeriods.forEach(period => {
                        const option = document.createElement('option');
                        option.value = period.app_period_id;
                        option.textContent = period.app_period_name;
                        periodSelect.appendChild(option);
                    });
                }
            }
        } catch (error) {
            console.error('Error loading filters:', error);
        }
    }

    populatePendingFinanceFilterDropdowns() {
        const fillSelect = (selectId, items, valueKey, labelKey) => {
            const select = document.getElementById(selectId);
            if (!select) return;
            const current = select.value;
            select.innerHTML = `<option value="">${selectId.includes('Program') ? 'All Programs' : 'All Year Levels'}</option>`;
            (items || []).forEach((item) => {
                const opt = document.createElement('option');
                opt.value = item[valueKey];
                opt.textContent = item[labelKey];
                select.appendChild(opt);
            });
            if (current) select.value = current;
        };

        fillSelect('filterPendingFinanceProgram', this.programs, 'program_id', 'program_name');
        fillSelect('filterPendingFinanceYearLevel', this.yearLevels, 'year_level_id', 'year_level_name');
        fillSelect('filterPendingFinanceProgramMobile', this.programs, 'program_id', 'program_name');
        fillSelect('filterPendingFinanceYearLevelMobile', this.yearLevels, 'year_level_id', 'year_level_name');
    }

    hydratePendingFinanceCounts() {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val ?? 0);
        };
        set('statPendingFinanceTotal', this.pendingFinanceRegistrations);
        set('statPendingFinanceStudents', this.pendingFinanceRegistrations);
        set('statPendingFinancePrograms', this.pendingFinanceProgramCount);
        set('statPendingFinanceYearLevels', this.pendingFinanceYearLevelCount);
    }

    getPendingFinanceRequestParams(fetchAll = false) {
        const params = {
            action: 'pending',
            page: this.pendingCurrentPage,
            perPage: this.pendingPerPage,
        };
        const programId = document.getElementById('filterPendingFinanceProgram')?.value || '';
        const yearLevelId = document.getElementById('filterPendingFinanceYearLevel')?.value || '';
        const search = String(this.pendingSearchTerm || '').trim();
        if (programId) params.programId = programId;
        if (yearLevelId) params.yearLevelId = yearLevelId;
        if (search) params.search = search;
        if (fetchAll) params.all = 1;
        return params;
    }

    async fetchPendingFinanceData(fetchAll = false) {
        const qs = new URLSearchParams(this.getPendingFinanceRequestParams(fetchAll));
        const response = await fetch(`../../api/assessment/assessment-balances-management.php?${qs.toString()}`, {
            credentials: 'same-origin',
            cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Failed to load pending balances');
        return data;
    }

    async loadPendingFinanceBalances() {
        if (!this.permissions.view) return;
        const requestId = ++this._pendingRequestId;
        const tbody = document.getElementById('pendingFinanceTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="${this.permissions.delete ? 10 : 9}" class="text-center text-muted py-4">Loading pending balances...</td></tr>`;
        try {
            const response = await this.fetchPendingFinanceData(false);
            if (requestId !== this._pendingRequestId) return;
            const pagination = response.pagination || {};
            this.pendingFinanceStudents = response.students || [];
            this.pendingCurrentPage = Number(pagination.page || 1);
            this.pendingPerPage = Number(pagination.perPage || this.pendingPerPage);
            this.pendingTotal = Number(pagination.total || 0);
            this.pendingTotalPages = Math.max(1, Number(pagination.totalPages || 1));
            this.renderPendingFinanceTable();
            this.updatePendingFinancePagination();
        } catch (error) {
            if (requestId !== this._pendingRequestId) return;
            console.error('Error loading pending balances:', error);
            this.pendingFinanceStudents = [];
            this.pendingTotal = 0;
            this.pendingTotalPages = 1;
            this.renderPendingFinanceTable();
        }
    }

    updatePendingFinancePagination() {
        const total = this.pendingTotal;
        const start = total === 0 ? 0 : ((this.pendingCurrentPage - 1) * this.pendingPerPage) + 1;
        const end = Math.min(this.pendingCurrentPage * this.pendingPerPage, total);
        const summary = document.getElementById('pendingFinanceTableSummary');
        if (summary) summary.textContent = `Showing ${start} to ${end} of ${total} entries`;
        this.renderPaginationButtons('pendingBalancePagination', this.pendingCurrentPage, this.pendingTotalPages);
    }

    getFilteredPendingFinanceRows() {
        const q = String(this.pendingSearchTerm || '').toLowerCase().trim();
        const programSel = document.getElementById('filterPendingFinanceProgram');
        const yearLevelSel = document.getElementById('filterPendingFinanceYearLevel');
        let rows = Array.isArray(this.pendingFinanceStudents) ? [...this.pendingFinanceStudents] : [];

        if (programSel && programSel.value) {
            const programId = String(programSel.value);
            rows = rows.filter((r) => String(r.program_id) === programId);
        }
        if (yearLevelSel && yearLevelSel.value) {
            const yearLevelId = String(yearLevelSel.value);
            rows = rows.filter((r) => String(r.year_level_id) === yearLevelId);
        }

        if (q) {
            rows = rows.filter((r) => {
                const schoolId = String(r.student_school_id || '').toLowerCase();
                const name = String(r.student_name || '').toLowerCase();
                const program = String(r.program_name || '').toLowerCase();
                return schoolId.includes(q) || name.includes(q) || program.includes(q);
            });
        }

        return rows;
    }

    renderPendingFinanceTable() {
        const tbody = document.getElementById('pendingFinanceTableBody');
        const tabBadge = document.getElementById('pendingRegistrationTabBadge');
        const summaryEl = document.getElementById('pendingFinanceTableSummary');
        if (!tbody) return;

        const totalCount = Number(this.pendingFinanceRegistrations || 0);
        const rows = this.getFilteredPendingFinanceRows();

        if (tabBadge) {
            tabBadge.textContent = String(totalCount);
            tabBadge.classList.toggle('d-none', totalCount <= 0);
        }
        document.querySelectorAll('.sidebar-live-count[data-live-count-path="pendingBalanceRegistrations"]').forEach((sidebarBadge) => {
            sidebarBadge.textContent = totalCount > 99 ? '99+' : String(totalCount);
            sidebarBadge.setAttribute('title', `${totalCount} pending balance registrations`);
            sidebarBadge.setAttribute('aria-label', `${totalCount} pending balance registrations`);
        });

        if (summaryEl) this.updatePendingFinancePagination();

        if (totalCount === 0) {
            tbody.innerHTML = `<tr><td colspan="${this.permissions.delete ? 10 : 9}" class="text-center text-muted py-4">No pending balances</td></tr>`;
            this.updatePendingBulkDeleteControls();
            return;
        }

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${this.permissions.delete ? 10 : 9}" class="text-center text-muted py-4">No matching pending balances found</td></tr>`;
            this.updatePendingBulkDeleteControls();
            return;
        }

        tbody.innerHTML = rows.map((student) => {
            const studentId = student.student_id;
            const actionsMarkup = this.permissions.create
                ? inlineActionsRow(inlineActionButton({
                    type: 'add',
                    title: 'Add balance',
                    actionClass: 'pending-row-action',
                    dataAttrs: { 'add-balance': studentId },
                }))
                : '<span class="text-muted">—</span>';

            const selectionCell = this.permissions.delete
                ? `<td class="text-center balance-selection-cell" data-label="Select">
                    <input class="form-check-input pending-balance-select-checkbox" type="checkbox" data-student-id="${studentId}" aria-label="Select ${escapeHtml(student.student_school_id || student.student_name || 'pending registration')}"${this.selectedPendingStudentIds.has(Number(studentId)) ? ' checked' : ''}>
                </td>`
                : '';

            return `<tr data-pending-student-id="${studentId}" class="finance-pending-row-clickable">
                ${selectionCell}
                <td class="text-center finance-mobile-card-header" data-label="Student ID">
                    <span class="finance-card-primary">${escapeHtml(student.student_school_id || '—')}</span>
                    <span class="finance-card-secondary">${escapeHtml(student.student_name || '—')}</span>
                </td>
                <td class="text-center finance-mobile-name-cell" data-label="Student Name">${escapeHtml(student.student_name || '—')}</td>
                <td class="text-center" data-label="Program">${escapeHtml(student.program_name || '—')}</td>
                <td class="text-center" data-label="Year Level">${escapeHtml(student.year_level_name || '—')}</td>
                <td class="text-center" data-label="Department">${escapeHtml(student.department_name || '—')}</td>
                <td class="text-center" data-label="Internal Scholarship">${escapeHtml(student.internal_scholarship_code || student.scholarship_code || 'None')}</td>
                <td class="text-center" data-label="External Scholarships">${escapeHtml(student.external_scholarship_codes || 'None')}</td>
                <td class="text-center" data-label="Status"><span class="badge bg-warning text-dark">Pending</span></td>
                <td class="text-center" data-label="Actions">${actionsMarkup}</td>
            </tr>`;
        }).join('');
        this.updatePendingBulkDeleteControls();
    }

    async exportPendingRegistrations() {
        const swal = window.Swal;
        if (!swal) return;
        if (!this.permissions.view) {
            rbacUtil.requireModulePermission(false, 'view pending registrations');
            return;
        }

        let rows = [];
        try {
            const response = await this.fetchPendingFinanceData(true);
            rows = response.students || [];
        } catch (error) {
            await swal.fire({ icon: 'error', title: 'Export Failed', text: error.message || 'Unable to load pending balances for export.' });
            return;
        }
        if (rows.length === 0) {
            await swal.fire({
                icon: 'warning',
                title: 'No Data',
                text: 'No pending balances found to export.',
                confirmButtonText: 'OK',
            });
            return;
        }

        const result = await swal.fire({
            title: 'Export Pending Balances',
            input: 'select',
            inputOptions: { csv: 'CSV', xls: 'Excel (.xls)', doc: 'Word (.doc)', pdf: 'PDF (.pdf)' },
            inputValue: 'csv',
            showCancelButton: true,
            confirmButtonText: 'Export',
            cancelButtonText: 'Cancel',
            buttonsStyling: false,
            customClass: {
                confirmButton: 'btn btn-success px-4 me-2',
                cancelButton: 'btn btn-secondary px-4',
            },
        });

        if (!result.isConfirmed) return;

        const fmtDate = (val) => {
            if (!val) return '';
            const date = new Date(val);
            return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
        };

        const exportRows = rows.map((student) => ({
            'Student ID': student.student_school_id || '',
            'Student Name': student.student_name || '',
            'Program': student.program_name || '',
            'Year Level': student.year_level_name || '',
            'Department': student.department_name || '',
            'Balance Status': 'Pending',
        }));

        const choice = result.value;
        const stamp = new Date().toISOString().split('T')[0];

        if (choice === 'csv') {
            const headers = Object.keys(exportRows[0] || {});
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(exportRows.map((r) => headers.map((h) => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), `finance_pending_balances_${stamp}.csv`);
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(exportRows[0] || {});
            const th = headers.map((h) => `<th>${h}</th>`).join('');
            const trs = exportRows.map((r) => `<tr>${headers.map((h) => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `finance_pending_balances_${stamp}.xls`);
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(exportRows[0] || {});
            const th = headers.map((h) => `<th style="border:1px solid #000;padding:5px;">${h}</th>`).join('');
            const trs = exportRows.map((r) => `<tr>${headers.map((h) => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table style="border-collapse:collapse;width:100%;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), `finance_pending_balances_${stamp}.doc`);
            return;
        }

        if (choice === 'pdf') {
            // Professional PDF export using HTML print
            const now = new Date();
            const dateStr = now.toLocaleDateString();
            const timeStr = now.toLocaleTimeString();
            
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
    <title>Assessment Balance Records Export</title>
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
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 6px;
            text-align: center;
            font-size: 9px;
        }
        th {
            background-color: #198754;
            color: white;
            font-weight: 600;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
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
        <div class="office-title">Assessment Office - Balance Records</div>
        <div class="report-title">Balance Records Export</div>
        <div class="metadata">Generated on ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)} | Total Records: ${rows.length}</div>
    </div>
    <table>
        <thead>
            <tr>${thCells}</tr>
        </thead>
        <tbody>
            ${bodyRows}
        </tbody>
    </table>
    <div class="footer">
        <p>&copy; ${now.getFullYear()} Student Financial Assistance System. All rights reserved.</p>
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
    }

    bindPendingFinanceTableActions() {
        const tbody = document.getElementById('pendingFinanceTableBody');
        if (!tbody || this._pendingTableBound) return;
        this._pendingTableBound = true;

        tbody.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            if (target.closest('.pending-balance-select-checkbox')) return;

            const addBalanceBtn = target.closest('[data-add-balance]');
            if (addBalanceBtn) {
                ev.preventDefault();
                ev.stopPropagation();
                const studentId = parseInt(addBalanceBtn.getAttribute('data-add-balance') || '', 10);
                if (studentId > 0) {
                    this.openModal(null, studentId);
                }
                return;
            }

            if (target.closest(INLINE_ACTION_IGNORE)) return;

            const tr = target.closest('tr[data-pending-student-id]');
            if (!tr) return;
            const row = this.getPendingFinanceRowById(tr.getAttribute('data-pending-student-id'));
            if (row) this.openPendingFinanceViewModal(row);
        });
    }
    
    async loadOverallStats() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch('../../api/assessment/assessment-balances-management.php?action=stats', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success) {
                const stats = response.stats || {};
                const set = (id, val) => { 
                    const el = document.getElementById(id); 
                    if (el) {
                        el.textContent = String(val || 0); 
                    }
                };
                
                set('statTotalStudents', Number(stats.totalStudents || 0));
                set('statSchoolYears', Number(stats.periodicSummaries || 0));
            }
        } catch (error) {
            console.error('Error loading overall stats:', error);
        }
    }

    bindEvents() {
        const sySelect = document.getElementById('filterSchoolYear');
        const semesterSelect = document.getElementById('filterSemester');
        const periodSelect = document.getElementById('filterPeriod');
        const searchInput = document.getElementById('searchBalances');
        const refreshBtn = document.getElementById('refreshBtn');
        const exportBtn = document.getElementById('exportBtn');
        const perPageSelect = document.getElementById('perPageSelect');

        // Bind stat card clicks
        const cardTotalStudents = document.getElementById('cardTotalStudents');
        const cardSchoolYears = document.getElementById('cardSchoolYears');

        if (cardTotalStudents) {
            cardTotalStudents.addEventListener('click', () => this.showTotalStudentsModal());
        }
        if (cardSchoolYears) {
            cardSchoolYears.addEventListener('click', () => this.showSchoolYearsModal());
        }

        if (sySelect) {
            sySelect.addEventListener('change', (e) => {
                this.filters.schoolYearId = e.target.value;
                this.currentPage = 1;
                this.loadBalances();
            });
        }
        [semesterSelect, periodSelect].forEach((select) => {
            if (!select) return;
            select.addEventListener('change', (e) => {
                if (select === semesterSelect) this.filters.semesterId = e.target.value;
                else this.filters.periodId = e.target.value;
                this.currentPage = 1;
                this.loadBalances();
            });
        });
        
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const searchValue = e.target.value.trim();
                searchTimeout = setTimeout(() => {
                    this.filters.search = searchValue;
                    this.currentPage = 1;
                    this.loadBalances();
                }, 300);
            });
        }
        
        // Mobile search
        const searchInputMobile = document.getElementById('searchBalancesMobile');
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
                    this.loadBalances();
                }, 300);
            });
        }
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const sySelectMobile = document.getElementById('filterSchoolYearMobile');
                const semesterSelectMobile = document.getElementById('filterSemesterMobile');
                const periodSelectMobile = document.getElementById('filterPeriodMobile');
                
                if (sySelectMobile) {
                    this.filters.schoolYearId = sySelectMobile.value;
                    // Sync with desktop filter
                    if (sySelect) sySelect.value = sySelectMobile.value;
                }
                if (semesterSelectMobile) {
                    this.filters.semesterId = semesterSelectMobile.value;
                    if (semesterSelect) semesterSelect.value = semesterSelectMobile.value;
                }
                if (periodSelectMobile) {
                    this.filters.periodId = periodSelectMobile.value;
                    if (periodSelect) periodSelect.value = periodSelectMobile.value;
                }
                
                // Close mobile dropdown
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
                
                this.currentPage = 1;
                this.loadBalances();
            });
        }
        
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                this.currentPage = 1;
                this.filters.schoolYearId = '';
                this.filters.semesterId = '';
                this.filters.periodId = '';
                this.filters.search = '';

                const sySelectMobile = document.getElementById('filterSchoolYearMobile');
                const searchInputMobile = document.getElementById('searchBalancesMobile');
                [sySelect, sySelectMobile].forEach(select => {
                    if (select) select.value = '';
                });
                [searchInput, searchInputMobile].forEach(input => {
                    if (input) input.value = '';
                });

                refreshBtn.disabled = true;
                try {
                    // Reload filter values first, then fetch an unfiltered first page.
                    await this.loadFilters();
                    await this.loadBalances();
                    await this.loadOverallStats();
                } finally {
                    refreshBtn.disabled = false;
                }
            });
        }
        
        const importExportBtn = document.getElementById('importExportBtn');
        if (importExportBtn) {
            importExportBtn.addEventListener('click', () => {
                this.showImportExportDialog();
            });
        }
        
        if (perPageSelect) {
            perPageSelect.addEventListener('change', (e) => {
                this.perPage = parseInt(e.target.value, 10);
                this.currentPage = 1;
                this.loadBalances();
            });
        }

        document.getElementById('balancePagination')?.addEventListener('click', (event) => {
            const page = Number(event.target.closest('button[data-page]')?.dataset.page);
            if (!Number.isInteger(page) || page < 1 || page > this.totalPages || page === this.currentPage) return;
            this.currentPage = page;
            this.loadBalances();
        });
        
        const downloadBalancesTemplateBtn = document.getElementById('downloadBalancesTemplateBtn');
        if (downloadBalancesTemplateBtn) {
            downloadBalancesTemplateBtn.addEventListener('click', () => {
                this.downloadBalancesTemplate();
            });
        }
        
        const importBalancesFileInput = document.getElementById('importBalancesFileInput');
        if (importBalancesFileInput) {
            importBalancesFileInput.addEventListener('change', (e) => {
                this.handleBalancesFileSelect(e);
            });
        }
        
        const confirmImportBalancesBtn = document.getElementById('confirmImportBalancesBtn');
        if (confirmImportBalancesBtn) {
            confirmImportBalancesBtn.addEventListener('click', () => {
                this.confirmBalancesImport();
            });
        }
    }
    
    setupModalEvents() {
        const submitBtn = document.getElementById('submitBalanceBtn');
        const modalEl = document.getElementById('balanceModal');
        
        if (submitBtn) {
            submitBtn.addEventListener('click', () => {
                this.submitBalance();
            });
        }

        if (modalEl) {
            modalEl.addEventListener('hidden.bs.modal', () => {
                this.isEditMode = false;
                this.presetStudentId = '';
                this.selectedStudentId = '';
                const balanceIdEl = document.getElementById('balanceId');
                if (balanceIdEl) balanceIdEl.value = '';
                this.setBalanceModalStudent({});
                this.applyScholarshipsToBalanceForm({});
            });
        }
        
        // Auto-calculate total balance and advice to pay
        const previousBalanceInput = document.getElementById('balancePreviousBalance');
        const currentBalanceInput = document.getElementById('balanceCurrentBalance');
        const totalBalanceInput = document.getElementById('balanceTotalBalance');
        const adviceToPayInput = document.getElementById('balanceAdviceToPay');
        
        if (previousBalanceInput && currentBalanceInput && totalBalanceInput && adviceToPayInput) {
            const calculateBalances = () => {
                const previous = parseFloat(previousBalanceInput.value || 0);
                const current = parseFloat(currentBalanceInput.value || 0);
                
                // Total Balance = Previous Balance + Current Balance
                totalBalanceInput.value = (previous + current).toFixed(2);
                
                // Advice to Pay = 100% Previous Balance + 75% Current Balance
                const adviceToPay = (previous * 1.0) + (current * 0.75);
                adviceToPayInput.value = adviceToPay.toFixed(2);
            };
            
            previousBalanceInput.addEventListener('input', calculateBalances);
            currentBalanceInput.addEventListener('input', calculateBalances);
        }
    }

    setBalanceModalStudent({ studentId = '', studentSchoolId = '', studentName = '', programName = '', yearLevelName = '' } = {}) {
        const hidden = document.getElementById('balanceStudentId');
        const display = document.getElementById('balanceStudentDisplay');
        if (hidden) hidden.value = studentId ? String(studentId) : '';
        if (display) {
            if (!studentId) {
                display.textContent = '—';
                return;
            }
            const idPart = studentSchoolId || studentId;
            const namePart = studentName || 'Student';
            const meta = [programName, yearLevelName].filter(Boolean).join(' · ');
            display.textContent = meta ? `${idPart} - ${namePart} (${meta})` : `${idPart} - ${namePart}`;
        }
    }

    applyScholarshipsToBalanceForm({ internal_scholarship_name: internalName = '', scholarship_name: legacyName = '', external_scholarship_names: externalNames = '' } = {}) {
        const internalDisplay = document.getElementById('balanceInternalScholarshipDisplay');
        const externalDisplay = document.getElementById('balanceExternalScholarshipsDisplay');
        if (internalDisplay) internalDisplay.textContent = String(internalName || legacyName || '').trim() || 'None';
        if (externalDisplay) externalDisplay.textContent = String(externalNames || '').trim() || 'None';
    }

    async loadBalances() {
        if (!this.permissions.view) {
            const tbody = document.querySelector('#balancesTable tbody');
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-3">You do not have permission to view balances</td></tr>';
            }
            this.total = 0;
            this.totalPages = 0;
            this.updatePagination();
            this.updateTotalCount();
            return;
        }
        try {
            const params = {
                page: this.currentPage,
                perPage: this.perPage
            };
            
            if (this.filters.schoolYearId) {
                params.schoolYearId = this.filters.schoolYearId;
            }
            if (this.filters.semesterId) params.semesterId = this.filters.semesterId;
            if (this.filters.periodId) params.periodId = this.filters.periodId;
            
            if (this.filters.search) {
                params.search = this.filters.search;
            }
            
            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => {
                if (params[key] !== '') {
                    qs.set(key, params[key]);
                }
            });
            
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            
            if (response.success) {
                this.balances = response.balances || [];
                this.currentPage = Number(response.pagination?.page || 1);
                this.perPage = Number(response.pagination?.perPage || this.perPage);
                this.total = Number(response.pagination?.total || 0);
                this.totalPages = Math.max(1, Number(response.pagination?.totalPages || 1));
                
                this.renderTable();
                this.updatePagination();
                this.updateTotalCount();
                // Don't update stats here - they should remain as overall stats
            }
        } catch (err) {
            console.error('Error loading balances:', err);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load balances. Please try again.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
        }
    }
    
    updateTotalCount() {
        const totalCount = document.getElementById('totalCount');
        if (totalCount) {
            totalCount.textContent = `${this.total} record${this.total !== 1 ? 's' : ''}`;
        }
    }
    
    updateStats() {
        // Calculate stats from all balances (not just current page)
        // For now, we'll calculate from current balances array and total
        let totalBalances = this.total || this.balances.length;
        let uniqueStudents = new Set();
        let activeBalances = 0;
        let uniqueSchoolYears = new Set();
        
        for (const balance of this.balances) {
            if (balance.balance_student_id) {
                uniqueStudents.add(balance.balance_student_id);
            }
            if (parseFloat(balance.balance_current_balance || 0) > 0) {
                activeBalances++;
            }
            if (balance.balance_sy_id || balance.sy_id) {
                uniqueSchoolYears.add(balance.balance_sy_id || balance.sy_id);
            }
        }
        
        const set = (id, val) => { 
            const el = document.getElementById(id); 
            if (el) {
                el.textContent = String(val || 0); 
            }
        };
        
        set('statTotalBalances', totalBalances);
        set('statTotalStudents', uniqueStudents.size || totalBalances);
        set('statActiveBalances', activeBalances);
        set('statSchoolYears', uniqueSchoolYears.size);
    }
    
    updatePagination() {
        const pageInfo = document.getElementById('pageInfo');
        
        if (pageInfo) {
            const start = this.total === 0 ? 0 : ((this.currentPage - 1) * this.perPage) + 1;
            const end = Math.min(this.currentPage * this.perPage, this.total);
            pageInfo.textContent = `Showing ${start} to ${end} of ${this.total} entries`;
        }
        
        this.renderPaginationButtons('balancePagination', this.currentPage, this.totalPages);
    }

    renderPaginationButtons(containerId, page, pages) {
        const container = document.getElementById(containerId);
        if (!container) return;
        if (pages <= 1) {
            container.innerHTML = '';
            return;
        }

        // Keep large balance histories usable without inserting thousands of buttons.
        const nearby = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
        const numbers = [...nearby].filter(number => number >= 1 && number <= pages).sort((a, b) => a - b);
        const numbered = [];
        numbers.forEach((number, index) => {
            if (index && number > numbers[index - 1] + 1) {
                numbered.push('<span class="balance-pagination-ellipsis" aria-hidden="true">…</span>');
            }
            numbered.push(`<button type="button" class="btn btn-sm ${number === page ? 'btn-success' : 'btn-outline-secondary'}" data-page="${number}" ${number === page ? 'aria-current="page"' : ''}>${number}</button>`);
        });
        container.innerHTML = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>${numbered.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
    }

    renderTable() {
        const tbody = document.querySelector('#balancesTable tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        if (this.balances.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${this.permissions.delete ? 12 : 11}" class="text-center text-muted py-3">No balances found</td></tr>`;
            this.updateBalanceBulkDeleteControls();
            return;
        }

        const fmtPeso = (val) => {
            const num = Number(val || 0);
            return '₱' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };
        const fmtDate = (val) => val ? new Date(val).toLocaleDateString() : '';

        this.balances.forEach(balance => {
            const actionsMarkup = balanceRowActions({
                canEdit: this.permissions.edit,
                canDelete: this.permissions.delete,
            });

            const row = document.createElement('tr');
            row.setAttribute('data-balance-id', balance.balance_id);
            row.classList.add('finance-balance-row-clickable');
            const balanceId = Number(balance.balance_id || 0);
            const selectionCell = this.permissions.delete
                ? `<td class="text-center balance-selection-cell" data-label="Select">
                    <input class="form-check-input balance-select-checkbox" type="checkbox" data-balance-id="${balanceId}" aria-label="Select balance for ${escapeHtml(balance.student_school_id || balance.student_name || 'student')}"${this.selectedBalanceIds.has(balanceId) ? ' checked' : ''}>
                </td>`
                : '';
            row.innerHTML = `
                ${selectionCell}
                <td class="text-center finance-mobile-card-header" data-label="Student ID">
                    <span class="finance-card-primary">${escapeHtml(balance.student_school_id || '-')}</span>
                    <span class="finance-card-secondary">${escapeHtml(balance.student_name || '-')}</span>
                </td>
                <td class="text-center finance-mobile-name-cell" data-label="Student Name">${escapeHtml(balance.student_name || '-')}</td>
                <td class="text-center" data-label="School Year">${escapeHtml(balance.sy_code || '-')}</td>
                <td class="text-center" data-label="Semester">${escapeHtml(balance.semester_name || '-')}</td>
                <td class="text-center" data-label="Period">${escapeHtml(balance.app_period_name || '-')}</td>
                <td class="text-center" data-label="Total Balance">${fmtPeso(balance.balance_total_balance)}</td>
                <td class="text-center" data-label="Advised to Pay">${fmtPeso(balance.balance_advice_to_pay)}</td>
                <td class="text-center" data-label="Internal Scholarship">${escapeHtml(balance.internal_scholarship_code || 'None')}</td>
                <td class="text-center" data-label="External Scholarships">${escapeHtml(balance.external_scholarship_codes || 'None')}</td>
                <td class="text-center" data-label="As of Date">${fmtDate(balance.balance_as_of_date)}</td>
                <td class="text-center" data-label="Actions">
                    ${actionsMarkup}
                </td>
            `;
            tbody.appendChild(row);
        });
        this.updateBalanceBulkDeleteControls();
    }
    
    bindTableActions() {
        const tbody = document.querySelector('#balancesTable tbody');
        if (!tbody || tbody.hasAttribute('data-actions-bound')) return;
        tbody.setAttribute('data-actions-bound', 'true');
        if (this.debugActions) {
            console.log('[Balances Debug] bindTableActions attached');
        }

        tbody.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            if (target.closest('.balance-select-checkbox')) return;
            const tr = target.closest('tr');
            if (!tr) return;
            const balanceId = parseInt(tr.getAttribute('data-balance-id'));
            if (!balanceId) return;
            if (this.debugActions) {
                console.log('[Balances Debug] tbody click:', {
                    targetClass: target.className,
                    clickedEdit: !!target.closest('.action-edit'),
                    clickedDelete: !!target.closest('.action-delete'),
                    balanceId: balanceId
                });
            }
            
            // Handle edit action
            if (target.closest('.action-edit')) {
                ev.preventDefault();
                if (!this.permissions.edit) return;
                if (this.debugActions) console.log('[Balances Debug] edit action fired:', balanceId);
                this.openModal(balanceId);
                return;
            }
            
            // Handle delete action
            if (target.closest('.action-delete')) {
                ev.preventDefault();
                if (!this.permissions.delete) return;
                if (this.debugActions) console.log('[Balances Debug] delete action fired:', balanceId);
                this.deleteBalance(balanceId);
                return;
            }

            // Ignore clicks on action controls
            if (target.closest(`${INLINE_ACTION_IGNORE}, .action-edit, .action-delete`)) {
                return;
            }

            // Row click -> open details modal
            if (!this.permissions.view) return;
            this.viewBalanceDetails(balanceId);
        });
    }
    
    openModal(balanceId = null, presetStudentId = null) {
        if (balanceId && !this.permissions.edit) {
            rbacUtil.requireModulePermission(false, 'edit balances');
            return;
        }
        if (!balanceId && !this.permissions.create) {
            rbacUtil.requireModulePermission(false, 'add balances');
            return;
        }

        const modal = new bootstrap.Modal(document.getElementById('balanceModal'));
        const form = document.getElementById('balanceForm');
        const title = document.getElementById('balanceModalTitle');
        const submitBtn = document.getElementById('submitBalanceBtn');
        const balanceIdEl = document.getElementById('balanceId');
        const requestToken = ++this.modalRequestToken;
        
        if (form) form.reset();
        document.querySelectorAll('#balancePeriodId option[data-inactive-period]').forEach(option => option.remove());
        this.isEditMode = !!balanceId;
        this.presetStudentId = presetStudentId ? String(presetStudentId) : '';
        this.selectedStudentId = this.presetStudentId;
        if (balanceIdEl) balanceIdEl.value = '';
        if (title) title.textContent = balanceId ? 'Edit Balance' : 'Add Balance';
        if (submitBtn) submitBtn.textContent = balanceId ? 'Update' : 'Save';
        this.setBalanceModalStudent({});
        this.applyScholarshipsToBalanceForm({});

        if (this.presetStudentId) {
            const pendingRow = (this.pendingFinanceStudents || []).find((s) => String(s.student_id) === this.presetStudentId);
            this.setBalanceModalStudent({
                studentId: this.presetStudentId,
                studentSchoolId: pendingRow?.student_school_id,
                studentName: pendingRow?.student_name,
                programName: pendingRow?.program_name,
                yearLevelName: pendingRow?.year_level_name
            });
            this.applyScholarshipsToBalanceForm(pendingRow || {});
        }
        
        if (balanceId) {
            this.loadBalanceDetails(balanceId, requestToken).then(() => {
                // Ignore stale edit requests if a newer modal open happened.
                if (requestToken !== this.modalRequestToken) return;
                modal.show();
            });
        } else {
            modal.show();
        }
    }
    
    async loadBalanceDetails(balanceId, requestToken = null) {
        try {
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?action=details&balanceId=${balanceId}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (requestToken !== null && requestToken !== this.modalRequestToken) return;
            
            if (response.success && response.balance) {
                const balance = response.balance;
                document.getElementById('balanceId').value = balance.balance_id;
                const selectedStudentId = String(balance.balance_student_id || balance.student_id || '');
                this.selectedStudentId = selectedStudentId;
                this.setBalanceModalStudent({
                    studentId: selectedStudentId,
                    studentSchoolId: balance.student_school_id,
                    studentName: balance.student_name
                });
                this.applyScholarshipsToBalanceForm(balance);
                
                document.getElementById('balanceSchoolYearId').value = balance.balance_sy_id;
                const periodSelect = document.getElementById('balancePeriodId');
                const periodId = String(balance.balance_period_id || '');
                if (periodId && !Array.from(periodSelect.options).some(option => option.value === periodId)) {
                    const option = document.createElement('option');
                    option.value = periodId;
                    option.textContent = `${balance.app_period_name || 'Previous period'} (Inactive)`;
                    option.dataset.inactivePeriod = 'true';
                    periodSelect.appendChild(option);
                }
                periodSelect.value = periodId;
                document.getElementById('balanceTotalBalance').value = balance.balance_total_balance || 0;
                document.getElementById('balancePreviousBalance').value = balance.balance_previous_balance || 0;
                document.getElementById('balanceCurrentBalance').value = balance.balance_current_balance || 0;
                document.getElementById('balanceAdviceToPay').value = balance.balance_advice_to_pay || 0;
            }
        } catch (err) {
            console.error('Error loading balance details:', err);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load balance details.',
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000
            });
        }
    }
    
    editBalance(balanceId) {
        this.openModal(balanceId);
    }

    
    async submitBalance() {
        const form = document.getElementById('balanceForm');
        const studentId = document.getElementById('balanceStudentId')?.value || '';
        if (!studentId) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Student required',
                text: 'Open Add Balance from a pending student row.',
                confirmButtonText: 'OK'
            });
            return;
        }
        if (!form || !form.checkValidity()) {
            form.reportValidity();
            return;
        }
        
        const balanceId = document.getElementById('balanceId').value;
        const action = balanceId ? 'update' : 'create';
        
        const data = {
            action: action,
            studentId: studentId,
            schoolYearId: document.getElementById('balanceSchoolYearId').value,
            periodId: document.getElementById('balancePeriodId').value,
            totalBalance: document.getElementById('balanceTotalBalance').value,
            previousBalance: document.getElementById('balancePreviousBalance').value,
            currentBalance: document.getElementById('balanceCurrentBalance').value,
            adviceToPay: document.getElementById('balanceAdviceToPay').value
        };
        
        if (balanceId) {
            data.balanceId = balanceId;
        }
        
        try {
            // eslint-disable-next-line no-undef
            const swal = window.Swal;
            if (!swal) return;
            
            const res = await ApiService.post('/assessment/assessment-balances-management.php', data);
            
            if (res.success) {
                const modal = bootstrap.Modal.getInstance(document.getElementById('balanceModal'));
                if (modal) modal.hide();

                const successTitle = action === 'create' ? 'Balance Added' : 'Balance Updated';
                swal.fire({
                    icon: 'success',
                    title: successTitle,
                    text: res.message || (action === 'create' ? 'Balance added successfully.' : 'Balance updated successfully.'),
                    confirmButtonText: 'OK'
                });

                await this.loadBalances();
                if (action === 'create') {
                    await this.loadFilters();
                }
            } else {
                throw new Error(res.message || 'Failed to save balance');
            }
        } catch (err) {
            console.error('Error saving balance:', err);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: err.message || 'Failed to save balance. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }
    
    async deleteBalance(balanceId) {
        if (!this.permissions.delete) {
            rbacUtil.requireModulePermission(false, 'delete balances');
            return;
        }
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        
        const result = await swal.fire({
            icon: 'warning',
            title: 'Delete Balance',
            text: 'Are you sure you want to delete this balance record? This action cannot be undone.',
            showCancelButton: true,
            confirmButtonText: 'Yes, delete it',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc3545'
        });
        
        if (!result.isConfirmed) return;
        
        try {
            const res = await ApiService.post('/assessment/assessment-balances-management.php', {
                action: 'delete',
                balanceId: balanceId
            });
            
            if (res.success) {
                this.selectedBalanceIds.delete(Number(balanceId));
                swal.fire({
                    icon: 'success',
                    title: 'Balance Deleted',
                    text: res.message || 'Balance record deleted successfully.',
                    confirmButtonText: 'OK'
                });
                
                await this.loadBalances();
            } else {
                throw new Error(res.message || 'Failed to delete balance');
            }
        } catch (err) {
            console.error('Error deleting balance:', err);
            swal.fire({
                icon: 'error',
                title: 'Error',
                text: err.message || 'Failed to delete balance. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }
    
    async showTotalBalancesModal() {
        try {
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const balances = response.balances || [];
            const tbody = document.getElementById('totalBalancesModalTableBody');
            if (!tbody) return;
            
            if (balances.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No balance records</td></tr>';
            } else {
                tbody.innerHTML = balances.map(balance => `
                    <tr>
                        <td>${escapeHtml(balance.student_school_id)}</td>
                        <td>${escapeHtml(balance.student_name)}</td>
                        <td>${escapeHtml(balance.sy_code || '-')}</td>
                        <td>₱${parseFloat(balance.balance_total_balance || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td>₱${parseFloat(balance.balance_current_balance || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    </tr>
                `).join('');
            }
            this.updateCardModalCount('totalBalancesModal', balances.length);
            
            const modal = new bootstrap.Modal(document.getElementById('totalBalancesModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading total balances:', error);
            this.setCardModalCountMessage('totalBalancesModal', 'Unable to load records');
        }
    }

    async showTotalStudentsModal() {
        try {
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const balances = response.balances || [];
            const tbody = document.getElementById('totalStudentsModalTableBody');
            if (!tbody) return;
            
            if (balances.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No students with balances</td></tr>';
            } else {
                tbody.innerHTML = balances.map(balance => `
                    <tr>
                        <td>${escapeHtml(balance.student_school_id)}</td>
                        <td>${escapeHtml(balance.student_name)}</td>
                        <td>${escapeHtml(balance.sy_code || '-')}</td>
                        <td>₱${parseFloat(balance.balance_total_balance || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    </tr>
                `).join('');
            }
            this.updateCardModalCount('totalStudentsModal', balances.length, 'students');
            
            const modal = new bootstrap.Modal(document.getElementById('totalStudentsModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading students:', error);
            this.setCardModalCountMessage('totalStudentsModal', 'Unable to load records');
        }
    }

    async showActiveBalancesModal() {
        try {
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const balances = (response.balances || []).filter(b => parseFloat(b.balance_current_balance || 0) > 0);
            const tbody = document.getElementById('activeBalancesModalTableBody');
            if (!tbody) return;
            
            if (balances.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No active balances</td></tr>';
            } else {
                tbody.innerHTML = balances.map(balance => `
                    <tr>
                        <td>${escapeHtml(balance.student_school_id)}</td>
                        <td>${escapeHtml(balance.student_name)}</td>
                        <td>${escapeHtml(balance.sy_code || '-')}</td>
                        <td>₱${parseFloat(balance.balance_total_balance || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td>₱${parseFloat(balance.balance_current_balance || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    </tr>
                `).join('');
            }
            this.updateCardModalCount('activeBalancesModal', balances.length, 'active balances');
            
            const modal = new bootstrap.Modal(document.getElementById('activeBalancesModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading active balances:', error);
            this.setCardModalCountMessage('activeBalancesModal', 'Unable to load records');
        }
    }

    async showSchoolYearsModal() {
        try {
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?page=1&perPage=1000`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            if (!response.success) throw new Error(response.message);
            
            const balances = response.balances || [];
            const syMap = new Map();
            
            balances.forEach(balance => {
                const syCode = balance.sy_code || 'Unknown';
                const semester = balance.semester_name || 'Unknown Semester';
                const period = balance.app_period_name || 'Unknown Period';
                const key = [syCode, semester, period].join('|');
                const yearParts = String(syCode).match(/20(\d{2}).*?20(\d{2})/);
                const compactSchoolYear = yearParts ? `SY${yearParts[1]}${yearParts[2]}` : syCode;
                if (!syMap.has(key)) {
                    syMap.set(key, { code: `${compactSchoolYear} ${semester}`, period, students: new Set(), totalBalance: 0 });
                }
                const summary = syMap.get(key);
                summary.students.add(balance.balance_student_id || balance.student_id);
                summary.totalBalance += parseFloat(balance.balance_total_balance || 0);
            });
            
            const tbody = document.getElementById('schoolYearsModalTableBody');
            if (!tbody) return;
            syMap.forEach((summary) => { summary.count = summary.students.size; });
            
            if (syMap.size === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No periodic summary available</td></tr>';
            } else {
                tbody.innerHTML = Array.from(syMap.entries()).map(([syId, data]) => `
                    <tr>
                        <td>${escapeHtml(data.code)}</td>
                        <td>${escapeHtml(data.period)}</td>
                        <td>${data.count}</td>
                        <td>₱${data.totalBalance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    </tr>
                `).join('');
            }
            this.updateCardModalCount('schoolYearsModal', syMap.size, 'periods');
            
            const modal = new bootstrap.Modal(document.getElementById('schoolYearsModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading school years:', error);
            this.setCardModalCountMessage('schoolYearsModal', 'Unable to load records');
        }
    }

    updateCardModalCount(modalId, count, label = 'records') {
        const counter = document.querySelector(`#${modalId} [data-card-modal-count]`);
        if (!counter) return;
        counter.textContent = count === 0
            ? 'No records'
            : `Showing ${count} ${count === 1 ? label.replace(/s$/, '') : label}`;
    }

    setCardModalCountMessage(modalId, message) {
        const counter = document.querySelector(`#${modalId} [data-card-modal-count]`);
        if (counter) counter.textContent = message;
    }
    
    async exportBalances() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        
        try {
            const params = {
                page: 1,
                perPage: 100
            };
            
            if (this.filters.schoolYearId) {
                params.schoolYearId = this.filters.schoolYearId;
            }
            if (this.filters.semesterId) params.semesterId = this.filters.semesterId;
            if (this.filters.periodId) params.periodId = this.filters.periodId;
            
            if (this.filters.search) {
                params.search = this.filters.search;
            }
            
            const qs = new URLSearchParams();
            Object.keys(params).forEach(key => {
                if (params[key] !== '') {
                    qs.set(key, params[key]);
                }
            });
            
            const exportBalances = [];
            for (let page = 1; ; page += 1) {
                qs.set('page', String(page));
                const res = await fetch(`../../api/assessment/assessment-balances-management.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
                const response = await res.json();
                if (!response.success || !Array.isArray(response.balances)) {
                    throw new Error('Failed to fetch balance data for export');
                }
                exportBalances.push(...response.balances);
                if (page >= Number(response.pagination?.totalPages || 1)) break;
            }
            
            const result = await swal.fire({
                title: 'Export Balances',
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
            
            const rows = exportBalances.map(b => ({
                'Student ID': b.student_school_id || '',
                'Student Name': b.student_name || '',
                'School Year': b.sy_code || '',
                'Period': b.app_period_name || '',
                'Total Balance': parseFloat(b.balance_total_balance || 0).toFixed(2),
                'Previous Balance': parseFloat(b.balance_previous_balance || 0).toFixed(2),
                'Current Balance': parseFloat(b.balance_current_balance || 0).toFixed(2),
                'Advice to Pay': parseFloat(b.balance_advice_to_pay || 0).toFixed(2),
                'As of Date': b.balance_as_of_date || '',
                'Internal Scholarship': b.internal_scholarship_name || '',
                'External Scholarships': b.external_scholarship_names || ''
            }));
            
            if (rows.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No balances found to export.',
                    confirmButtonText: 'OK'
                });
                return;
            }
            
            const choice = result.value;
            
            if (choice === 'csv') {
                const headers = BALANCE_CSV_HEADERS;
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
                const bom = '\uFEFF';
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `finance_balances_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }
            
            if (choice === 'xls') {
                const headers = BALANCE_CSV_HEADERS;
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
                this.downloadBlob(blob, `finance_balances_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }
            
            if (choice === 'doc') {
                const headers = BALANCE_CSV_HEADERS;
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<html><body><table style="border-collapse:collapse;width:100%;">${th}${trs}</table></body></html>`;
                const blob = new Blob([html], { type: 'application/msword' });
                this.downloadBlob(blob, `finance_balances_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }
            
            if (choice === 'pdf') {
                // Professional PDF export using HTML print
                const now = new Date();
                const dateStr = now.toLocaleDateString();
                const timeStr = now.toLocaleTimeString();
                
                // Build table from rows
                const headers = BALANCE_CSV_HEADERS;
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
    <title>Assessment Balance Records Export</title>
    <style>
        @media print {
            @page { size: landscape; margin: 15mm; }
            body { margin: 0; }
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: 9px;
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
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 5px;
            text-align: center;
            font-size: 8px;
        }
        th {
            background-color: #198754;
            color: white;
            font-weight: 600;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
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
        <div class="office-title">Assessment Office - Balance Records</div>
        <div class="report-title">Balance Records Export</div>
        <div class="metadata">Generated on ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)} | Total Records: ${rows.length}</div>
    </div>
    <table>
        <thead>
            <tr>${thCells}</tr>
        </thead>
        <tbody>
            ${bodyRows}
        </tbody>
    </table>
    <div class="footer">
        <p>&copy; ${now.getFullYear()} Student Financial Assistance System. All rights reserved.</p>
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
        } catch (err) {
            console.error('Error exporting balances:', err);
            swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to export balances. Please try again.',
                confirmButtonText: 'OK'
            });
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
    
    async showImportExportDialog() {
        const swal = window.Swal;
        if (!swal) return;

        const result = await swal.fire({
            title: 'Import or Export',
            text: 'Choose an action to continue',
            icon: 'question',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: '<i class="bi bi-upload me-1"></i>Import',
            denyButtonText: '<i class="bi bi-download me-1"></i>Export',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#03600f',
            denyButtonColor: '#03600f',
            cancelButtonColor: '#6c757d',
            buttonsStyling: true,
            reverseButtons: true
        });

        if (result.isConfirmed) {
            this.openImportModal();
        } else if (result.isDenied) {
            this.exportBalances();
        }
    }
    
    openImportModal() {
        const modal = document.getElementById('importBalancesModal');
        if (!modal) return;
        const m = bootstrap.Modal.getOrCreateInstance(modal);
        m.show();
        this.resetImportForm();
    }
    
    resetImportForm() {
        const fileInput = document.getElementById('importBalancesFileInput');
        const preview = document.getElementById('importBalancesPreview');
        const result = document.getElementById('importBalancesResult');
        const confirmBtn = document.getElementById('confirmImportBalancesBtn');

        if (fileInput) fileInput.value = '';
        if (preview) preview.style.display = 'none';
        if (result) result.innerHTML = '';
        if (confirmBtn) confirmBtn.style.display = 'none';
    }
    
    downloadBalancesTemplate() {
        const csv = BALANCE_CSV_HEADERS.join(',') + '\n';
        const bom = '\uFEFF';
        this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), 'balances_import_template.csv');
    }
    
    async handleBalancesFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (file.size > MAX_BALANCE_IMPORT_BYTES) {
            event.target.value = '';
            await window.Swal?.fire({
                icon: 'error',
                title: 'File Too Large',
                text: 'The balance CSV must be 250 MB or smaller.',
                confirmButtonText: 'OK'
            });
            return;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('action', 'import');
        const importStartedAt = Date.now();
        let elapsedTimer = null;
        const stopElapsedTimer = () => {
            if (elapsedTimer !== null) {
                window.clearInterval(elapsedTimer);
                elapsedTimer = null;
            }
        };
        
        try {
            const swal = window.Swal;
            if (!swal) return;
            
            swal.fire({
                title: 'Importing...',
                html: `
                    <div>Please wait while we process your file</div>
                    <div class="progress mt-3" style="height: 20px;" role="progressbar" aria-label="Estimated balance import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="1">
                        <div id="balanceImportProgress" class="progress-bar progress-bar-striped progress-bar-animated bg-success" style="width: 1%; min-width: 2.5rem;">1%</div>
                    </div>
                    <div class="small text-muted mt-1">Estimated progress while the server processes the file</div>
                    <div class="small text-muted mt-2" id="balanceImportElapsed">Elapsed time: 00:00</div>
                `,
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    swal.showLoading();
                    const updateElapsed = () => {
                        const elapsedMs = Date.now() - importStartedAt;
                        const elapsed = Math.floor(elapsedMs / 1000);
                        const elapsedElement = document.getElementById('balanceImportElapsed');
                        if (elapsedElement) {
                            elapsedElement.textContent = `Elapsed time: ${formatImportElapsed(elapsed)}`;
                        }
                        const percent = Math.min(99, 1 + Math.floor(98 * (1 - Math.exp(-elapsedMs / 20000))));
                        const bar = document.getElementById('balanceImportProgress');
                        if (bar) {
                            bar.style.width = `${percent}%`;
                            bar.textContent = `${percent}%`;
                            bar.parentElement.setAttribute('aria-valuenow', String(percent));
                        }
                    };
                    updateElapsed();
                    elapsedTimer = window.setInterval(updateElapsed, 200);
                }
            });
            
            const response = await ApiService.postFormData('/assessment/assessment-balances-management.php', formData);
            stopElapsedTimer();
            const totalElapsedSeconds = (Date.now() - importStartedAt) / 1000;
            
            if (response.success) {
                const bar = document.getElementById('balanceImportProgress');
                if (bar) {
                    bar.style.width = '100%';
                    bar.textContent = '100%';
                    bar.parentElement.setAttribute('aria-valuenow', '100');
                }
                await new Promise(resolve => window.setTimeout(resolve, 300));
                swal.close();
                const preview = document.getElementById('importBalancesPreview');
                const result = document.getElementById('importBalancesResult');
                const skipped = Number(response.skipped || 0);
                const imported = Number(response.imported || 0);
                const omittedErrors = Number(response.errorsOmitted || 0);
                const reasons = Object.entries(response.errorReasons || {});
                const reasonList = reasons.length > 0
                    ? `<ul class="mb-0 small">${reasons.map(([reason, count]) => `<li>${escapeHtml(reason)}: ${Number(count).toLocaleString()} row(s)</li>`).join('')}</ul>`
                    : '';
                
                if (preview && result) {
                    let html = `
                        <div class="alert ${skipped > 0 ? 'alert-warning' : 'alert-success'}">
                            <strong>${skipped > 0 ? 'Import completed with skipped rows' : 'Import complete'}</strong><br>
                            ${imported.toLocaleString()} balance(s) imported<br>
                            ${skipped.toLocaleString()} balance(s) skipped<br>
                            Elapsed time: ${formatImportElapsed(totalElapsedSeconds)}
                        </div>
                    `;
                    if (reasonList) {
                        html += `<div class="alert alert-warning"><strong>Why rows were skipped:</strong>${reasonList}</div>`;
                    }
                    if (response.errors && response.errors.length > 0) {
                        html += `
                            <div class="alert alert-warning">
                                <strong>Row errors (CSV line numbers):</strong>
                                <ul class="mb-0 small" style="max-height: 18rem; overflow-y: auto;">
                                    ${response.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('')}
                                </ul>
                                ${omittedErrors > 0 ? `<div class="small mt-2">${omittedErrors.toLocaleString()} additional row error(s) are not listed here; all are included in the counts above.</div>` : ''}
                            </div>
                        `;
                    }
                    
                    result.innerHTML = html;
                    preview.style.display = 'block';
                }
                
                await swal.fire({
                    icon: skipped > 0 ? 'warning' : 'success',
                    title: skipped > 0 ? 'Import completed with skipped rows' : 'Import Complete',
                    html: `${imported.toLocaleString()} imported; ${skipped.toLocaleString()} skipped.${skipped > 0 ? '<br>See the import summary for the affected CSV rows and reasons.' : ''}<br><small class="text-muted">Elapsed time: ${formatImportElapsed(totalElapsedSeconds)}</small>`,
                    confirmButtonText: 'OK'
                });
                
                // Reload balances
                await this.loadBalances();
                await this.loadOverallStats();
                await this.loadFilters();
                
                // Keep row errors visible until the user closes the import modal.
                if (skipped === 0) {
                    const modal = bootstrap.Modal.getInstance(document.getElementById('importBalancesModal'));
                    if (modal) modal.hide();
                }
            } else {
                throw new Error(response.message || 'Import failed');
            }
        } catch (err) {
            stopElapsedTimer();
            console.error('Error importing balances:', err);
            const swal = window.Swal;
            if (swal) {
                swal.fire({
                    icon: 'error',
                    title: 'Import Failed',
                    text: err.response?.data?.message || err.message || 'Failed to import balances. Please try again.',
                    confirmButtonText: 'OK'
                });
            }
        }
    }
    
    confirmBalancesImport() {
        // This method is kept for compatibility but import happens immediately on file select
        const modal = bootstrap.Modal.getInstance(document.getElementById('importBalancesModal'));
        if (modal) modal.hide();
    }
    
    async viewBalanceDetails(balanceId) {
        try {
            const res = await fetch(`../../api/assessment/assessment-balances-management.php?action=details&balanceId=${balanceId}`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            const response = await res.json();
            
            if (!response.success || !response.balance) {
                throw new Error(response.message || 'Failed to load balance details');
            }
            
            const balance = response.balance;
            const fmtPeso = (val) => {
                const num = Number(val || 0);
                return '₱' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            };
            const fmtDate = (val) => val ? new Date(val).toLocaleDateString() : '-';
            const fmtDateTime = (val) => val ? new Date(val).toLocaleString() : '-';
            
            // Populate modal fields
            document.getElementById('viewStudentId').textContent = balance.student_school_id || '-';
            document.getElementById('viewStudentName').textContent = balance.student_name || '-';
            document.getElementById('viewSchoolYear').textContent = balance.sy_code || '-';
            document.getElementById('viewPeriod').textContent = balance.app_period_name || '-';
            document.getElementById('viewTotalBalance').textContent = fmtPeso(balance.balance_total_balance);
            document.getElementById('viewCurrentBalance').textContent = fmtPeso(balance.balance_current_balance);
            document.getElementById('viewPreviousBalance').textContent = fmtPeso(balance.balance_previous_balance);
            document.getElementById('viewAdviceToPay').textContent = fmtPeso(balance.balance_advice_to_pay);
            document.getElementById('viewInternalScholarship').textContent = balance.internal_scholarship_name || balance.scholarship_name || 'None';
            document.getElementById('viewExternalScholarships').textContent = balance.external_scholarship_names || 'None';
            document.getElementById('viewAsOfDate').textContent = fmtDate(balance.balance_as_of_date);
            document.getElementById('viewUpdatedAt').textContent = fmtDateTime(balance.balance_updated_at);
            
            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('viewBalanceModal'));
            modal.show();
        } catch (error) {
            console.error('Error loading balance details:', error);
            const swal = window.Swal;
            if (swal) {
                swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: 'Failed to load balance details. Please try again.',
                    confirmButtonText: 'OK'
                });
            }
        }
    }
}

export default FinanceBalancesManagementModule;
