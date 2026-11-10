import AppPaths from '../../services/services-appPaths.js';
import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';

class BranchAdminDashboardModule {
    constructor() {
        this.chart = null;
        this.chartRequestSeq = 0;
        this.chartMetric = 'students';
        this.chartGroupLabel = 'Department';
        this.currentData = { labels: [], values: [] };
        this.allPrograms = [];
        this.filters = {
            schoolYear: '',
            semester: '',
            period: '',
            department: '',
            program: '',
            yearLevel: '',
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
        await this.ensureSession();
        this.updateForApprovalTimestamp();
        await this.loadFilters();
        this.initChart();
        this.bindFilterEvents();
        this.bindExport();
        this.bindModals();
        await this.refreshDashboard();
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
        this.filters.semester = get('filterSemester');
        this.filters.period = get('filterPeriod');
        this.filters.department = get('filterDepartment');
        this.filters.program = get('filterProgram');
        this.filters.yearLevel = get('filterYearLevel');
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
        const { schoolYear, semester, period, department, program, yearLevel } = this.filters;
        return this.buildQuery({
            schoolYear,
            semester,
            period,
            department,
            program,
            yearLevel,
            ...extra
        });
    }

    buildLoanFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, semester, period } = this.filters;
        return this.buildQuery({
            schoolYear,
            semester,
            period,
            ...extra
        });
    }

    buildStudentFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { department, program, yearLevel } = this.filters;
        return this.buildQuery({
            department,
            program,
            yearLevel,
            ...extra
        });
    }

    buildDataFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, semester, period, department, program, yearLevel } = this.filters;
        return this.buildQuery({
            schoolYear,
            semester,
            period,
            department,
            program,
            yearLevel,
            ...extra
        });
    }

    buildForApprovalQuery(extra = {}) {
        this.syncFiltersFromDom();
        const { schoolYear, semester, period, department, program, yearLevel, approvalPeriod } = this.filters;
        return this.buildQuery({
            schoolYear,
            semester,
            department,
            program,
            yearLevel,
            approvalPeriod: approvalPeriod || period,
            action: 'forApproval',
            ...extra
        });
    }

    async loadFilters() {
        try {
            const base = this.getBaseURL();
            const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?action=filters`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (!data?.success) return;

            this.allPrograms = Array.isArray(data.programs) ? data.programs : [];
            this.populateSelect('filterSchoolYear', data.schoolYears, 'sy_id', (item) => item.sy_name || item.sy_code, 'All School Year');
            this.populateSelect('filterSemester', data.semesters, 'semester_id', 'semester_name', 'All Semester');
            this.populateSelect('filterPeriod', data.periods, 'app_period_id', 'app_period_name', 'All Periods');
            this.populateSelect('filterApprovalPeriod', data.periods, 'app_period_id', 'app_period_name', 'All Periods');
            this.populateSelect('filterDepartment', data.departments, 'department_id', 'department_name', 'All Department');
            this.populateSelect('filterYearLevel', data.yearLevels, 'year_level_id', 'year_level_name', 'All Year Level');
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
        on('filterSemester', () => { this.refreshLoanDashboard(); });
        on('filterPeriod', () => { this.refreshLoanDashboard(); });
        on('filterDepartment', () => {
            this.syncFiltersFromDom();
            this.filters.program = '';
            const programSelect = document.getElementById('filterProgram');
            if (programSelect) programSelect.value = '';
            this.refreshProgramOptions();
            this.refreshStudentDashboard();
        });
        on('filterProgram', () => { this.refreshStudentDashboard(); });
        on('filterYearLevel', () => { this.refreshStudentDashboard(); });
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
            this.loadChart(),
            this.loadForApproval()
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
            // Cards should always show unfiltered totals
            const query = this.buildQuery({ action: 'summary', includeFilters: 'false' });
            const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            const s = data?.summary || {};
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
            set('numTotal', s.total ?? s.applications);
            set('numPending', s.pending);
            set('numApproved', s.approved ?? s.approvedApplications);
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
            const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
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
            const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            const row = data?.forApproval || {};
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
            set('approvalCsdl', row.csdl);
            set('approvalCsdlPending', row.csdlPending);
            set('approvalAssessment', row.assessment);
            set('approvalBranch', row.branch);
            set('approvalCoo', row.coo);
            set('approvalTotal', row.total);
            this.updateForApprovalTimestamp();
        } catch (_) {}
    }

    bindModals() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };
        on('#enrolledBreakdownModal', 'shown.bs.modal', () => this.populateEnrolledBreakdown());
        on('#applicantsModal', 'shown.bs.modal', () => this.populateApplicants());
        on('#applicationsModal', 'shown.bs.modal', () => this.populateApplications());
        on('#approvedModal', 'shown.bs.modal', () => this.populateApproved());
        on('#pendingModal', 'shown.bs.modal', () => this.populatePending());
    }

    async fetchDetailList(detail) {
        const base = this.getBaseURL();
        const studentDetails = new Set(['enrolledBreakdownList']);
        const query = studentDetails.has(detail)
            ? this.buildStudentFilterQuery({ detail })
            : this.buildLoanFilterQuery({ detail });
        const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
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
                    else if (statusLower === 'approved') badgeClass = 'bg-success';
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
            ? '<tr><td colspan="7" class="text-center text-muted">No data</td></tr>'
            : pageData.map((r) => {
                let statusBadge = r.status || 'Approved';
                const statusLower = String(statusBadge).toLowerCase();
                let badgeClass = 'bg-success';
                if (statusLower === 'pending') badgeClass = 'bg-warning text-dark';
                else if (statusLower === 'approved') badgeClass = 'bg-success';
                else if (statusLower === 'completed') badgeClass = 'bg-success';
                else if (statusLower === 'declined') badgeClass = 'bg-danger';
                else if (statusLower === 'returned') badgeClass = 'bg-warning text-dark';
                statusBadge = `<span class="badge ${badgeClass}">${escapeHtml(statusBadge)}</span>`;
                
                return `
                <tr>
                    <td class="text-center">${escapeHtml(r.applicationNo || '')}</td>
                    <td class="text-center">${escapeHtml(r.schoolId || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${escapeHtml(r.amount || '')}</td>
                    <td class="text-center">${statusBadge}</td>
                    <td class="text-center">${escapeHtml(r.dateApplied || '')}</td>
                    <td class="text-center">${escapeHtml(r.dateApproved || '')}</td>
                </tr>
            `;
            }).join('');
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
        html += `<button type="button" class="btn btn-outline-secondary" ${data.currentPage === 1 ? 'disabled' : ''} onclick="window.branchAdminDashboard.changePage('${dataKey}', ${data.currentPage - 1})" aria-label="Previous page"><i class="bi bi-chevron-left"></i></button>`;

        const maxButtons = 5;
        let startPage = Math.max(1, data.currentPage - Math.floor(maxButtons / 2));
        const endPage = Math.min(data.totalPages, startPage + maxButtons - 1);
        if (endPage - startPage < maxButtons - 1) {
            startPage = Math.max(1, endPage - maxButtons + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<button type="button" class="btn ${i === data.currentPage ? 'btn-dark' : 'btn-outline-secondary'}" onclick="window.branchAdminDashboard.changePage('${dataKey}', ${i})">${i}</button>`;
        }

        html += `<button type="button" class="btn btn-outline-secondary" ${data.currentPage === data.totalPages ? 'disabled' : ''} onclick="window.branchAdminDashboard.changePage('${dataKey}', ${data.currentPage + 1})" aria-label="Next page"><i class="bi bi-chevron-right"></i></button>`;
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
        if (chartBtn) chartBtn.addEventListener('click', () => this.exportChart());

        const approvalBtn = document.getElementById('exportDashboardBtn');
        if (approvalBtn) approvalBtn.addEventListener('click', () => this.exportApproval());
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
            // Use the same print-ready report layout as the other exports.
            const headers = Object.keys(rows[0] || {});
            const th = headers.map((header) => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(header)}</th>`).join('');
            const trs = rows.map((row, idx) => {
                const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                return `<tr style="background-color:${bgColor};">${headers.map((header) => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(row[header] ?? ''))}</td>`).join('')}</tr>`;
            }).join('');
            
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>${escapeHtml(title)}</title>
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
                                <h2>${escapeHtml(title)}</h2>
                            </div>
                            <div class="report-info">
                                <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                <div><strong>Office:</strong> Branch Administrator</div>
                                <div><strong>Total Records:</strong> ${rows.length}</div>
                            </div>
                        </div>
                    </div>
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
    }

    async exportChart() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            const base = this.getBaseURL();
            const query = this.buildChartFilterQuery({ action: 'export' });
            const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (!data?.success) throw new Error('Export failed');

            const countLabel = data.chartMetric === 'applications' ? 'Applications' : 'Students';
            const groupLabel = data.chartGroupLabel || 'Department';
            const chartRows = (data.chart || []).map((row) => ({
                [groupLabel]: row.label,
                [countLabel]: row.value
            }));

            if (chartRows.length === 0 || chartRows.every((row) => (Number(row[countLabel]) || 0) === 0)) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'There is no chart data to export.',
                    confirmButtonColor: '#198754'
                });
                return;
            }

            const format = await this.promptExportFormat('Export Chart');
            if (!format) return;

            this.exportTableRows(format, {
                title: `Dashboard Chart - ${countLabel} by ${groupLabel}`,
                filenameBase: 'branch_admin_chart',
                rows: chartRows
            });
        } catch (error) {
            console.error('Error exporting chart:', error);
            swal?.fire({
                icon: 'error',
                title: 'Export Failed',
                text: error.message || 'Failed to export chart data'
            });
        }
    }

    async exportApproval() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            const base = this.getBaseURL();
            const query = this.buildForApprovalQuery();
            const res = await fetch(`${base}/branch-admin/branch-admin-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (!data?.success) throw new Error('Export failed');

            const approval = data.forApproval || {};
            const approvalRows = [
                ['CSDL', approval.csdl],
                ['CSDL-Pending', approval.csdlPending],
                ['Assessment', approval.assessment],
                ['Branch Admin', approval.branch],
                ['COO', approval.coo],
                ['Total', approval.total]
            ].map(([step, count]) => ({ Step: step, Count: Number(count) || 0 }));

            if ((Number(approval.total) || 0) === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'There is no approval data to export.',
                    confirmButtonColor: '#198754'
                });
                return;
            }

            const format = await this.promptExportFormat('Export For Approval');
            if (!format) return;

            this.exportTableRows(format, {
                title: 'For Approval Summary',
                filenameBase: 'branch_admin_approval',
                rows: approvalRows
            });
        } catch (error) {
            console.error('Error exporting approval:', error);
            swal?.fire({
                icon: 'error',
                title: 'Export Failed',
                text: error.message || 'Failed to export approval data'
            });
        }
    }
}

export default BranchAdminDashboardModule;
