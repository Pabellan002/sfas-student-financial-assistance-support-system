import AppPaths from '../../services/services-appPaths.js';
import SessionCheckerModule from '../auth/auth-sessionCheckerModule.js';
import { escapeHtml } from '../../shared/shared-escape.js';

class CooDashboardModule {
    constructor() {
        this.chart = null;
        this.currentView = 'statusBreakdown';
        this.currentChartData = { labels: [], values: [] };
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
        const on = (sel, evt, fn) => {
            const el = document.querySelector(sel);
            if (el) el.addEventListener(evt, fn);
        };
        on('#pendingModal', 'shown.bs.modal', () => this.populatePending());
        on('#totalModal', 'shown.bs.modal', () => this.populateTotal());
        on('#approvedModal', 'shown.bs.modal', () => this.populateApproved());
        
    }

    async populatePending() {
        await this.populateTable('pending', 'pendingTableBody', [
            'applicationNo',
            'schoolId',
            'name',
            'amount',
            'balance',
            'dateApplied',
        ]);
    }

    async populateTotal() {
        await this.populateTable('total', 'totalTableBody', [
            'applicationNo',
            'schoolId',
            'name',
            'amount',
            'status',
            'dateApplied',
        ]);
    }

    async populateApproved() {
        await this.populateTable('approved', 'approvedTableBody', [
            'applicationNo',
            'schoolId',
            'name',
            'amount',
            'status',
            'dateApplied',
        ]);
    }

    async populateTable(kind, tbodyId, cols) {
        try {
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ detail: kind + 'List' });
            const res = await fetch(
                `${base}/coo/coo-dashboard.php?${query}`,
                { credentials: 'same-origin', cache: 'no-store' }
            );
            const d = await res.json();
            const rows = Array.isArray(d?.rows) ? d.rows : [];
            const tbody = document.getElementById(tbodyId);
            if (!tbody) return;
            if (rows.length === 0) {
                tbody.innerHTML =
                    '<tr><td colspan="' +
                    cols.length +
                    '" class="text-center text-muted">No data</td></tr>';
                return;
            }
            tbody.innerHTML = rows
                .map(
                    (r) =>
                        '<tr>' +
                        cols
                            .map((k) => {
                                let val = r?.[k] ?? '';
                                if (k === 'amount' || k === 'balance') {
                                    val = val
                                        ? '₱' +
                                          parseFloat(val).toLocaleString('en-US', {
                                              minimumFractionDigits: 2,
                                              maximumFractionDigits: 2,
                                          })
                                        : '₱0.00';
                                } else if (k.includes('date')) {
                                    val = val ? new Date(val).toLocaleDateString() : '';
                                } else if (k === 'status' && val) {
                                    // Style status badges
                                    const statusLower = String(val).toLowerCase();
                                    let badgeClass = 'bg-secondary';
                                    if (statusLower === 'pending') badgeClass = 'bg-warning text-dark';
                                    else if (statusLower === 'approved') badgeClass = 'bg-success';
                                    else if (statusLower === 'returned') badgeClass = 'bg-warning text-dark';
                                    else if (statusLower === 'partial payment') badgeClass = 'bg-warning text-dark';
                                    val = `<span class="badge ${badgeClass}">${escapeHtml(String(val))}</span>`;
                                    return `<td>${val}</td>`;
                                }
                                return `<td>${escapeHtml(String(val))}</td>`;
                            })
                            .join('') +
                        '</tr>'
                )
                .join('');
        } catch (_) {}
    }

    async loadSummary() {
        try {
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ action: 'summary' });
            const res = await fetch(`${base}/coo/coo-dashboard.php?${query}`, {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const data = await res.json();
            const s = data?.summary || {};
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(val ?? 0);
            };
            set('numPending', s.pending);
            set('numTotal', s.total);
            set('numApproved', s.approved);
        } catch (_) {}
    }

    bindFilters() {
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
            const response = await fetch(`${base}/coo/coo-dashboard.php?action=filters`, { credentials: 'same-origin', cache: 'no-store' });
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
            const res = await fetch(`${base}/coo/coo-dashboard.php?${query}`, {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            
            // Check if response is ok
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            
            // Get response text first to debug
            const text = await res.text();
            
            // Try to parse JSON
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw e;
            }
            let labels = data?.labels || [];
            let values = data?.values || [];

            this.currentChartData = { labels: [...labels], values: [...values] };

            if (!Array.isArray(labels) || !Array.isArray(values) || labels.length === 0 || values.length === 0) {
                labels = ['No data'];
                values = [1];
                this.currentChartData = { labels: [], values: [] };
            }

            const ctx = document.getElementById('mainPieChart');
            if (!ctx) return;
            if (this.chart) {
                this.chart.destroy();
            }
            const colors =
                labels.length === 1 && labels[0] === 'No data' ? ['#e9ecef'] : this.makeColors(values.length);

            const total = values.reduce((sum, val) => sum + (Number(val) || 0), 0);

            const labelsWithInfo = labels.map((label, index) => {
                const count = Number(values[index]) || 0;
                const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
                return `${label} (${count} - ${percentage}%)`;
            });

            const originalLabels = [...labels];
            const chartTotal = total;

            const isMobile = window.innerWidth <= 768;
            const fontSize = isMobile ? 10 : 12;

            // eslint-disable-next-line no-undef
            this.chart = new Chart(ctx, {
                type: 'pie',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            data: values,
                            backgroundColor: colors,
                            borderWidth: 2,
                            borderColor: '#fff',
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false,
                        },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    const label = originalLabels[context.dataIndex] || '';
                                    const value = context.parsed || 0;
                                    const percentage =
                                        chartTotal > 0 ? ((value / chartTotal) * 100).toFixed(1) : '0.0';
                                    return `${label}: ${value} (${percentage}%)`;
                                },
                            },
                        },
                        datalabels: {
                            color: '#fff',
                            font: {
                                weight: 'bold',
                                size: fontSize,
                            },
                            formatter: (value, ctx) => {
                                const label = originalLabels[ctx.dataIndex] || '';
                                const percentage = chartTotal > 0 ? ((value / chartTotal) * 100).toFixed(1) : '0.0';
                                return `${label}\n${value} (${percentage}%)`;
                            },
                        },
                    },
                },
                plugins: [ChartDataLabels],
            });
        } catch (err) {
            // Error rendering chart
        }
    }

    makeColors(n) {
        const pal = [
            '#198754',
            '#20c997',
            '#0dcaf0',
            '#6f42c1',
            '#fd7e14',
            '#ffc107',
            '#dc3545',
            '#0d6efd',
            '#6c757d',
            '#6610f2',
        ];
        const out = [];
        for (let i = 0; i < n; i++) out.push(pal[i % pal.length]);
        return out;
    }

    getBaseURL() {
        return AppPaths.apiBase;
    }

    viewTitle(view) {
        switch (view) {
            case 'appsDaily':
                return 'Daily Applications';
            case 'appsWeekly':
                return 'Weekly Applications';
            case 'appsMonthly':
                return 'Monthly Applications';
            case 'appsYearly':
                return 'Yearly Applications';
            case 'statusBreakdown':
                return 'Status Breakdown';
            default:
                return 'Statistics';
        }
    }

    bindExport() {
        const button = document.getElementById('exportStatsBtn');
        if (button) button.addEventListener('click', () => this.showExportModal());
    }

    async showExportModal() {
        const swal = window.Swal;
        if (!swal) return;

        // Check if there's data to export BEFORE showing format selection
        const { labels, values } = this.currentChartData;
        
        if (!labels || !values || labels.length === 0 || values.length === 0 || values.every((value) => Number(value) === 0) ||
            (labels.length === 1 && labels[0] === 'No data')) {
            await swal.fire({
                icon: 'warning',
                title: 'No Data',
                text: 'There is no data to export.',
                confirmButtonColor: '#198754'
            });
            return;
        }

        const result = await swal.fire({
            title: `Export ${this.viewTitle(this.currentView)}`,
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

        await this.exportData(result.value);
    }

    async exportData(format) {
        const swal = window.Swal;
        if (!swal) return;

        try {
            // Fetch detailed loan data with current filters instead of just chart data
            const base = this.getBaseURL();
            const query = this.buildFilterQuery({ detail: 'exportList' });
            const res = await fetch(`${base}/coo/coo-dashboard.php?${query}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const data = await res.json();
            const loans = Array.isArray(data?.rows) ? data.rows : [];

            if (loans.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No loan applications found matching the current filters.',
                    confirmButtonText: 'OK'
                });
                return;
            }

            // Map loans to export format
            const rows = loans.map(loan => ({
                'Application No': loan.applicationNo || loan.loan_application_no || '',
                'Student ID': loan.schoolId || loan.student_school_id || '',
                'Student Name': loan.name || loan.student_name || '',
                'Amount': loan.amount || loan.loan_amount_can_pay || '0.00',
                'Balance': loan.balance || loan.balance_total_balance || '0.00',
                'Status': loan.status || loan.statusName || loan.loan_status_name || '',
                'Date Applied': loan.dateApplied || loan.loan_created_at || ''
            }));

            const title = 'COO Dashboard Export';

            if (format === 'csv') {
                const headers = Object.keys(rows[0] || {});
                const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
                const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
                const bom = '\uFEFF';
                this.downloadBlob(new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' }), `coo_dashboard_${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }

            if (format === 'xls') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th>${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
                const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
                this.downloadBlob(blob, `coo_dashboard_${new Date().toISOString().split('T')[0]}.xls`);
                return;
            }

            if (format === 'doc') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #000;padding:5px;">${h}</th>`).join('');
                const trs = rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #000;padding:5px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
                const html = `<html><body><h2>${title}</h2><p>Generated: ${new Date().toLocaleString()}</p><table style="border-collapse:collapse;width:100%;">${th}${trs}</table></body></html>`;
                const blob = new Blob([html], { type: 'application/msword' });
                this.downloadBlob(blob, `coo_dashboard_${new Date().toISOString().split('T')[0]}.doc`);
                return;
            }

            if (format === 'pdf') {
                const headers = Object.keys(rows[0] || {});
                const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;">${h}</th>`).join('');
                const trs = rows.map((r, idx) => {
                    const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                    return `<tr style="background-color:${bgColor};">${headers.map(h => `<td style="border:1px solid #dee2e6;padding:8px;font-size:11px;">${String(r[h] ?? '')}</td>`).join('')}</tr>`;
                }).join('');
                
                // Build filter summary
                const filterParts = [];
                if (this.filters.schoolYear) filterParts.push(`School Year: ${document.getElementById('dashboardSchoolYear')?.selectedOptions[0]?.text || this.filters.schoolYear}`);
                if (this.filters.semester) filterParts.push(`Semester: ${document.getElementById('dashboardSemester')?.selectedOptions[0]?.text || this.filters.semester}`);
                if (this.filters.period) filterParts.push(`Period: ${document.getElementById('dashboardPeriod')?.selectedOptions[0]?.text || this.filters.period}`);
                if (this.filters.department) filterParts.push(`Department: ${document.getElementById('dashboardDepartment')?.selectedOptions[0]?.text || this.filters.department}`);
                if (this.filters.program) filterParts.push(`Program: ${document.getElementById('dashboardProgram')?.selectedOptions[0]?.text || this.filters.program}`);
                if (this.filters.yearLevel) filterParts.push(`Year Level: ${document.getElementById('dashboardYearLevel')?.selectedOptions[0]?.text || this.filters.yearLevel}`);
                const filterHtml = filterParts.length > 0 ? `<div class="filters"><strong>Applied Filters:</strong> ${filterParts.join(' | ')}</div>` : '';
                
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>${title}</title>
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
                            .stats { display: flex; gap: 15px; margin: 15px 0; }
                            .stat-box { flex: 1; background: #f8f9fa; padding: 12px; border-radius: 4px; text-align: center; border: 1px solid #dee2e6; }
                            .stat-box .label { font-size: 11px; color: #666; margin-bottom: 5px; }
                            .stat-box .value { font-size: 20px; font-weight: bold; color: #198754; }
                            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                            th { font-size: 11px; }
                            .footer { margin-top: 30px; padding-top: 15px; border-top: 2px solid #198754; text-align: center; font-size: 10px; color: #666; }
                            @media print { 
                                body { padding: 0; }
                                .no-print { display: none; }
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
                                    <h2>${title}</h2>
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
                    printWindow.onload = () => {
                        printWindow.print();
                    };
                }
                return;
            }
        } catch (err) {
            console.error('Export error:', err);
            swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to export data. Please try again.',
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
}

export default CooDashboardModule;
