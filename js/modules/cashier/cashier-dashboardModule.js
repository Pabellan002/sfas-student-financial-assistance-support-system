import AppPaths from '../../services/services-appPaths.js';
import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';

class CashierDashboardModule {
    constructor() {
        this.chart = null;
        this.currentView = 'statusBreakdown';
        this.currentData = { labels: [], values: [] };
        this.allPrograms = [];
        this.filters = { schoolYear: '', semester: '', period: '', department: '', program: '', yearLevel: '' };
    }

    async init() {
        await this.ensureSession();
        await this.loadFilters();
        this.bindFilters();
        this.bindExport();
        await this.refreshDashboard();
        this.bindModals();
    }

    async ensureSession() {
        const checker = new SessionCheckerModule();
        await checker.ensureActive();
    }

    bindModals() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };
        on('#pendingModal', 'shown.bs.modal', () => this.populatePending());
        on('#totalModal', 'shown.bs.modal', () => this.populateTotal());
    }

    async populatePending() {
        await this.populateTable('pendingPaymentTagging', 'pendingTableBody', ['applicationNo','schoolId','name','amount','paymentStatus','dueDate']);
    }

    async populateTotal() {
        await this.populateTable('total', 'totalTableBody', ['applicationNo','schoolId','name','amount','paymentStatus','dateApplied']);
    }

    async populateTable(kind, tbodyId, cols) {
        try {
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ detail: kind + 'List' });
            const res = await fetch(`${base}/cashier/cashier-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const d = await res.json();
            const rows = Array.isArray(d?.rows) ? d.rows : [];
            const tbody = document.getElementById(tbodyId);
            if (!tbody) return;
            if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="'+cols.length+'" class="text-center text-muted">No data</td></tr>'; return; }
            tbody.innerHTML = rows.map(r => '<tr>'+cols.map(k => {
                let val = r?.[k] ?? '';
                if (k === 'amount' || k === 'balance') {
                    val = val ? '₱' + parseFloat(val).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '₱0.00';
                } else if (k === 'pnStatus') {
                    const paid = String(val).toLowerCase() === 'paid';
                    val = `<span class="badge ${paid ? 'bg-success' : 'bg-secondary'}">${escapeHtml(val || 'Not Set')}</span>`;
                    return `<td class="text-center">${val}</td>`;
                } else if (k.toLowerCase().includes('date')) {
                    val = val ? new Date(val).toLocaleDateString() : '';
                } else if (k === 'paymentStatus') {
                    // Add badge styling for payment status
                    const statusLower = String(val).toLowerCase();
                    let badgeClass = 'bg-secondary';
                    if (statusLower.includes('not paid')) {
                        badgeClass = 'bg-warning text-dark';
                    } else if (statusLower === 'paid partial' || statusLower === 'partial payment') {
                        badgeClass = 'bg-warning text-dark';
                    } else if (statusLower.includes('paid pending')) {
                        badgeClass = 'bg-info text-dark';
                    } else if (statusLower.includes('paid')) {
                        badgeClass = 'bg-success';
                    }
                    val = `<span class="badge ${badgeClass}">${escapeHtml(val)}</span>`;
                    return `<td class="text-center">${val}</td>`;
                } else if (k === 'status') {
                    // Add badge styling for status
                    const statusLower = String(val).toLowerCase();
                    let badgeClass = 'bg-secondary';
                    if (statusLower.includes('pending')) {
                        badgeClass = 'bg-warning text-dark';
                    } else if (statusLower.includes('approved') || statusLower.includes('completed')) {
                        badgeClass = 'bg-success';
                    } else if (statusLower.includes('declined') || statusLower.includes('rejected')) {
                        badgeClass = 'bg-danger';
                    } else if (statusLower.includes('active')) {
                        badgeClass = 'bg-info';
                    }
                    val = `<span class="badge ${badgeClass}">${escapeHtml(val)}</span>`;
                    return `<td class="text-center">${val}</td>`;
                }
                return `<td class="text-center">${escapeHtml(val)}</td>`;
            }).join('')+'</tr>').join('');
        } catch (_) {}
    }

    async loadSummary() {
        try {
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ action: 'summary' });
            const res = await fetch(`${base}/cashier/cashier-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            const s = data?.summary || {};
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
            set('numPendingPaymentTagging', s.pendingPaymentTagging);
            set('numTotal', s.total);
        } catch (_) {}
    }

    bindFilters() {
        const buttons = document.querySelectorAll('#filtersContainer [data-view]');
        const setActive = (view) => {
            buttons.forEach((btn) => {
                const v = btn.getAttribute('data-view');
                const on = v === view;
                btn.classList.toggle('csdl-filter-active', on);
                btn.setAttribute('aria-selected', on ? 'true' : 'false');
            });
        };
        buttons.forEach((btn) => {
            btn.addEventListener('click', async () => {
                const view = btn.getAttribute('data-view');
                this.currentView = view;
                setActive(view);
                await this.renderPie(view);
            });
        });

        const onFilterChange = (id, callback = null) => {
            const select = document.getElementById(id);
            if (select) select.addEventListener('change', async () => {
                this.syncFiltersFromDom();
                if (callback) callback();
                await this.refreshDashboard();
            });
        };
        onFilterChange('dashboardSchoolYear');
        onFilterChange('dashboardSemester');
        onFilterChange('dashboardPeriod');
        onFilterChange('dashboardDepartment', () => {
            this.filters.program = '';
            const program = document.getElementById('dashboardProgram');
            if (program) program.value = '';
            this.refreshProgramOptions();
        });
        onFilterChange('dashboardProgram');
        onFilterChange('dashboardYearLevel');
        setActive(this.currentView);
    }

    syncFiltersFromDom() {
        const get = (id) => document.getElementById(id)?.value ?? '';
        this.filters.schoolYear = get('dashboardSchoolYear');
        this.filters.semester = get('dashboardSemester');
        this.filters.period = get('dashboardPeriod');
        this.filters.department = get('dashboardDepartment');
        this.filters.program = get('dashboardProgram');
        this.filters.yearLevel = get('dashboardYearLevel');
    }

    buildFilterQuery(extra = {}) {
        this.syncFiltersFromDom();
        const params = new URLSearchParams();
        Object.entries({ ...this.filters, ...extra }).forEach(([key, value]) => {
            if (value !== '' && value != null) params.set(key, value);
        });
        return params.toString();
    }

    populateSelect(id, items, valueKey, labelKey, defaultLabel) {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        select.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>`;
        (items || []).forEach((item) => {
            const option = document.createElement('option');
            option.value = item[valueKey];
            option.textContent = item[labelKey] || '';
            select.appendChild(option);
        });
        if ([...select.options].some((option) => option.value === current)) select.value = current;
    }

    refreshProgramOptions() {
        const select = document.getElementById('dashboardProgram');
        if (!select) return;
        const current = select.value;
        const departmentId = this.filters.department;
        select.innerHTML = '<option value="">All programs</option>';
        this.allPrograms
            .filter((program) => !departmentId || String(program.program_department_id) === String(departmentId))
            .forEach((program) => {
                const option = document.createElement('option');
                option.value = program.program_id;
                option.textContent = program.program_name;
                select.appendChild(option);
            });
        select.value = [...select.options].some((option) => option.value === current) ? current : '';
    }

    async loadFilters() {
        try {
            const base = this.getBaseURL();
            const response = await fetch(`${base}/cashier/cashier-dashboard.php?action=filters`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json();
            if (!data?.success) return;
            this.allPrograms = Array.isArray(data.programs) ? data.programs : [];
            this.populateSelect('dashboardSchoolYear', data.schoolYears, 'sy_id', 'sy_code', 'All school years');
            this.populateSelect('dashboardSemester', data.semesters, 'semester_id', 'semester_name', 'All semesters');
            this.populateSelect('dashboardPeriod', data.periods, 'app_period_id', 'app_period_name', 'All periods');
            this.populateSelect('dashboardDepartment', data.departments, 'department_id', 'department_name', 'All departments');
            this.populateSelect('dashboardYearLevel', data.yearLevels, 'year_level_id', 'year_level_name', 'All year levels');
            this.refreshProgramOptions();
        } catch (_) {}
    }

    async refreshDashboard() {
        await Promise.all([this.loadSummary(), this.renderPie(this.currentView)]);
    }

    async renderPie(view) {
        try {
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ view });
            const res = await fetch(`${base}/cashier/cashier-dashboard.php?${query}`, { 
                credentials: 'same-origin', 
                cache: 'no-store' 
            });
            
            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            
            const text = await res.text();
            
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw e;
            }
            
            let labels = data?.labels || [];
            let values = data?.values || [];

            // Store current data for export
            this.currentData = { labels: [...labels], values: [...values] };

            if (!Array.isArray(labels) || !Array.isArray(values) || labels.length === 0 || values.length === 0) {
                labels = ['No data'];
                values = [1];
                this.currentData = { labels: [], values: [] };
            }

            const ctx = document.getElementById('mainPieChart');
            if (!ctx) return;
            if (this.chart) { this.chart.destroy(); }
            const isEmptyChart = labels.length === 1 && labels[0] === 'No data';
            const colors = isEmptyChart ? ['#e9ecef'] : this.makeColors(values.length);
            
            const total = values.reduce((sum, val) => sum + (Number(val) || 0), 0);
            const originalLabels = [...labels];
            const chartTotal = total;
            
            const isMobile = window.innerWidth <= 768;
            const fontSize = isMobile ? 10 : 12;
            
            // eslint-disable-next-line no-undef
            this.chart = new Chart(ctx, {
                type: 'pie',
                data: { 
                    labels: labels, 
                    datasets: [{ 
                        data: values, 
                        backgroundColor: colors, 
                        borderWidth: 2,
                        borderColor: '#fff'
                    }] 
                },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false,
                    plugins: { 
                        legend: { 
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const label = originalLabels[context.dataIndex] || '';
                                    const value = context.parsed || 0;
                                    const percentage = chartTotal > 0 ? ((value / chartTotal) * 100).toFixed(1) : '0.0';
                                    return `${label}: ${value} (${percentage}%)`;
                                }
                            }
                        },
                        datalabels: {
                            color: isEmptyChart ? '#475569' : '#fff',
                            font: {
                                weight: 'bold',
                                size: fontSize
                            },
                            formatter: (value, ctx) => {
                                const label = originalLabels[ctx.dataIndex] || '';
                                const percentage = chartTotal > 0 ? ((value / chartTotal) * 100).toFixed(1) : '0.0';
                                return `${label}\n${value} (${percentage}%)`;
                            }
                        }
                    }
                },
                plugins: [ChartDataLabels]
            });
        } catch (err) {
            // Error rendering chart
        }
    }

    makeColors(n) {
        const pal = ['#198754','#20c997','#0dcaf0','#6f42c1','#fd7e14','#ffc107','#dc3545','#0d6efd','#6c757d','#6610f2'];
        const out = [];
        for (let i = 0; i < n; i++) out.push(pal[i % pal.length]);
        return out;
    }

    getBaseURL() {
        return AppPaths.apiBase;
    }

    viewTitle(view) {
        switch (view) {
            case 'appsDaily': return 'Daily Applications';
            case 'appsWeekly': return 'Weekly Applications';
            case 'appsMonthly': return 'Monthly Applications';
            case 'appsYearly': return 'Yearly Applications';
            case 'statusBreakdown': return 'Status Breakdown';
            default: return 'Statistics';
        }
    }

    bindExport() {
        const btn = document.getElementById('exportStatsBtn');
        if (btn) {
            btn.addEventListener('click', () => this.exportStatistics());
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

    async exportStatistics() {
        const swal = window.Swal;
        if (!swal) return;

        try {
            // Ensure filters are synced from DOM before building query
            this.syncFiltersFromDom();
            
            // Fetch filtered loan data for export
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ detail: 'exportList' });
            const res = await fetch(`${base}/cashier/cashier-dashboard.php?${query}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            
            const loans = Array.isArray(data?.rows) ? data.rows : [];
            
            if (loans.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'There are no loan applications matching the current filters to export.',
                    confirmButtonColor: '#198754'
                });
                return;
            }

            // Show format selection
            const result = await swal.fire({
                title: `Export Loan Applications (${loans.length} records)`,
                input: 'select',
                inputOptions: { 
                    csv: 'CSV (.csv)', 
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
                    confirmButton: 'btn btn-success px-4 me-2', 
                    cancelButton: 'btn btn-secondary px-4'
                }
            });

            if (!result.isConfirmed) return;

            // Map loans to export format
            const rows = loans.map(loan => ({
                'Application No.': loan.applicationNo || '',
                'Student ID': loan.schoolId || '',
                'Student Name': loan.name || '',
                'Amount': loan.amount ? parseFloat(loan.amount).toFixed(2) : '0.00',
                'Payment Status': loan.paymentStatus || 'Not Paid',
                'Date Applied': loan.dateApplied || '',
                'Status': loan.statusName || ''
            }));

            const choice = result.value;
            const filename = `cashier_loans_${new Date().toISOString().split('T')[0]}`;

            if (choice === 'csv') {
                const headers = Object.keys(rows[0] || {});
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
                const bom = '\uFEFF';
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `${filename}.csv`);
                return;
            }

            if (choice === 'xls') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `${filename}.xls`);
                return;
            }

            if (choice === 'doc') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:8px;background:#f0f0f0;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:8px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `
                    <html>
                    <head><meta charset="utf-8"><title>Cashier Loan Applications</title></head>
                    <body>
                        <h2>Cashier Loan Applications Export</h2>
                        <p>Generated on: ${new Date().toLocaleString()}</p>
                        <p>Total Records: ${rows.length}</p>
                        <table style="border-collapse:collapse;width:100%;margin-top:20px;">
                            <thead><tr>${th}</tr></thead>
                            <tbody>${trs}</tbody>
                        </table>
                    </body>
                    </html>
                `;
                this.downloadBlob(new Blob([html], { type: 'application/msword' }), `${filename}.doc`);
                return;
            }

            if (choice === 'pdf') {
                this.exportPDF(rows);
            }
        } catch (error) {
            console.error('Export error:', error);
            await swal.fire({
                icon: 'error',
                title: 'Export Failed',
                text: 'Failed to export loan applications. Please try again.',
                confirmButtonColor: '#198754'
            });
        }
    }

    exportPDF(rows) {
        // Professional PDF export with enhanced design using HTML print
        const headers = Object.keys(rows[0] || {});
        
        // Build filter summary
        const filterParts = [];
        const schoolYearSelect = document.getElementById('dashboardSchoolYear');
        const semesterSelect = document.getElementById('dashboardSemester');
        const periodSelect = document.getElementById('dashboardPeriod');
        const departmentSelect = document.getElementById('dashboardDepartment');
        const programSelect = document.getElementById('dashboardProgram');
        const yearLevelSelect = document.getElementById('dashboardYearLevel');
        
        if (this.filters.schoolYear && schoolYearSelect) {
            const selectedOption = Array.from(schoolYearSelect.options).find(opt => opt.value === this.filters.schoolYear);
            if (selectedOption) filterParts.push(`School Year: ${selectedOption.text}`);
        }
        if (this.filters.semester && semesterSelect) {
            const selectedOption = Array.from(semesterSelect.options).find(opt => opt.value === this.filters.semester);
            if (selectedOption) filterParts.push(`Semester: ${selectedOption.text}`);
        }
        if (this.filters.period && periodSelect) {
            const selectedOption = Array.from(periodSelect.options).find(opt => opt.value === this.filters.period);
            if (selectedOption) filterParts.push(`Period: ${selectedOption.text}`);
        }
        if (this.filters.department && departmentSelect) {
            const selectedOption = Array.from(departmentSelect.options).find(opt => opt.value === this.filters.department);
            if (selectedOption) filterParts.push(`Department: ${selectedOption.text}`);
        }
        if (this.filters.program && programSelect) {
            const selectedOption = Array.from(programSelect.options).find(opt => opt.value === this.filters.program);
            if (selectedOption) filterParts.push(`Program: ${selectedOption.text}`);
        }
        if (this.filters.yearLevel && yearLevelSelect) {
            const selectedOption = Array.from(yearLevelSelect.options).find(opt => opt.value === this.filters.yearLevel);
            if (selectedOption) filterParts.push(`Year Level: ${selectedOption.text}`);
        }
        
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
                <title>Cashier Loan Applications Report</title>
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
                            <h2>Loan Applications Report - Cashier Office</h2>
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
}

export default CashierDashboardModule;

