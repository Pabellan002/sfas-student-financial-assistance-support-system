import AppPaths from '../../services/services-appPaths.js';
import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';

class CsdlDashboardModule {
    constructor() {
        this.chart = null;
        this.chartRequestSeq = 0;
        this.chartMetric = 'students';
        this.chartGroupLabel = 'Department';
        this.currentData = { labels: [], values: [] };
        this.allPrograms = [];
        this.filters = {
            schoolYear: '',
            campus: '',
            semester: '',
            period: '',
            department: '',
            program: '',
            yearLevel: '',
            modality: '',
            status: '',
            scholarship: '',
            approvalPeriod: ''
        };
        this.paginationData = {
            enrolledBreakdown: { currentPage: 1, totalPages: 1, allData: [] },
            applicants: { currentPage: 1, totalPages: 1, allData: [] },
            applications: { currentPage: 1, totalPages: 1, allData: [] },
            approved: { currentPage: 1, totalPages: 1, allData: [] },
            pending: { currentPage: 1, totalPages: 1, allData: [] }
        };
        this.recordsPerPage = 10;
    }

    async init() {
        this.placeMobileFilters();
        await this.ensureSession();
        this.updateForApprovalTimestamp();
        await this.loadFilters();
        this.initChart();
        this.bindFilterEvents();
        this.bindExport();
        this.bindModals();
        await this.refreshDashboard();
    }

    placeMobileFilters() {
        const sections = document.querySelector('.csdl-dashboard-sections');
        const filters = document.querySelector('.csdl-dashboard-section--filters');
        const chartSection = document.querySelector('.csdl-dashboard-section--chart');
        const chartActions = document.querySelector('.csdl-dashboard-chart-actions');
        if (!sections || !filters || !chartSection || !chartActions) return;

        const mobile = window.matchMedia('(max-width: 767.98px)');
        const place = () => {
            if (mobile.matches) {
                chartActions.after(filters);
                filters.classList.add('csdl-dashboard-filters-inline');
            } else {
                sections.insertBefore(filters, chartSection);
                filters.classList.remove('csdl-dashboard-filters-inline');
            }
            this.chart?.resize();
        };
        mobile.addEventListener('change', place);
        place();
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
    }

    updateForApprovalTimestamp() {
        const el = document.getElementById('forApprovalTimestamp');
        if (el) {
            el.textContent = new Date().toLocaleString(undefined, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
            });
        }
    }

    getBaseURL() {
        return AppPaths.apiBase;
    }

    syncFiltersFromDom() {
        const get = (id) => document.getElementById(id)?.value ?? '';
        this.filters.schoolYear = get('filterSchoolYear');
        this.filters.campus = get('filterCampus');
        this.filters.semester = get('filterSemester');
        this.filters.period = get('filterPeriod');
        this.filters.department = get('filterDepartment');
        this.filters.program = get('filterProgram');
        this.filters.yearLevel = get('filterYearLevel');
        this.filters.modality = get('filterModality');
        this.filters.status = get('filterStatus');
        this.filters.scholarship = get('filterScholarship');
        this.filters.approvalPeriod = get('filterApprovalPeriod');
    }

    buildQuery(extra = {}) {
        const params = new URLSearchParams();
        Object.entries(extra).forEach(([key, value]) => {
            if (value !== '' && value != null) params.set(key, value);
        });
        return params.toString();
    }

    buildChartFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, campus, semester, period, department, program, yearLevel, modality, status, scholarship } = this.filters;
        return this.buildQuery({
            schoolYear,
            campus,
            semester,
            period,
            department,
            program,
            yearLevel,
            modality,
            status,
            scholarship,
            ...extra
        });
    }

    buildLoanFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, campus, semester, period, modality, status, scholarship } = this.filters;
        return this.buildQuery({
            schoolYear,
            campus,
            semester,
            period,
            modality,
            status,
            scholarship,
            ...extra
        });
    }

    buildStudentFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { campus, department, program, yearLevel, modality, scholarship } = this.filters;
        return this.buildQuery({
            campus,
            department,
            program,
            yearLevel,
            modality,
            scholarship,
            ...extra
        });
    }

    buildDataFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, campus, semester, period, department, program, yearLevel, modality, status, scholarship } = this.filters;
        return this.buildQuery({
            schoolYear,
            campus,
            semester,
            period,
            department,
            program,
            yearLevel,
            modality,
            status,
            scholarship,
            ...extra
        });
    }

    buildForApprovalQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, campus, semester, period, department, program, yearLevel, modality, status, scholarship, approvalPeriod } = this.filters;
        return this.buildQuery({
            schoolYear,
            campus,
            semester,
            department,
            program,
            yearLevel,
            modality,
            status,
            scholarship,
            approvalPeriod: approvalPeriod || period,
            action: 'forApproval',
            ...extra
        });
    }

    async loadFilters() {
        try {
            const base = this.getBaseURL();
            const res = await fetch(`${base}/csdl/csdl-dashboard.php?action=filters`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (!data?.success) return;

            this.allPrograms = Array.isArray(data.programs) ? data.programs : [];
            this.populateSelect('filterSchoolYear', data.schoolYears, 'sy_id', (item) => item.sy_name || item.sy_code, 'All School Year');
            this.populateSelect('filterCampus', data.campuses, 'campus_id', 'campus_name', 'All Campuses');
            this.populateSelect('filterSemester', data.semesters, 'semester_id', 'semester_name', 'All Semester');
            this.populateSelect('filterPeriod', data.periods, 'app_period_id', 'app_period_name', 'All Periods');
            this.populateSelect('filterApprovalPeriod', data.periods, 'app_period_id', 'app_period_name', 'All Periods');
            this.populateSelect('filterDepartment', data.departments, 'department_id', 'department_name', 'All Department');
            this.populateSelect('filterYearLevel', data.yearLevels, 'year_level_id', 'year_level_name', 'All Year Level');
            this.populateSelect('filterModality', data.modalities, 'modality_code', 'modality_name', 'All Modalities');
            this.populateSelect('filterScholarship', data.scholarships, 'scholarship_id', 'scholarship_name', 'All Scholarships');
            this.refreshProgramOptions();
        } catch (error) {
            console.error('Error loading dashboard filters:', error);
        }
    }

    populateSelect(id, items, valueKey, labelKeyOrFn, defaultLabel) {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        select.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>`;
        (items || []).forEach((item) => {
            const option = document.createElement('option');
            option.value = item[valueKey];
            option.textContent = typeof labelKeyOrFn === 'function' ? labelKeyOrFn(item) : item[labelKeyOrFn];
            select.appendChild(option);
        });
        if ([...select.options].some((opt) => opt.value === current)) {
            select.value = current;
        }
    }

    refreshProgramOptions() {
        const select = document.getElementById('filterProgram');
        if (!select) return;
        const current = select.value;
        const departmentId = this.filters.department;
        select.innerHTML = '<option value="">All Program</option>';
        this.allPrograms
            .filter((program) => !departmentId || String(program.program_department_id) === String(departmentId))
            .forEach((program) => {
                const option = document.createElement('option');
                option.value = program.program_id;
                option.textContent = program.program_name;
                select.appendChild(option);
            });
        if ([...select.options].some((opt) => opt.value === current)) {
            select.value = current;
        } else {
            select.value = '';
            this.filters.program = '';
        }
    }

    bindFilterEvents() {
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', fn);
        };

        on('filterSchoolYear', () => { this.refreshLoanDashboard(); });
        on('filterCampus', () => { this.refreshDashboard(); });
        on('filterSemester', () => { this.refreshLoanDashboard(); });
        on('filterPeriod', () => { this.refreshLoanDashboard(); });
        on('filterDepartment', () => {
            this.syncFiltersFromDom();
            this.filters.program = '';
            const programSelect = document.getElementById('filterProgram');
            if (programSelect) programSelect.value = '';
            this.refreshProgramOptions();
            this.refreshDashboard();
        });
        on('filterProgram', () => { this.refreshDashboard(); });
        on('filterYearLevel', () => { this.refreshDashboard(); });
        on('filterModality', () => { this.refreshDashboard(); });
        on('filterStatus', () => { this.refreshDashboard(); });
        on('filterScholarship', () => { this.refreshDashboard(); });
        on('filterApprovalPeriod', () => { this.loadForApproval(); });
    }

    async refreshLoanDashboard() {
        this.syncFiltersFromDom();
        await Promise.all([
            this.loadSummary(),
            this.loadChart(),
            this.loadForApproval()
        ]);
    }

    async refreshStudentDashboard() {
        this.syncFiltersFromDom();
        await Promise.all([
            this.loadSummary(),
            this.loadChart()
        ]);
    }

    async refreshDashboard() {
        this.syncFiltersFromDom();
        await Promise.all([
            this.loadSummary(),
            this.loadChart(),
            this.loadForApproval()
        ]);
    }

    async loadSummary() {
        try {
            const base = this.getBaseURL();
            const query = this.buildDataFilterQuery({ action: 'summary' });
            const res = await fetch(`${base}/csdl/csdl-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            const s = data?.summary || {};
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
            set('totalEnrolled', s.enrolled);
            set('numApplicants', s.applicants);
            set('numApplications', s.applications);
            set('numApprovedApplications', s.approvedApplications);
            set('numPendingApplications', s.pending);
        } catch (_) {}
    }

    initChart() {
        const ctx = document.getElementById('dashboardPieChart');
        if (!ctx || typeof Chart === 'undefined') return;

        this.chart = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: [],
                datasets: [{
                    data: [],
                    backgroundColor: this.makeColors(12),
                    borderWidth: 1,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 12,
                            usePointStyle: true,
                            font: { family: "'Segoe UI', system-ui, sans-serif", size: 11 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const total = context.dataset.data.reduce((sum, val) => sum + (Number(val) || 0), 0);
                                const value = Number(context.raw) || 0;
                                const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
                                return `${context.label}: ${value} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    async loadChart() {
        const requestSeq = ++this.chartRequestSeq;
        try {
            const base = this.getBaseURL();
            const query = this.buildChartFilterQuery({ action: 'chart' });
            const res = await fetch(`${base}/csdl/csdl-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error(`Chart request failed (${res.status})`);
            const data = await res.json();
            if (requestSeq !== this.chartRequestSeq) return;
            if (!data?.success) throw new Error(data?.message || 'Chart request failed');

            this.chartMetric = data.metric === 'applications' ? 'applications' : 'students';
            this.chartGroupLabel = data.groupLabel || 'Department';

            const chartCanvas = document.getElementById('dashboardPieChart');
            if (chartCanvas) {
                const countLabel = this.chartMetric === 'applications' ? 'Applications' : 'Students';
                chartCanvas.setAttribute('aria-label', `${countLabel} by ${this.chartGroupLabel} chart`);
            }

            let labels = Array.isArray(data.labels) ? data.labels : [];
            let values = Array.isArray(data.values) ? data.values.map((v) => Number(v) || 0) : [];
            const hasData = labels.length > 0 && values.some((v) => v > 0);

            if (!hasData) {
                labels = ['No data'];
                values = [1];
            }

            this.currentData = {
                labels: hasData ? [...labels] : [],
                values: hasData ? [...values] : []
            };

            if (this.chart) {
                const isPlaceholder = !hasData;
                this.chart.data.labels = labels;
                this.chart.data.datasets[0].data = values;
                this.chart.data.datasets[0].backgroundColor = isPlaceholder
                    ? ['#e2e8f0']
                    : this.makeColors(values.length);
                this.chart.update('active');
                requestAnimationFrame(() => {
                    if (this.chart) this.chart.resize();
                });
                window.setTimeout(() => {
                    if (this.chart) this.chart.resize();
                }, 150);
            } else {
                this.initChart();
                if (this.chart && hasData) {
                    this.chart.data.labels = labels;
                    this.chart.data.datasets[0].data = values;
                    this.chart.data.datasets[0].backgroundColor = this.makeColors(values.length);
                    this.chart.update('active');
                }
            }
        } catch (error) {
            console.error('Error loading dashboard chart:', error);
        }
    }

    async loadForApproval() {
        try {
            const base = this.getBaseURL();
            const query = this.buildForApprovalQuery();
            const res = await fetch(`${base}/csdl/csdl-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            const pending = data?.pendingSummary || {};
            const scholarshipRows = Array.isArray(data?.scholarshipSummary) ? data.scholarshipSummary : [];
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
            set('pendingCsdl', pending.csdl);
            set('pendingAssessment', pending.assessment);
            set('pendingCashier', pending.cashier);
            set('pendingBranch', pending.branch);
            set('pendingCoo', pending.coo);
            set('pendingTotal', pending.total);
            this.renderScholarshipSummary(scholarshipRows);
            this.updateForApprovalTimestamp();
        } catch (_) {}
    }

    renderScholarshipSummary(rows) {
        const tbody = document.getElementById('scholarshipSummaryTableBody');
        if (!tbody) return;

        const total = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
        tbody.innerHTML = rows.length
            ? `${rows.map((row) => `<tr><td>${escapeHtml(row.classification || 'No Scholarship')}</td><td class="text-end fw-semibold tabular-nums">${Number(row.count) || 0}</td></tr>`).join('')}<tr class="table-light"><td class="fw-bold">TOTAL</td><td class="text-end fw-bold text-primary tabular-nums">${total}</td></tr>`
            : '<tr><td colspan="2" class="text-center text-muted small">No loan data</td></tr>';
    }

    bindModals() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };
        on('#enrolledBreakdownModal', 'shown.bs.modal', () => this.populateEnrolledBreakdown());
        on('#applicantsModal', 'shown.bs.modal', () => this.populateApplicants());
        on('#applicationsModal', 'shown.bs.modal', () => this.populateApplications());
        on('#approvedModal', 'shown.bs.modal', () => this.populateApproved());
        on('#pendingModal', 'shown.bs.modal', () => this.populatePending());
        on('#exportApplicationsBtn', 'click', () => this.exportApplications());
    }

    async fetchDetailList(detail) {
        const base = this.getBaseURL();
        const query = this.buildDataFilterQuery({ detail });
        const res = await fetch(`${base}/csdl/csdl-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
        const d = await res.json();
        return Array.isArray(d?.rows) ? d.rows : [];
    }

    async populateEnrolledBreakdown() {
        try {
            const rows = await this.fetchDetailList('enrolledBreakdownList');
            this.paginationData.enrolledBreakdown.allData = rows;
            this.paginationData.enrolledBreakdown.totalPages = Math.ceil(rows.length / this.recordsPerPage) || 1;
            this.paginationData.enrolledBreakdown.currentPage = 1;
            this.renderEnrolledBreakdownPage();
        } catch (_) {}
    }

    renderEnrolledBreakdownPage() {
        const data = this.paginationData.enrolledBreakdown;
        const start = (data.currentPage - 1) * this.recordsPerPage;
        const pageData = data.allData.slice(start, start + this.recordsPerPage);
        const tbody = document.getElementById('enrolledBreakdownTableBody');
        if (!tbody) return;

        tbody.innerHTML = pageData.length === 0
            ? '<tr><td colspan="4" class="text-center text-muted">No data</td></tr>'
            : pageData.map((r) => `
                <tr>
                    <td class="text-center">${escapeHtml(r.schoolId || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${escapeHtml(r.program || '')}</td>
                    <td class="text-center">${escapeHtml(r.yearLevel || '')}</td>
                </tr>
            `).join('');
        this.updatePaginationControls('enrolledBreakdown', 'enrolledBreakdownPagination');
    }

    async populateApplicants() {
        try {
            const rows = await this.fetchDetailList('applicantsList');
            this.paginationData.applicants.allData = rows;
            this.paginationData.applicants.totalPages = Math.ceil(rows.length / this.recordsPerPage) || 1;
            this.paginationData.applicants.currentPage = 1;
            this.renderApplicantsPage();
        } catch (_) {}
    }

    renderApplicantsPage() {
        const data = this.paginationData.applicants;
        const start = (data.currentPage - 1) * this.recordsPerPage;
        const pageData = data.allData.slice(start, start + this.recordsPerPage);
        const tbody = document.getElementById('applicantsTableBody');
        if (!tbody) return;

        tbody.innerHTML = pageData.length === 0
            ? '<tr><td colspan="4" class="text-center text-muted">No data</td></tr>'
            : pageData.map((r) => `
                <tr>
                    <td class="text-center">${escapeHtml(r.schoolId || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${escapeHtml(r.program || '')}</td>
                    <td class="text-center">${escapeHtml(r.totalApplications || '')}</td>
                </tr>
            `).join('');
        this.updatePaginationControls('applicants', 'applicantsPagination');
    }

    async populateApplications() {
        try {
            const rows = await this.fetchDetailList('applicationsList');
            this.paginationData.applications.allData = rows;
            this.paginationData.applications.totalPages = Math.ceil(rows.length / this.recordsPerPage) || 1;
            this.paginationData.applications.currentPage = 1;
            this.renderApplicationsPage();
        } catch (_) {}
    }

    async exportApplications() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            const base = this.getBaseURL();
            // The card export must use the exact same complete filter set as the
            // dashboard graph, including department, program, year level, and modality.
            const query = this.buildDataFilterQuery({ action: 'applicationExport' });
            const response = await fetch(`${base}/csdl/csdl-dashboard.php?${query}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const data = await response.json();
            if (!response.ok || !data?.success) {
                throw new Error(data?.message || 'Unable to load loan applications.');
            }
            const rows = Array.isArray(data?.rows) ? data.rows : [];

            if (rows.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'There are no loan applications to export for the selected filters.',
                    confirmButtonColor: '#198754'
                });
                return;
            }

            const format = await this.promptExportFormat('Export Total Applications');
            if (!format) return;

            this.exportTableRows(format, {
                title: 'Total Loan Applications - Complete Details',
                filenameBase: 'csdl_total_loan_applications',
                rows
            });
        } catch (error) {
            await swal.fire({
                icon: 'error',
                title: 'Export failed',
                text: 'Unable to export the loan applications. Please try again.',
                confirmButtonColor: '#198754'
            });
        }
    }

    renderApplicationsPage() {
        const data = this.paginationData.applications;
        const start = (data.currentPage - 1) * this.recordsPerPage;
        const pageData = data.allData.slice(start, start + this.recordsPerPage);
        const tbody = document.getElementById('applicationsTableBody');
        if (!tbody) return;

        tbody.innerHTML = pageData.length === 0
            ? '<tr><td colspan="6" class="text-center text-muted">No data</td></tr>'
            : pageData.map((r) => {
                let statusBadge = r.status || '';
                if (statusBadge) {
                    const statusLower = String(statusBadge).toLowerCase();
                    let badgeClass = 'bg-secondary';
                    if (statusLower === 'pending') badgeClass = 'bg-warning text-dark';
                    else if (statusLower === 'approved' || statusLower === 'completed') badgeClass = 'bg-success';
                    else if (statusLower === 'declined') badgeClass = 'bg-danger';
                    else if (statusLower === 'returned') badgeClass = 'bg-info';
                    statusBadge = `<span class="badge ${badgeClass}">${escapeHtml(statusBadge)}</span>`;
                }
                return `
                    <tr>
                        <td class="text-center">${escapeHtml(r.applicationNo || '')}</td>
                        <td class="text-center">${escapeHtml(r.schoolId || '')}</td>
                        <td class="text-center">${escapeHtml(r.name || '')}</td>
                        <td class="text-center">${escapeHtml(r.amount || '')}</td>
                        <td class="text-center">${statusBadge}</td>
                        <td class="text-center">${escapeHtml(r.dateApplied || '')}</td>
                    </tr>
                `;
            }).join('');
        this.updatePaginationControls('applications', 'applicationsPagination');
    }

    async populateApproved() {
        try {
            const rows = await this.fetchDetailList('approvedList');
            this.paginationData.approved.allData = rows;
            this.paginationData.approved.totalPages = Math.ceil(rows.length / this.recordsPerPage) || 1;
            this.paginationData.approved.currentPage = 1;
            this.renderApprovedPage();
        } catch (_) {}
    }

    renderApprovedPage() {
        const data = this.paginationData.approved;
        const start = (data.currentPage - 1) * this.recordsPerPage;
        const pageData = data.allData.slice(start, start + this.recordsPerPage);
        const tbody = document.getElementById('approvedTableBody');
        if (!tbody) return;

        tbody.innerHTML = pageData.length === 0
            ? '<tr><td colspan="6" class="text-center text-muted">No data</td></tr>'
            : pageData.map((r) => `
                <tr>
                    <td class="text-center">${escapeHtml(r.applicationNo || '')}</td>
                    <td class="text-center">${escapeHtml(r.schoolId || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${escapeHtml(r.amount || '')}</td>
                    <td class="text-center">${escapeHtml(r.dateApplied || '')}</td>
                    <td class="text-center">${escapeHtml(r.dateApproved || '')}</td>
                </tr>
            `).join('');
        this.updatePaginationControls('approved', 'approvedPagination');
    }

    async populatePending() {
        try {
            const rows = await this.fetchDetailList('pendingList');
            this.paginationData.pending.allData = rows;
            this.paginationData.pending.totalPages = Math.ceil(rows.length / this.recordsPerPage) || 1;
            this.paginationData.pending.currentPage = 1;
            this.renderPendingPage();
        } catch (_) {}
    }

    renderPendingPage() {
        const data = this.paginationData.pending;
        const start = (data.currentPage - 1) * this.recordsPerPage;
        const pageData = data.allData.slice(start, start + this.recordsPerPage);
        const tbody = document.getElementById('pendingTableBody');
        if (!tbody) return;

        tbody.innerHTML = pageData.length === 0
            ? '<tr><td colspan="6" class="text-center text-muted">No data</td></tr>'
            : pageData.map((r) => `
                <tr>
                    <td class="text-center">${escapeHtml(r.applicationNo || '')}</td>
                    <td class="text-center">${escapeHtml(r.schoolId || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${escapeHtml(r.amount || '')}</td>
                    <td class="text-center"><span class="badge bg-warning text-dark">${escapeHtml(r.status || 'Pending')}</span></td>
                    <td class="text-center">${escapeHtml(r.dateApplied || '')}</td>
                </tr>
            `).join('');
        this.updatePaginationControls('pending', 'pendingPagination');
    }

    updatePaginationControls(dataKey, paginationId) {
        const data = this.paginationData[dataKey];
        const container = document.getElementById(paginationId);
        if (!container) return;

        const total = data.allData.length;
        if (total === 0) {
            container.innerHTML = '<div class="text-muted small">No records</div>';
            return;
        }

        if (data.totalPages <= 1) {
            const label = total === 1 ? '1 record' : `Showing all ${total} records`;
            container.innerHTML = `<div class="text-muted small">${label}</div>`;
            return;
        }

        const start = (data.currentPage - 1) * this.recordsPerPage + 1;
        const end = Math.min(data.currentPage * this.recordsPerPage, total);

        let html = '<div class="d-flex justify-content-between align-items-center flex-wrap gap-2">';
        html += `<div class="text-muted small">Showing ${start}-${end} of ${total} records</div>`;
        html += '<div class="btn-group btn-group-sm">';
        html += `<button type="button" class="btn btn-outline-secondary" ${data.currentPage === 1 ? 'disabled' : ''} onclick="window.csdlDashboard.changePage('${dataKey}', ${data.currentPage - 1})" aria-label="Previous page"><i class="bi bi-chevron-left"></i></button>`;

        const maxButtons = 5;
        let startPage = Math.max(1, data.currentPage - Math.floor(maxButtons / 2));
        const endPage = Math.min(data.totalPages, startPage + maxButtons - 1);
        if (endPage - startPage < maxButtons - 1) {
            startPage = Math.max(1, endPage - maxButtons + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<button type="button" class="btn ${i === data.currentPage ? 'btn-dark' : 'btn-outline-secondary'}" onclick="window.csdlDashboard.changePage('${dataKey}', ${i})">${i}</button>`;
        }

        html += `<button type="button" class="btn btn-outline-secondary" ${data.currentPage === data.totalPages ? 'disabled' : ''} onclick="window.csdlDashboard.changePage('${dataKey}', ${data.currentPage + 1})" aria-label="Next page"><i class="bi bi-chevron-right"></i></button>`;
        html += '</div></div>';
        container.innerHTML = html;
    }

    changePage(dataKey, newPage) {
        const data = this.paginationData[dataKey];
        if (newPage < 1 || newPage > data.totalPages) return;
        data.currentPage = newPage;

        if (dataKey === 'enrolledBreakdown') this.renderEnrolledBreakdownPage();
        else if (dataKey === 'applicants') this.renderApplicantsPage();
        else if (dataKey === 'applications') this.renderApplicationsPage();
        else if (dataKey === 'approved') this.renderApprovedPage();
        else if (dataKey === 'pending') this.renderPendingPage();
    }

    makeColors(n) {
        const pal = ['#198754', '#20c997', '#0dcaf0', '#6f42c1', '#fd7e14', '#ffc107', '#dc3545', '#0d6efd', '#6c757d', '#6610f2', '#03600f', '#94a3b8'];
        const out = [];
        for (let i = 0; i < n; i++) out.push(pal[i % pal.length]);
        return out;
    }

    bindExport() {
        const chartBtn = document.getElementById('exportChartBtn');
        if (chartBtn) chartBtn.addEventListener('click', () => this.exportProgramReport());

        const pendingBtn = document.getElementById('exportPendingBtn');
        if (pendingBtn) pendingBtn.addEventListener('click', () => this.exportPendingApprovals());
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

    async promptExportFormat(title) {
        const swal = window.Swal;
        if (!swal) return null;

        const result = await swal.fire({
            title,
            input: 'select',
            inputOptions: {
                csv: 'CSV',
                xls: 'Excel (.xls)',
                doc: 'Word (.doc)',
                pdf: 'PDF (.pdf)'
            },
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

        return result.isConfirmed ? result.value : null;
    }

    exportTableRows(format, { title, filenameBase, rows }) {
        const headers = Object.keys(rows[0] || {});
        const stamp = new Date().toISOString().split('T')[0];
        const filename = `${filenameBase}_${stamp}`;

        if (format === 'csv') {
            const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
            const lines = [headers.map(esc).join(',')];
            rows.forEach((row) => {
                lines.push(headers.map((header) => esc(row[header])).join(','));
            });
            this.downloadBlob(new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), `${filename}.csv`);
            return;
        }

        if (format === 'xls') {
            const th = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
            const trs = rows.map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(String(row[header] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `${filename}.xls`);
            return;
        }

        if (format === 'doc') {
            const th = headers.map((header) => `<th style="border:1px solid #000;padding:8px;background:#f0f0f0;">${escapeHtml(header)}</th>`).join('');
            const trs = rows.map((row) => `<tr>${headers.map((header) => `<td style="border:1px solid #000;padding:8px;">${escapeHtml(String(row[header] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h2>${escapeHtml(title)}</h2><p>Generated on: ${escapeHtml(new Date().toLocaleString())}</p><table style="border-collapse:collapse;width:100%;margin-top:20px;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), `${filename}.doc`);
            return;
        }

        if (format === 'pdf') {
            this.exportPDF(title, headers, rows);
        }
    }

    exportPDF(title, headers, rows) {
        const now = new Date();
        const dateStr = now.toLocaleDateString();
        const timeStr = now.toLocaleTimeString();
        
        // Build filter summary
        const filterParts = [];
        if (this.filters.schoolYear) {
            const sySelect = document.getElementById('filterSchoolYear');
            const syText = sySelect?.selectedOptions[0]?.textContent || this.filters.schoolYear;
            filterParts.push(`School Year: ${escapeHtml(syText)}`);
        }
        if (this.filters.campus) {
            const campusSelect = document.getElementById('filterCampus');
            const campusText = campusSelect?.selectedOptions[0]?.textContent || this.filters.campus;
            filterParts.push(`Campus: ${escapeHtml(campusText)}`);
        }
        if (this.filters.semester) {
            const semSelect = document.getElementById('filterSemester');
            const semText = semSelect?.selectedOptions[0]?.textContent || this.filters.semester;
            filterParts.push(`Semester: ${escapeHtml(semText)}`);
        }
        if (this.filters.period) {
            const periodSelect = document.getElementById('filterPeriod');
            const periodText = periodSelect?.selectedOptions[0]?.textContent || this.filters.period;
            filterParts.push(`Period: ${escapeHtml(periodText)}`);
        }
        if (this.filters.department) {
            const deptSelect = document.getElementById('filterDepartment');
            const deptText = deptSelect?.selectedOptions[0]?.textContent || this.filters.department;
            filterParts.push(`Department: ${escapeHtml(deptText)}`);
        }
        if (this.filters.program) {
            const progSelect = document.getElementById('filterProgram');
            const progText = progSelect?.selectedOptions[0]?.textContent || this.filters.program;
            filterParts.push(`Program: ${escapeHtml(progText)}`);
        }
        if (this.filters.yearLevel) {
            const ylSelect = document.getElementById('filterYearLevel');
            const ylText = ylSelect?.selectedOptions[0]?.textContent || this.filters.yearLevel;
            filterParts.push(`Year Level: ${escapeHtml(ylText)}`);
        }
        if (this.filters.modality) {
            filterParts.push(`Modality: ${escapeHtml(this.filters.modality)}`);
        }
        if (this.filters.status) {
            const statusText = document.getElementById('filterStatus')?.selectedOptions[0]?.textContent || this.filters.status;
            filterParts.push(`Status: ${escapeHtml(statusText)}`);
        }
        if (this.filters.scholarship) {
            const scholarshipText = document.getElementById('filterScholarship')?.selectedOptions[0]?.textContent || this.filters.scholarship;
            filterParts.push(`Scholarship: ${escapeHtml(scholarshipText)}`);
        }
        const filterHtml = filterParts.length > 0 
            ? `<div class="filter-info"><strong>Applied Filters:</strong> ${filterParts.join(' | ')}</div>`
            : '';

        // Build table headers and rows
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
    <title>${escapeHtml(title)}</title>
    <style>
        @media print {
            @page { size: landscape; margin: 15mm; }
            body { margin: 0; }
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: 11px;
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
            padding: 8px;
            text-align: left;
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
        <div class="report-title">${escapeHtml(title)}</div>
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
    }

    async fetchDashboardExport(scope = 'chart') {
        const base = this.getBaseURL();
        const query = scope === 'approval'
            ? this.buildForApprovalQuery({ action: 'export' })
            : this.buildChartFilterQuery({ action: 'chartExport' });
        const res = await fetch(`${base}/csdl/csdl-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json();
        if (!data?.success) throw new Error('Export failed');
        return data;
    }

    async exportProgramReport() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            const data = await this.fetchDashboardExport();

            if (Array.isArray(data.defaultRows)) {
                if (data.defaultRows.length === 0) {
                    await swal.fire({
                        icon: 'warning',
                        title: 'No Data',
                        text: 'There are no loan applications to export.',
                        confirmButtonColor: '#198754'
                    });
                    return;
                }

                const format = await this.promptExportFormat('Export Applications Report');
                if (!format) return;

                this.exportTableRows(format, {
                    title: 'Loan Applications Overview',
                    filenameBase: 'csdl_applications_overview',
                    rows: data.defaultRows
                });
                return;
            }
            
            // Get the grouping dimension from the backend response
            const groupLabel = data.chartGroupLabel || 'Department';
            const chartRows = data.chart || [];
            
            // Map chart data to export format with proper grouping
            const rows = chartRows.map((row) => ({
                [groupLabel]: row.label || 'Unassigned',
                'Count': Number(row.value) || 0
            }));

            if (rows.length === 0 || rows.every((row) => row.Count === 0)) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: `There is no ${groupLabel.toLowerCase()} data to export for the selected filters.`,
                    confirmButtonColor: '#198754'
                });
                return;
            }

            const format = await this.promptExportFormat(`Export ${groupLabel} Report`);
            if (!format) return;

            this.exportTableRows(format, {
                title: `${data.chartMetric === 'applications' ? 'Applications' : 'Students'} by ${groupLabel}`,
                filenameBase: `csdl_${groupLabel.toLowerCase().replace(/\s+/g, '_')}_report`,
                rows
            });
        } catch (error) {
            await swal.fire({
                icon: 'error',
                title: 'Export failed',
                text: 'Unable to export the report. Please try again.',
                confirmButtonColor: '#198754'
            });
        }
    }

    async exportPendingApprovals() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            const data = await this.fetchDashboardExport('approval');
            const rows = data.pendingApprovals || [];
            const pendingTotal = rows.reduce((total, row) => total + (Number(row['Pending Approval']) || 0), 0);
            if (rows.length === 0 || pendingTotal === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'There are no pending approvals to export for the selected filters.',
                    confirmButtonColor: '#198754'
                });
                return;
            }

            const format = await this.promptExportFormat('Export Pending Approval');
            if (!format) return;

            this.exportTableRows(format, {
                title: 'Approvers - Pending Approval',
                filenameBase: 'csdl_pending_approvals',
                rows
            });
        } catch (error) {
            await swal.fire({
                icon: 'error',
                title: 'Export failed',
                text: 'Unable to export the approver report. Please try again.',
                confirmButtonColor: '#198754'
            });
        }
    }
}

export default CsdlDashboardModule;

if (typeof window !== 'undefined') {
    window.csdlDashboard = null;
}
