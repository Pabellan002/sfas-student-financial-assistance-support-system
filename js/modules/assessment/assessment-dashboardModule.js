import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import { renderModernLoanDetails } from '../../shared/shared-loan-details-render.js';

class AssessmentDashboardModule {
    constructor() {
        this.stats = { allApplications: 0, approved: 0, endorsed: 0, pnTagged: 0 };
        this.recentActivity = [];
        this.recentTotal = 0;
        this.recentPage = 1;
        this.recentPerPage = 10;
        this.recentFilters = { semester: '', schoolYear: '', period: '' };
        this.recentSearch = '';
        this.pnStatusChart = null;
        this.modalLoanView = null;
        this.modalLoanPage = 1;
        this.modalLoanPerPage = 25;
        this.modalLoanTotal = 0;
        this.modalLoanTotalPages = 0;
        this._loansModalPaginationBound = false;
    }

    async init() {
        await this.ensureSession();
        this.initCharts();
        await this.loadRecentActivityFilters();
        this.bindRecentActivityControls();
        this.bindRecentActivityTable();
        this.setupRecentActivityMobileFilterClose();
        this.bindStatCards();
        this.bindExport();
        await this.loadStats();
        await this.loadRecentActivity();
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
    }

    async loadStats() {
        try {
            const res = await fetch('../../api/assessment/assessment-dashboard.php?action=stats', { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();
            if (response.success) {
                this.stats = response.stats;
                this.updateStatsUI();
                if (response.charts) {
                    this.updatePNStatusChart(response.charts.statusDistribution);
                }
            }
        } catch (error) {
            console.error('Error loading stats:', error);
            // Error loading stats
        }
    }

    buildRecentActivityQueryParams() {
        const params = new URLSearchParams({
            action: 'recent_activity',
            limit: String(this.recentPerPage),
            page: String(this.recentPage)
        });
        if (this.recentFilters.semester) params.set('semester', this.recentFilters.semester);
        if (this.recentFilters.schoolYear) params.set('schoolYear', this.recentFilters.schoolYear);
        if (this.recentFilters.period) params.set('period', this.recentFilters.period);
        if (this.recentSearch) params.set('search', this.recentSearch);
        return params;
    }

    async loadRecentActivityFilters() {
        try {
            const res = await fetch('../../api/assessment/assessment-loan-management.php?action=filters', {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const response = await res.json();
            if (!response.success) return;

            const semesterSelect = document.getElementById('recentFilterSemester');
            const semesterMobile = document.getElementById('recentFilterSemesterMobile');
            [semesterSelect, semesterMobile].forEach((select) => {
                if (!select) return;
                select.innerHTML = '<option value="">All Semesters</option>';
                (response.semesters || []).forEach((sem) => {
                    const option = document.createElement('option');
                    option.value = sem.semester_id;
                    option.textContent = sem.semester_name;
                    select.appendChild(option);
                });
            });

            const sySelect = document.getElementById('recentFilterSchoolYear');
            const syMobile = document.getElementById('recentFilterSchoolYearMobile');
            [sySelect, syMobile].forEach((select) => {
                if (!select) return;
                select.innerHTML = '<option value="">All School Years</option>';
                (response.schoolYears || []).forEach((sy) => {
                    const option = document.createElement('option');
                    option.value = sy.sy_id;
                    option.textContent = sy.sy_display;
                    select.appendChild(option);
                });
            });

            const periodSelect = document.getElementById('recentFilterPeriod');
            const periodMobile = document.getElementById('recentFilterPeriodMobile');
            [periodSelect, periodMobile].forEach((select) => {
                if (!select) return;
                select.innerHTML = '<option value="">All Periods</option>';
                (response.periods || []).forEach((p) => {
                    const option = document.createElement('option');
                    option.value = p.app_period_id;
                    option.textContent = p.app_period_name;
                    select.appendChild(option);
                });
            });
        } catch (e) {
            // Filters optional if API unavailable
        }
    }

    bindRecentActivityControls() {
        const semesterSelect = document.getElementById('recentFilterSemester');
        const schoolYearSelect = document.getElementById('recentFilterSchoolYear');
        const periodSelect = document.getElementById('recentFilterPeriod');
        const searchInput = document.getElementById('recentActivitySearch');
        const searchMobile = document.getElementById('recentActivitySearchMobile');
        const refreshBtn = document.getElementById('recentActivityRefreshBtn');
        const perPageSelect = document.getElementById('recentPerPageSelect');

        const reload = () => { this.recentPage = 1; this.loadRecentActivity(); };

        if (perPageSelect) {
            perPageSelect.addEventListener('change', (e) => {
                this.recentPerPage = parseInt(e.target.value, 10) || 10;
                this.recentPage = 1;
                this.loadRecentActivity();
            });
        }

        if (semesterSelect) {
            semesterSelect.addEventListener('change', (e) => {
                this.recentFilters.semester = e.target.value;
                reload();
            });
        }
        if (schoolYearSelect) {
            schoolYearSelect.addEventListener('change', (e) => {
                this.recentFilters.schoolYear = e.target.value;
                reload();
            });
        }
        if (periodSelect) {
            periodSelect.addEventListener('change', (e) => {
                this.recentFilters.period = e.target.value;
                reload();
            });
        }

        const syncSearch = (value, otherEl) => {
            this.recentSearch = value;
            if (otherEl && otherEl.value !== value) otherEl.value = value;
            reload();
        };

        if (searchInput) {
            let t;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(t);
                const v = e.target.value.trim();
                t = setTimeout(() => syncSearch(v, searchMobile), 300);
            });
        }
        if (searchMobile) {
            let t;
            searchMobile.addEventListener('input', (e) => {
                clearTimeout(t);
                const v = e.target.value.trim();
                t = setTimeout(() => syncSearch(v, searchInput), 300);
            });
        }

        const applyMobile = document.getElementById('recentActivityApplyMobileFiltersBtn');
        if (applyMobile) {
            applyMobile.addEventListener('click', () => {
                const sm = document.getElementById('recentFilterSemesterMobile');
                const sym = document.getElementById('recentFilterSchoolYearMobile');
                const pm = document.getElementById('recentFilterPeriodMobile');
                if (sm && semesterSelect) {
                    semesterSelect.value = sm.value;
                    this.recentFilters.semester = sm.value;
                }
                if (sym && schoolYearSelect) {
                    schoolYearSelect.value = sym.value;
                    this.recentFilters.schoolYear = sym.value;
                }
                if (pm && periodSelect) {
                    periodSelect.value = pm.value;
                    this.recentFilters.period = pm.value;
                }
                reload();
                const btn = document.getElementById('recentActivityMobileFilterBtn');
                if (btn) {
                    const dd = bootstrap.Dropdown.getInstance(btn);
                    if (dd) dd.hide();
                }
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                this.recentFilters = { semester: '', schoolYear: '', period: '' };
                this.recentSearch = '';
                if (semesterSelect) semesterSelect.value = '';
                if (schoolYearSelect) schoolYearSelect.value = '';
                if (periodSelect) periodSelect.value = '';
                const sm = document.getElementById('recentFilterSemesterMobile');
                const sym = document.getElementById('recentFilterSchoolYearMobile');
                const pm = document.getElementById('recentFilterPeriodMobile');
                if (sm) sm.value = '';
                if (sym) sym.value = '';
                if (pm) pm.value = '';
                if (searchInput) searchInput.value = '';
                if (searchMobile) searchMobile.value = '';
                reload();
            });
        }
    }

    bindRecentActivityTable() {
        const tbody = document.getElementById('recentActivityTableBody');
        if (!tbody || tbody.dataset.viewBound) return;
        tbody.dataset.viewBound = '1';
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('tr[data-loan-id]');
            if (!row) return;
            const loanId = parseInt(row.getAttribute('data-loan-id'), 10);
            if (loanId) this.viewLoan(loanId);
        });
    }

    setupRecentActivityMobileFilterClose() {
        const navbarToggler = document.querySelector('.navbar-toggler');
        const mobileFilterBtn = document.getElementById('recentActivityMobileFilterBtn');
        if (navbarToggler && mobileFilterBtn) {
            navbarToggler.addEventListener('click', () => {
                const dd = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                if (dd) dd.hide();
            });
        }
    }

    async loadRecentActivity() {
        try {
            const qs = this.buildRecentActivityQueryParams().toString();
            const res = await fetch(`../../api/assessment/assessment-dashboard.php?${qs}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const response = await res.json();
            if (response.success) {
                this.recentActivity = response.data || [];
                this.recentTotal = parseInt(response.total || 0, 10);
                this.recentTotalPages = parseInt(response.totalPages || 1, 10);
                this.renderRecentActivity();
                this.updateRecentPagination();
            }
        } catch (error) {
            console.error('Error loading recent activity:', error);
            // Error loading recent activity
        }
    }

    updateStatsUI() {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val || 0); };
        set('statAllApplications', this.stats.allApplications);
        set('statApproved', this.stats.approved);
        set('statEndorsed', this.stats.endorsed);
        set('statPnTagged', this.stats.pnTagged);
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

    renderRecentActivity() {
        const tbody = document.getElementById('recentActivityTableBody');
        if (!tbody) return;

        const hasFilter =
            !!(this.recentFilters.semester || this.recentFilters.schoolYear || this.recentFilters.period || this.recentSearch);

        if (this.recentActivity.length === 0) {
            const msg = hasFilter
                ? 'No records match your filters or search.'
                : 'No recent PN tagging activity yet.';
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-5">${msg}</td></tr>`;
            return;
        }
        
        tbody.innerHTML = this.recentActivity.map(item => {
            const statusBadge = this.getStatusBadge(item.loan_status_id, item.loan_status_name);
            const paymentStatusBadge = this.getPaymentStatusBadge(item.payment_status);
            const pnStatusBadge = this.getPnStatusBadge(item.pn_status);
            const amount = `₱${parseFloat(item.loan_amount_can_pay || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const dateTagged = escapeHtml(this.formatTaggedDate(item.date_tagged));
            const loanId = parseInt(item.loan_id, 10) || 0;
            return `
                <tr data-loan-id="${loanId || ''}" class="table-row-clickable" style="cursor: pointer;">
                    <td class="text-center" data-label="Application No.">${escapeHtml(item.loan_application_no || '-')}</td>
                    <td class="text-center" data-label="Student Name">${escapeHtml(item.student_name || '-')}</td>
                    <td class="text-center" data-label="Amount">${amount}</td>
                    <td class="text-center" data-label="Status">${statusBadge}</td>
                    <td class="text-center" data-label="Payment Status">${paymentStatusBadge}</td>
                    <td class="text-center" data-label="PN Status">${pnStatusBadge}</td>
                    <td class="text-center" data-label="Date">${dateTagged}</td>
                </tr>
            `;
        }).join('');
    }

    getStatusBadge(statusId, statusName) {
        const id = parseInt(statusId, 10);
        const name = escapeHtml(statusName || '-');
        const classes = {
            1: 'bg-warning text-dark',
            2: 'bg-success',
            3: 'bg-danger',
            4: 'bg-primary',
            5: 'bg-success',
            6: 'bg-warning text-dark',
            7: 'bg-info text-white',
            8: 'bg-secondary',
            9: 'bg-secondary',
            11: 'bg-warning text-dark',
            12: 'bg-success'
        };
        const badgeClass = classes[id] || 'bg-secondary';
        return `<span class="badge ${badgeClass}">${name}</span>`;
    }

    getPaymentStatusBadge(paymentStatusId) {
        if (!paymentStatusId) return '<span class="badge bg-secondary">Not Set</span>';
        const id = parseInt(paymentStatusId, 10);
        // Based on database: 1=Not Paid, 2=Partial Payment, 3=Paid, 4=Paid Pending, 5=Paid Partial
        if (id === 3) {
            return '<span class="badge bg-success">Paid</span>';
        } else if (id === 2) {
            return '<span class="badge bg-warning text-dark">Partial Payment</span>';
        } else if (id === 4) {
            return '<span class="badge bg-info text-dark">Paid Pending</span>';
        } else if (id === 5) {
            return '<span class="badge bg-warning text-dark">Paid Partial</span>';
        } else if (id === 1) {
            return '<span class="badge bg-danger">Not Paid</span>';
        }
        return '<span class="badge bg-secondary">Not Set</span>';
    }

    getPnStatusBadge(pnStatusId) {
        if (!pnStatusId) return '<span class="badge bg-secondary">Not Set</span>';
        const id = parseInt(pnStatusId, 10);
        // Based on database: 1=Not Tagged, 2=Tagged
        if (id === 2) {
            return '<span class="badge bg-success">Tagged</span>';
        } else if (id === 1) {
            return '<span class="badge bg-warning text-dark">Not Tagged</span>';
        }
        return '<span class="badge bg-secondary">Not Set</span>';
    }

    updateRecentPagination() {
        const pageInfo = document.getElementById('recentPageInfo');
        const total = this.recentTotal || 0;
        const start = total === 0 ? 0 : (this.recentPage - 1) * this.recentPerPage + 1;
        const end = Math.min(this.recentPage * this.recentPerPage, total);
        if (pageInfo) pageInfo.textContent = `Showing ${start} to ${end} of ${total} entries`;
        const pageNumbers = document.getElementById('recentPageNumbers');
        if (!pageNumbers) return;
        const totalPages = this.recentTotalPages || 1;
        if (totalPages <= 1) {
            pageNumbers.innerHTML = '';
            return;
        }
        const nearby = new Set([1, totalPages, this.recentPage - 2, this.recentPage - 1, this.recentPage, this.recentPage + 1, this.recentPage + 2]);
        const numbers = [...nearby].filter(page => page >= 1 && page <= totalPages).sort((a, b) => a - b);
        const buttons = [];
        numbers.forEach((page, index) => {
            if (index && page > numbers[index - 1] + 1) buttons.push('<span class="px-1 text-muted" aria-hidden="true">…</span>');
            buttons.push(`<button type="button" class="btn btn-sm ${page === this.recentPage ? 'btn-success' : 'btn-outline-secondary'}" data-page="${page}" ${page === this.recentPage ? 'aria-current="page"' : ''}>${page}</button>`);
        });
        pageNumbers.innerHTML = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.recentPage - 1}" ${this.recentPage === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.recentPage + 1}" ${this.recentPage === totalPages ? 'disabled' : ''}>Next</button>`;
        pageNumbers.querySelectorAll('button[data-page]').forEach(button => button.addEventListener('click', () => {
            const page = Number(button.dataset.page);
            if (button.disabled || !Number.isInteger(page) || page < 1 || page > totalPages || page === this.recentPage) return;
            this.recentPage = page;
            this.loadRecentActivity();
        }));
    }

    async viewLoan(loanId) {
        try {
            const res = await fetch(`../../api/assessment/assessment-loan-management.php?action=details&loanId=${encodeURIComponent(loanId)}`, {
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
            if (content) content.innerHTML = renderModernLoanDetails(
                loan,
                (statusId) => {
                    const id = parseInt(statusId, 10);
                    const classes = { 1: 'bg-warning text-dark', 2: 'bg-success', 3: 'bg-danger', 4: 'bg-primary', 5: 'bg-success', 6: 'bg-warning text-dark', 7: 'bg-info text-white', 8: 'bg-secondary', 9: 'bg-secondary', 11: 'bg-warning text-dark', 12: 'bg-success' };
                    return classes[id] || 'bg-secondary';
                },
                (loanObj) => loanObj.loan_status_name || '-',
                { showVerifyButton: false, moduleName: 'assessmentDashboardModule' }
            );
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

    initCharts() {
        const pnStatusCtx = document.getElementById('pnStatusChart');
        if (pnStatusCtx && typeof Chart !== 'undefined') {
            this.pnStatusChart = new Chart(pnStatusCtx, {
                type: 'pie',
                data: {
                    labels: ['Approved', 'Tagged'],
                    datasets: [{
                        data: [0, 0],
                        backgroundColor: ['#198754', '#20c997']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom' }
                    }
                }
            });
        }

        if (this.pnStatusChart) {
            this.updatePNStatusChart({ approved: 0, tagged: 0 });
        }
    }

    updatePNStatusChart(data) {
        if (!this.pnStatusChart || !data) return;
        const approved = Number(data.approved) || 0;
        const tagged = Number(data.tagged) || 0;
        const ds = this.pnStatusChart.data.datasets[0];
        if (approved + tagged === 0) {
            this.pnStatusChart.data.labels = ['No approved / tagged loans yet'];
            ds.data = [1];
            ds.backgroundColor = ['#e2e8f0'];
        } else {
            this.pnStatusChart.data.labels = ['Approved', 'Tagged'];
            ds.data = [approved, tagged];
            ds.backgroundColor = ['#198754', '#20c997'];
        }
        this.pnStatusChart.update();
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
            this.modalLoanView = view;
            if (page === undefined) this.modalLoanPage = 1;
        }
        if (page !== undefined) this.modalLoanPage = page;

        const perPageEl = document.getElementById('loansModalPerPageSelect');
        if (perPageEl) this.modalLoanPerPage = parseInt(perPageEl.value, 10) || 25;

        const v = this.modalLoanView;
        let title = 'Loans';
        if (v === 'allApplications') {
            title = 'All Applications';
        } else if (v === 'approved') {
            title = 'Approved Applications';
        } else if (v === 'endorsed') {
            title = 'Endorsed Applications';
        } else if (v === 'pnTagged') {
            title = 'PN Tagged Applications';
        } else if (v === 'pendingToTag') {
            title = 'Pending PN Tagging';
        } else if (v === 'totalTagged') {
            title = 'All Tagged Loans';
        } else if (v === 'paid') {
            title = 'Paid Loans';
        } else if (v === 'partialPayment') {
            title = 'Partial Payment Loans';
        }

        titleEl.textContent = title;
        const iconEl = document.getElementById('loansModalIcon');
        const icons = {
            allApplications: 'bi-clipboard-data',
            approved: 'bi-check-circle-fill',
            endorsed: 'bi-send-check-fill',
            pnTagged: 'bi-file-earmark-check-fill',
            pendingToTag: 'bi-pin-map-fill',
            totalTagged: 'bi-list-check',
            paid: 'bi-cash-coin',
            partialPayment: 'bi-circle-half'
        };
        if (iconEl) iconEl.className = `bi ${icons[v] || 'bi-list-check'} me-2`;
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Loading...</td></tr>';

        const params = {
            action: 'modal_loans',
            view: v,
            page: String(this.modalLoanPage),
            perPage: String(this.modalLoanPerPage)
        };

        try {
            const qs = new URLSearchParams(params);
            const res = await fetch(`../../api/assessment/assessment-dashboard.php?${qs.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            const response = await res.json();

            const loans = response.success ? (response.rows || []) : [];
            this.modalLoanTotal = response.success ? (response.total || 0) : 0;
            this.modalLoanTotalPages = response.success ? (response.totalPages || 0) : 0;

            if (!loans || loans.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No loans found</td></tr>`;
            } else {
                tbody.innerHTML = loans.map(loan => {
                    const statusBadge = this.getStatusBadge(loan.statusId, loan.statusName);
                    const paymentStatusBadge = this.getPaymentStatusBadge(loan.paymentStatus);
                    const pnStatusBadge = this.getPnStatusBadge(loan.pnStatus);
                    const dateVal = loan.date;
                    return `
                        <tr>
                            <td class="text-center">${escapeHtml(loan.applicationNo || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.schoolId || '-')}</td>
                            <td class="text-center">${escapeHtml(loan.name || '-')}</td>
                            <td class="text-center">₱${parseFloat(loan.amount || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="text-center">${statusBadge}</td>
                            <td class="text-center">${paymentStatusBadge}</td>
                            <td class="text-center">${pnStatusBadge}</td>
                            <td class="text-center">${dateVal ? new Date(dateVal).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '-'}</td>
                        </tr>
                    `;
                }).join('');
            }

            this.updateLoansModalPaginationUI();
            this.loansListModal && this.loansListModal.show();
        } catch (error) {
            console.error('Error loading modal loans:', error);
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">Error loading loans</td></tr>`;
            this.modalLoanTotal = 0;
            this.modalLoanTotalPages = 0;
            this.updateLoansModalPaginationUI();
        }
    }

    bindExport() {
        const exportBtn = document.getElementById('exportActivityBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportActivity());
        }
    }

    async exportActivity() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            const exportParams = this.buildRecentActivityQueryParams();
            exportParams.set('limit', '200');
            const res = await fetch(`../../api/assessment/assessment-dashboard.php?${exportParams.toString()}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const response = await res.json();

            if (!response.success || !response.data) {
                throw new Error('Failed to fetch activity data for export');
            }

            const rows = response.data || [];

            if (rows.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No activity found to export.',
                    confirmButtonText: 'OK',
                    buttonsStyling: false,
                    customClass: { confirmButton: 'btn btn-success px-4' }
                });
                return;
            }

            // Ask user for format
            const result = await swal.fire({
                title: 'Export Loan History',
                input: 'select',
                inputOptions: { 
                    csv: 'CSV (.csv)', 
                    doc: 'Word (.doc)',
                    xls: 'Excel (.xls)',
                    pdf: 'PDF (.pdf)'
                },
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

            const choice = result.value;

            if (choice === 'pdf') {
                this.exportPDF(rows);
                return;
            }

            if (choice === 'csv') {
                const csvRows = rows.map(r => ({
                    'Application No': r.loan_application_no || '',
                    'Student Name': r.student_name || '',
                    'Amount': parseFloat(r.loan_amount_can_pay || 0).toFixed(2),
                    'Status': r.loan_status_name || '',
                    'Payment Status': this.getPaymentStatusText(r.payment_status),
                    'PN Status': this.getPnStatusText(r.pn_status),
                    'Date': this.formatTaggedDate(r.date_tagged)
                }));
                
                const headers = Object.keys(csvRows[0] || {});
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                const csv = [headers.join(',')].concat(csvRows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
                const bom = '\uFEFF';
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `assessment_activity_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }

            if (choice === 'xls') {
                const xlsRows = rows.map(r => ({
                    'Application No': r.loan_application_no || '',
                    'Student Name': r.student_name || '',
                    'Amount': parseFloat(r.loan_amount_can_pay || 0).toFixed(2),
                    'Status': r.loan_status_name || '',
                    'Payment Status': this.getPaymentStatusText(r.payment_status),
                    'PN Status': this.getPnStatusText(r.pn_status),
                    'Date': this.formatTaggedDate(r.date_tagged)
                }));
                
                const headers = Object.keys(xlsRows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = xlsRows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
                this.downloadBlob(blob, `assessment_activity_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }

            if (choice === 'doc') {
                const docRows = rows.map(r => ({
                    'Application No': r.loan_application_no || '',
                    'Student Name': r.student_name || '',
                    'Amount': parseFloat(r.loan_amount_can_pay || 0).toFixed(2),
                    'Status': r.loan_status_name || '',
                    'Payment Status': this.getPaymentStatusText(r.payment_status),
                    'PN Status': this.getPnStatusText(r.pn_status),
                    'Date': this.formatTaggedDate(r.date_tagged)
                }));
                
                const headers = Object.keys(docRows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;background:#f0f0f0;">${h}</th>`).join('');
                const trs = docRows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<html><body><h2>Assessment Loan History Report</h2><p>Generated: ${new Date().toLocaleString()}</p><table style="border-collapse:collapse;width:100%;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
                const blob = new Blob([html], { type: 'application/msword' });
                this.downloadBlob(blob, `assessment_activity_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }

        } catch (error) {
            console.error('Error exporting activity:', error);
            await swal.fire({
                icon: 'error',
                title: 'Export Failed',
                text: error.message || 'Failed to export data',
                confirmButtonText: 'OK',
                buttonsStyling: false,
                customClass: { confirmButton: 'btn btn-danger px-4' }
            });
        }
    }

    exportPDF(rows) {
        // Professional PDF export with enhanced HTML print design
        const headers = Object.keys(rows[0] || {});
        
        // Build filter summary
        const filterParts = [];
        const semesterSelect = document.getElementById('recentFilterSemester') || document.getElementById('recentFilterSemesterMobile');
        const schoolYearSelect = document.getElementById('recentFilterSchoolYear') || document.getElementById('recentFilterSchoolYearMobile');
        const periodSelect = document.getElementById('recentFilterPeriod') || document.getElementById('recentFilterPeriodMobile');
        
        if (this.recentActivityFilters.semester && semesterSelect) {
            const selectedOption = Array.from(semesterSelect.options).find(opt => opt.value === this.recentActivityFilters.semester);
            if (selectedOption) filterParts.push(`Semester: ${selectedOption.text}`);
        }
        if (this.recentActivityFilters.schoolYear && schoolYearSelect) {
            const selectedOption = Array.from(schoolYearSelect.options).find(opt => opt.value === this.recentActivityFilters.schoolYear);
            if (selectedOption) filterParts.push(`School Year: ${selectedOption.text}`);
        }
        if (this.recentActivityFilters.period && periodSelect) {
            const selectedOption = Array.from(periodSelect.options).find(opt => opt.value === this.recentActivityFilters.period);
            if (selectedOption) filterParts.push(`Period: ${selectedOption.text}`);
        }
        if (this.recentActivityFilters.search) filterParts.push(`Search: "${this.recentActivityFilters.search}"`);
        
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
                <title>Assessment Loan History Report</title>
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
                            <h2>Loan History Report - Assessment Office</h2>
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

    getPaymentStatusText(statusId) {
        const id = parseInt(statusId, 10);
        if (id === 3) return 'Paid';
        if (id === 2) return 'Partial Payment';
        if (id === 4) return 'Paid Pending';
        if (id === 5) return 'Paid Partial';
        if (id === 1) return 'Not Paid';
        return 'Not Set';
    }

    getPnStatusText(statusId) {
        const id = parseInt(statusId, 10);
        if (id === 2) return 'Tagged';
        if (id === 1) return 'Not Tagged';
        return 'Not Set';
    }
}

export default AssessmentDashboardModule;
