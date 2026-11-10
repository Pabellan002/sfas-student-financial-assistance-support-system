import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261020-csdl-pn-tagging';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js?v=20260913-paid-partial-status';
import ApiService from '../../services/services-apiService.js';


class AssessmentPnTaggingModule {
    constructor() {
        this.office = 'assessment';
        this.officeName = 'Assessment';
        this.pnStep = 11;
        this.api = '../../api/assessment/assessment-pn-tagging.php';
        this.loanApi = '/assessment/assessment-loan-management.php';
        this.currentPage = 1;
        this.perPage = 10;
        this.filters = { period: '', semester: '', schoolYear: '', search: '', view: 'loanStatus', chartPeriod: '' };
        this.reports = [];
        this.total = 0;
        this.totalPages = 0;
        this.statusChart = null;
        this.periodChart = null;
        this.permissions = { view: false, export: false, tagPn: false };
        this.modalListView = null;
        this.modalLoanPage = 1;
        this.modalLoanPerPage = 25;
        this.modalLoanTotal = 0;
        this.modalLoanTotalPages = 0;
        this._loansModalPaginationBound = false;
    }

    async init() {
        await this.ensureSession();
        await this.loadPermissions();
        await this.loadFilters();
        this.setupEventListeners();
        this.bindStatCards();
        this.applyActionVisibility();
        await this.loadStats();
        await this.loadReports();
        const openLoan = Number(new URLSearchParams(window.location.search).get('openLoan') || 0);
        if (openLoan > 0) await this.viewLoan(openLoan);
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
                view: can(`${this.office}.pntagging.view`),
                export: can(`${this.office}.pntagging.export`),
                tagPn: can(`${this.office}.loans.tag_pn`)
            };
        } catch (error) {
            console.error('Error loading PN tagging permissions:', error);
        }
    }

    applyActionVisibility() {
        const exportBtn = document.getElementById('exportReportsBtn');
        if (exportBtn) exportBtn.style.display = this.permissions.export ? '' : 'none';
    }

    async loadFilters() {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`${this.api}?action=filters`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (!response.success) return;
            
            // Populate semester filters (desktop and mobile)
            const semesterSelect = document.getElementById('filterSemester');
            const semesterSelectMobile = document.getElementById('filterSemesterMobile');
            [semesterSelect, semesterSelectMobile].forEach(select => {
                if (select && response.semesters) {
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
                if (select && response.schoolYears) {
                    select.innerHTML = '<option value="">All School Years</option>';
                    response.schoolYears.forEach(sy => {
                        const option = document.createElement('option');
                        option.value = sy.sy_id;
                        option.textContent = sy.sy_name || sy.sy_code;
                        select.appendChild(option);
                    });
                }
            });
            
            // Populate period filters (desktop and mobile)
            const periodSelect = document.getElementById('filterPeriodReports');
            const periodSelectMobile = document.getElementById('filterPeriodReportsMobile');
            [periodSelect, periodSelectMobile].forEach(select => {
                if (select && response.periods) {
                    const first = select.querySelector('option[value=""]');
                    select.innerHTML = '';
                    if (first) select.appendChild(first);
                    else {
                        const opt = document.createElement('option');
                        opt.value = '';
                        opt.textContent = 'All Periods';
                        select.appendChild(opt);
                    }
                    response.periods.forEach((period) => {
                        const option = document.createElement('option');
                        option.value = period.app_period_id;
                        option.textContent = period.app_period_name;
                        select.appendChild(option);
                    });
                }
            });
            
            // Populate chart period filter
            const chartPeriodSelect = document.getElementById('filterPeriod');
            if (chartPeriodSelect && response.periods) {
                const first = chartPeriodSelect.querySelector('option[value=""]');
                chartPeriodSelect.innerHTML = '';
                if (first) chartPeriodSelect.appendChild(first);
                else {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = 'All Periods';
                    chartPeriodSelect.appendChild(opt);
                }
                response.periods.forEach((period) => {
                    const option = document.createElement('option');
                    option.value = period.app_period_id;
                    option.textContent = period.app_period_name;
                    chartPeriodSelect.appendChild(option);
                });
            }
        } catch (e) {
            console.error('Error loading filters:', e);
        }
    }

    async loadStats() {
        if (!this.permissions.view) return;
        try {
            const params = new URLSearchParams({
                action: 'stats',
                period: this.filters.period || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                search: this.filters.search || ''
            });
            const res = await fetch(`${this.api}?${params}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (!response.success) return;
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
            set('statPending', response.stats?.pending);
            set('statTagged', response.stats?.tagged);
        } catch (e) {
            console.error('Error loading stats:', e);
        }
    }

    async loadReports() {
        if (!this.permissions.view) {
            const tbody = document.getElementById('reportsTableBody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">You do not have permission to view PN Tagging.</td></tr>';
            return;
        }
        try {
            const params = new URLSearchParams({ 
                action: 'list', 
                period: this.filters.period || '', 
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                search: this.filters.search || '', 
                page: String(this.currentPage), 
                perPage: String(this.perPage) 
            });
            const res = await fetch(`${this.api}?${params}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (!response.success) throw new Error(response.message || 'Failed to load');
            this.reports = response.data || [];
            this.total = response.total || 0;
            this.totalPages = response.totalPages || 0;
            this.renderTable();
            this.updatePagination();
        } catch (e) {
            console.error('Error loading reports:', e);
            if (window.Swal) {
                Swal.fire({ icon: 'error', title: 'Error', text: e.message || 'Failed to load reports', confirmButtonText: 'OK' });
            }
        }
    }

    renderTable() {
        const tbody = document.getElementById('reportsTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (this.reports.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-5">No paid applications found for PN tagging.</td></tr>';
            return;
        }
        this.reports.forEach((report) => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.setAttribute('data-loan-id', String(report.loan_id ?? ''));
            const amt = parseFloat(report.loan_amount_can_pay || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const paymentStatus = report.payment_status || 'Not Paid';
            const paymentBadge = `<span class="badge ${this.getPaymentStatusBadgeClass(paymentStatus)}">${escapeHtml(paymentStatus)}</span>`;
            const waitingForTag = Number(report.loan_status_id) === 2 && Number(report.loan_current_step_id) === this.pnStep && !report.tagged_date;
            const isTagged = Number(report.loan_pn_status_id) === 2 || Number(report.loan_status_id) === 5
                || Boolean(report.tagged_date)
                || ['tagged', 'pn tagged'].includes(String(report.pn_status || '').trim().toLowerCase());
            let actionsHtml = '<span class="text-muted">-</span>';
            if (isTagged) {
                actionsHtml = '<span class="badge bg-success"><i class="bi bi-check-circle-fill me-1"></i>Tagged</span>';
            } else if (waitingForTag && this.permissions.tagPn) {
                actionsHtml = `<button type="button" class="inline-action-btn inline-action-btn--info action-pn-tag" data-loan-id="${report.loan_id}" title="Tag PN" aria-label="Tag PN"><i class="bi bi-journal-check"></i></button>`;
            }
            row.innerHTML = `
                <td class="text-center" data-label="Application No.">${escapeHtml(report.loan_application_no || '-')}</td>
                <td class="text-center" data-label="Student ID">${escapeHtml(report.student_school_id || '-')}</td>
                <td class="text-center" data-label="Student Name">${escapeHtml(report.student_name || '-')}</td>
                <td class="text-center" data-label="Amount Can Pay">&#8369;${amt}</td>
                <td class="text-center" data-label="Payment Status">${paymentBadge}</td>
                <td class="text-center" data-label="Period">${escapeHtml(report.app_period_name || '-')}</td>
                <td class="text-center" data-label="Paid Date">${escapeHtml(this.formatTaggedDate(report.paid_date))}</td>
                <td class="text-center" data-label="Tagged Date">${escapeHtml(this.formatTaggedDate(report.tagged_date))}</td>
                <td class="text-center assessment-actions-col" data-label="Actions"><span class="inline-row-actions">${actionsHtml}</span></td>
            `;
            row.addEventListener('click', (event) => {
                if (event.target.closest('.action-pn-tag')) return;
                const id = report.loan_id;
                if (id) this.viewLoan(id);
            });
            tbody.appendChild(row);
        });

        tbody.querySelectorAll('.action-pn-tag').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const loanId = Number(button.dataset.loanId || 0);
                if (loanId) this.tagPromissoryNote(loanId);
            });
        });
    }

    async tagPromissoryNote(loanId) {
        if (!this.permissions.tagPn) return;
        const report = this.reports.find((item) => Number(item.loan_id) === Number(loanId));
        if (!report || Number(report.loan_status_id) !== 2 || Number(report.loan_current_step_id) !== this.pnStep || report.tagged_date) return;

        const result = await Swal.fire({
            title: 'Tag PN',
            html: `<p class="mb-1">Tag the promissory note for <strong>${escapeHtml(report.student_name || 'this student')}</strong>?</p><small class="text-muted">${escapeHtml(report.loan_application_no || '')}</small>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Tag PN',
            confirmButtonColor: '#198754',
            cancelButtonText: 'Cancel'
        });
        if (!result.isConfirmed) return;

        try {
            const formData = new FormData();
            formData.append('action', 'tag_pn');
            formData.append('loanId', String(loanId));
            formData.append('pnStatus', 'Tagged');
            formData.append('remarks', 'PN tagged and student notified.');
            const response = await ApiService.postFormData(`/${this.office}/${this.office}-pn-tagging.php`, formData);
            if (!response.success) throw new Error(response.message || 'Failed to tag the PN');

            await Promise.all([this.loadStats(), this.loadReports()]);
            window.dispatchEvent(new Event('sidebar-live-counts:refresh'));
            await Swal.fire({
                icon: 'success',
                title: 'PN Tagged',
                text: response.message || 'The promissory note was tagged successfully.',
                confirmButtonText: 'OK'
            });
        } catch (error) {
            console.error('Error tagging PN:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to tag the PN' });
        }
    }

    formatTaggedDate(value) {
        if (!value) return '-';
        const raw = String(value).trim();
        const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
        const ts = Date.parse(normalized);
        if (!Number.isNaN(ts)) {
            return new Date(ts).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        }
        return raw;
    }

    getStatusBadgeClass(statusId) {
        const id = parseInt(statusId, 10);
        // Align with tbl_csdl_loan_statuses + csdl-reportsModule (id 2 = Approved ? green)
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

    getPNStatusBadgeClass(pnStatus) {
        const status = String(pnStatus || '').trim().toLowerCase();
        if (status === 'tagged' || status === 'pn tagged' || status === 'paid') return 'bg-success';
        if (status === 'partial payment') return 'bg-warning text-dark';
        return 'bg-info';
    }

    getPaymentStatusBadgeClass(paymentStatus) {
        if (paymentStatus === 'Paid') return 'bg-success';
        if (paymentStatus === 'Paid Pending') return 'bg-info text-dark';
        if (paymentStatus === 'Paid Partial') return 'bg-warning text-dark';
        if (paymentStatus === 'Partial Payment') return 'bg-warning text-dark';
        return 'bg-secondary';
    }

    async viewLoan(loanId) {
        if (!this.permissions.view) return;
        try {
            const res = await fetch(`../../api${this.loanApi}?action=details&loanId=${encodeURIComponent(loanId)}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const response = await res.json();
            if (!response.success) {
                throw new Error(response.message || 'Failed to load loan');
            }
            const loan = response.loan;
            const modalEl = document.getElementById('viewLoanModal');
            if (!modalEl) return;
            let modal = bootstrap.Modal.getInstance(modalEl);
            if (!modal) modal = new bootstrap.Modal(modalEl);
            const content = document.getElementById('loanDetailsContent');
            if (content) content.innerHTML = this.renderLoanDetails(loan);
            modal.show();
        } catch (error) {
            console.error('Error loading loan details:', error);
            if (window.Swal) {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: error.message || 'Failed to load loan details',
                    confirmButtonText: 'OK'
                });
            }
        }
    }

    renderLoanDetails(loan) {
        return renderModernLoanDetails(
            loan,
            (statusId) => this.getStatusBadgeClass(statusId),
            (loanObj) => loanObj.loan_status_name || '-',
            { showVerifyButton: false, moduleName: 'assessmentPnTaggingModule' }
        );
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
            this.loadReports();
        }));
    }

    initCharts() {
        const statusCtx = document.getElementById('statusChart');
        if (statusCtx && typeof Chart !== 'undefined') {
            this.statusChart = new Chart(statusCtx, {
                type: 'pie',
            data: { labels: ['Paid Applications'], datasets: [{ data: [0], backgroundColor: ['#198754'] }] },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: true,
                    plugins: { 
                        legend: { 
                            position: 'bottom',
                            labels: {
                                padding: 15
                            }
                        }
                    }
                }
            });
        }

        if (this.statusChart) this.updateStatusChart({ labels: ['Paid Applications'], values: [0] });
    }

    updateStatusChart(data) {
        if (!this.statusChart || !data) return;
        const labels = Array.isArray(data.labels) ? data.labels : [];
        const values = Array.isArray(data.values) ? data.values.map(v => Number(v) || 0) : [];
        const sum = values.reduce((a, b) => a + b, 0);
        const ds = this.statusChart.data.datasets[0];
        const palette = ['#198754', '#ffc107'];
        if (sum === 0 || labels.length === 0) {
            this.statusChart.data.labels = ['No data for this filter'];
            ds.data = [1];
            ds.backgroundColor = ['#e2e8f0'];
        } else {
            this.statusChart.data.labels = labels;
            ds.data = values;
            ds.backgroundColor = labels.map((_, i) => palette[i % palette.length]);
        }
        this.statusChart.update();
    }

    updatePeriodChart(data) {
        // Removed - no longer needed
    }
    
    async loadChartData() {
        // Removed - no longer needed
    }

    setupEventListeners() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };

        on('#filterSemester', 'change', (e) => {
            this.filters.semester = e.target.value;
            const mobile = document.getElementById('filterSemesterMobile');
            if (mobile) mobile.value = e.target.value;
            this.currentPage = 1;
            this.loadStats();
            this.loadReports();
        });
        on('#filterSchoolYear', 'change', (e) => {
            this.filters.schoolYear = e.target.value;
            const mobile = document.getElementById('filterSchoolYearMobile');
            if (mobile) mobile.value = e.target.value;
            this.currentPage = 1;
            this.loadStats();
            this.loadReports();
        });

        on('#filterPeriodReports', 'change', (e) => { 
            this.filters.period = e.target.value; 
            const mobile = document.getElementById('filterPeriodReportsMobile');
            if (mobile) mobile.value = e.target.value;
            this.currentPage = 1; 
            this.loadStats(); 
            this.loadReports(); 
        });

        let searchTimeout;
        on('#searchReports', 'input', (e) => {
            clearTimeout(searchTimeout);
            const searchValue = e.target.value.trim();
            searchTimeout = setTimeout(() => { 
                this.filters.search = searchValue; 
                this.currentPage = 1; 
                this.loadStats();
                this.loadReports(); 
                // Sync with mobile search
                const searchMobile = document.getElementById('searchReportsMobile');
                if (searchMobile) searchMobile.value = searchValue;
            }, 350);
        });
        
        // Mobile search input
        on('#searchReportsMobile', 'input', (e) => {
            clearTimeout(searchTimeout);
            const searchValue = e.target.value.trim();
            searchTimeout = setTimeout(() => { 
                this.filters.search = searchValue; 
                this.currentPage = 1; 
                this.loadStats();
                this.loadReports(); 
                // Sync with desktop search
                const searchDesktop = document.getElementById('searchReports');
                if (searchDesktop) searchDesktop.value = searchValue;
            }, 350);
        });
        
        // Apply mobile filters button
        on('#applyMobileFiltersBtn', 'click', () => {
            const semesterMobile = document.getElementById('filterSemesterMobile');
            const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
            const periodMobile = document.getElementById('filterPeriodReportsMobile');
            const semesterDesktop = document.getElementById('filterSemester');
            const schoolYearDesktop = document.getElementById('filterSchoolYear');
            const periodDesktop = document.getElementById('filterPeriodReports');
            
            // Sync mobile selections to desktop and filters
            if (semesterMobile && semesterDesktop) {
                semesterDesktop.value = semesterMobile.value;
                this.filters.semester = semesterMobile.value;
            }
            if (schoolYearMobile && schoolYearDesktop) {
                schoolYearDesktop.value = schoolYearMobile.value;
                this.filters.schoolYear = schoolYearMobile.value;
            }
            if (periodMobile && periodDesktop) {
                periodDesktop.value = periodMobile.value;
                this.filters.period = periodMobile.value;
            }
            
            this.currentPage = 1;
            this.loadStats();
            this.loadReports();
            
            // Close the dropdown
            const mobileFilterBtn = document.getElementById('mobileFilterBtn');
            if (mobileFilterBtn) {
                const dropdown = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                if (dropdown) dropdown.hide();
            }
        });

        on('#refreshReportsBtn', 'click', async () => {
            this.currentPage = 1;
            const periodSelect = document.getElementById('filterPeriodReports');
            const semesterSelect = document.getElementById('filterSemester');
            const schoolYearSelect = document.getElementById('filterSchoolYear');
            const searchInput = document.getElementById('searchReports');
            const searchInputMobile = document.getElementById('searchReportsMobile');
            
            if (periodSelect) { 
                periodSelect.value = ''; 
                this.filters.period = ''; 
            }
            if (semesterSelect) {
                semesterSelect.value = '';
                this.filters.semester = '';
            }
            if (schoolYearSelect) {
                schoolYearSelect.value = '';
                this.filters.schoolYear = '';
            }
            if (searchInput) { 
                searchInput.value = ''; 
                this.filters.search = ''; 
            }
            if (searchInputMobile) {
                searchInputMobile.value = '';
            }
            
            // Reset mobile filters
            const semesterMobile = document.getElementById('filterSemesterMobile');
            const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
            const periodMobile = document.getElementById('filterPeriodReportsMobile');
            if (semesterMobile) semesterMobile.value = '';
            if (schoolYearMobile) schoolYearMobile.value = '';
            if (periodMobile) periodMobile.value = '';
            
            await this.loadStats();
            await this.loadReports();
        });

        on('#exportReportsBtn', 'click', async () => {
            if (!rbacUtil.requireModulePermission(this.permissions.export, 'export PN tagging data')) {
                return;
            }
            const swal = window.Swal;
            if (!swal) return;
            
            const result = await swal.fire({
                title: 'Export Tagged Loans',
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
            
            await this.exportReports(result.value);
        });

        // Close mobile filter dropdown when sidebar opens
        this.setupMobileFilterClose();

        on('#perPageSelect', 'change', (e) => { this.perPage = parseInt(e.target.value, 10) || 25; this.currentPage = 1; this.loadReports(); });
    }

    async exportReports(format) {
        if (!this.permissions.export) return;
        const swal = window.Swal;
        if (!swal) return;

        try {
            // Fetch all reports with current filters
            const params = new URLSearchParams({
                action: 'list',
                period: this.filters.period || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                search: this.filters.search || '',
                page: '1',
                perPage: '100',
            });
            const exportData = [];
            for (let page = 1; ; page += 1) {
                params.set('page', String(page));
                const res = await fetch(`${this.api}?${params}`, { credentials: 'same-origin', cache: 'no-store' });
                const response = await res.json();
                if (!response.success || !Array.isArray(response.data)) {
                    throw new Error('Failed to fetch report data for export');
                }
                exportData.push(...response.data);
                if (page >= Number(response.totalPages || 1)) break;
            }

            const rows = exportData.map(r => ({
                'Application No': r.loan_application_no || '',
                'Student ID': r.student_school_id || '',
                'Student Name': r.student_name || '',
                'Amount': parseFloat(r.loan_amount_can_pay || 0).toFixed(2),
                'Payment Status': r.payment_status || 'Not Paid',
                'Paid Date': this.formatTaggedDate(r.paid_date),
                'Tagged Date': this.formatTaggedDate(r.tagged_date)
            }));

            if (rows.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No reports found to export.',
                    confirmButtonText: 'OK'
                });
                return;
            }

            if (format === 'csv') {
                const headers = Object.keys(rows[0] || {});
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
                const bom = '\uFEFF';
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `${this.office}_pn_tagging_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }

            if (format === 'xls') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
                this.downloadBlob(blob, `${this.office}_pn_tagging_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }

            if (format === 'doc') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<html><body><table style="border-collapse:collapse;width:100%;">${th}${trs}</table></body></html>`;
                const blob = new Blob([html], { type: 'application/msword' });
                this.downloadBlob(blob, `${this.office}_pn_tagging_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }

            if (format === 'pdf') {
                // Professional PDF export with enhanced HTML print design
                const headers = Object.keys(rows[0] || {});
                
                // Build filter summary
                const filterParts = [];
                const semesterSelect = document.getElementById('filterSemester') || document.getElementById('filterSemesterMobile');
                const schoolYearSelect = document.getElementById('filterSchoolYear') || document.getElementById('filterSchoolYearMobile');
                const periodSelect = document.getElementById('filterPeriodReports') || document.getElementById('filterPeriodReportsMobile');
                
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
                        <title>${this.officeName} PN Tagging Report</title>
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
                                    <h2>PN Tagging Report - ${this.officeName} Office</h2>
                                </div>
                                <div class="report-info">
                                    <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                    <div><strong>Office:</strong> ${this.officeName}</div>
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
        } catch (err) {
            console.error('Error exporting reports:', err);
            swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to export PN tagging data. Please try again.',
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

        if (this.modalLoanPage > 1) addBtn('Previous', this.modalLoanPage - 1);
        const maxBtns = 5;
        let from = Math.max(1, this.modalLoanPage - 2);
        let to = Math.min(this.modalLoanTotalPages, from + maxBtns - 1);
        if (to - from < maxBtns - 1) from = Math.max(1, to - maxBtns + 1);
        for (let i = from; i <= to; i++) addBtn(String(i), i, i === this.modalLoanPage);
        if (this.modalLoanPage < this.modalLoanTotalPages) addBtn('Next', this.modalLoanPage + 1);
    }

    async populateLoansListModal(view, page) {
        if (!this.permissions.view) return;
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

        let title = 'PN Tagging Applications';
        let paymentStatus = '';

        if (this.modalListView === 'pending') {
            title = 'Pending PN Tagging Applications';
        } else if (this.modalListView === 'tagged') {
            title = 'PN Tagged Applications';
        } else {
            return;
        }

        titleEl.textContent = title;
        const statusHeader = document.getElementById('loansModalStatusHeader');
        if (statusHeader) statusHeader.textContent = this.modalListView === 'tagged' ? 'PN Status' : 'Payment Status';
        const iconEl = document.getElementById('loansModalIcon');
        const icons = { pending: 'bi-hourglass-split', tagged: 'bi-journal-check' };
        if (iconEl) iconEl.className = `bi ${icons[this.modalListView] || 'bi-list-check'} me-2`;
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Loading...</td></tr>';

        try {
            const params = new URLSearchParams({
                action: 'list',
                page: String(this.modalLoanPage),
                perPage: String(this.modalLoanPerPage),
                period: this.filters.period || '',
                semester: this.filters.semester || '',
                schoolYear: this.filters.schoolYear || '',
                search: this.filters.search || ''
            });

            if (paymentStatus) params.set('paymentStatus', paymentStatus);
            if (this.modalListView === 'pending') params.set('pending', '1');
            if (this.modalListView === 'tagged') params.set('tagged', '1');

            const res = await fetch(`${this.api}?${params.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();

            const loans = response.success ? (response.data || []) : [];
            this.modalLoanTotal = response.success ? (parseInt(response.total, 10) || 0) : 0;
            this.modalLoanTotalPages = response.success ? (parseInt(response.totalPages, 10) || 0) : 0;

            if (!loans || loans.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No loans found</td></tr>`;
            } else {
                tbody.innerHTML = loans.map(loan => {
                    const paymentStatus = loan.payment_status || 'Not Paid';
                    const paymentStatusBadge = `<span class="badge ${this.getPaymentStatusBadgeClass(paymentStatus)}">${escapeHtml(paymentStatus)}</span>`;
                    const pnStatus = loan.tagged_date || Number(loan.loan_status_id) === 5
                        ? 'Tagged'
                        : (loan.pn_status || 'Not Tagged');
                    const pnStatusBadge = `<span class="badge ${this.getPNStatusBadgeClass(pnStatus)}">${escapeHtml(pnStatus)}</span>`;
                    const statusBadge = this.modalListView === 'tagged' ? pnStatusBadge : paymentStatusBadge;
                    return `
                        <tr>
                            <td class="text-center">${escapeHtml(loan.loan_application_no || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.student_school_id || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.student_name || '-')}</td>
                            <td class="text-center">&#8369;${parseFloat(loan.loan_amount_can_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="text-center">${statusBadge}</td>
                            <td class="text-center">${escapeHtml(this.formatTaggedDate(loan.paid_date))}</td>
                            <td class="text-center">${escapeHtml(this.formatTaggedDate(loan.tagged_date))}</td>
                        </tr>
                    `;
                }).join('');
            }

            this.updateLoansModalPaginationUI();
            this.loansListModal && this.loansListModal.show();
        } catch (error) {
            console.error('Error loading loans for modal:', error);
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error loading loans</td></tr>`;
            this.modalLoanTotal = 0;
            this.modalLoanTotalPages = 0;
            this.updateLoansModalPaginationUI();
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
}

export default AssessmentPnTaggingModule;
