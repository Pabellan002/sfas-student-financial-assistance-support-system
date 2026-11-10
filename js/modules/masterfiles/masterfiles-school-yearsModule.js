import AppPaths from '../../services/services-appPaths.js';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { INLINE_ACTION_IGNORE, masterfileEditToggleDelete } from '../../shared/shared-inline-actions.js';

const bulkSelectionHeading = '<input type="checkbox" class="form-check-input" data-bulk-all aria-label="Select all records on this page" hidden>';

function bulkSelectionCell(id) {
    return `<span data-record-id="${escapeHtml(String(id))}"><input type="checkbox" class="form-check-input" data-bulk-id="${escapeHtml(String(id))}" aria-label="Select record ${escapeHtml(String(id))}" hidden></span>`;
}

class MasterfilesSchoolYearsModule {
    async bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        const tableId = 'schoolYearsTable';
        const refreshId = 'refreshBtn';
        const resource = 'school_years';
        const endpoint = '/masterfiles/masterfiles-school-years.php';
        const idField = 'sy_id';
        const onReload = () => location.reload();
        await rbacUtil.init();
        if (!rbacUtil.hasPermission(`csdl.masterfiles.${resource}.delete`)) return;
        const table = document.getElementById(tableId);
        const refresh = document.getElementById(refreshId);
        if (!table || !refresh) return;
        this._bulkDeleteBound = true;
        refresh.parentElement.classList.add('flex-wrap');
        const selected = this.selectedRecordIds = new Set();
        let busy = false;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-danger btn-sm';
        refresh.insertAdjacentElement('afterend', button);

        const boxes = () => [...table.querySelectorAll('tbody input[data-bulk-id]')];
        const sync = () => {
            const visible = boxes();
            visible.forEach(box => {
                box.hidden = false;
                box.checked = selected.has(box.dataset.bulkId);
                box.disabled = busy;
            });
            const all = table.querySelector('[data-bulk-all]');
            if (all) {
                all.hidden = false;
                all.disabled = busy || !visible.length;
                const count = visible.filter(box => box.checked).length;
                all.checked = visible.length > 0 && count === visible.length;
                all.indeterminate = count > 0 && count < visible.length;
            }
            button.disabled = busy || !selected.size;
            button.textContent = busy ? 'Deleting…' : `Delete Selected (${selected.size})`;
        };
        // Capture clicks before existing row handlers can open details or sort the column.
        table.addEventListener('click', event => {
            if (event.target.closest('[data-bulk-id], [data-bulk-all]')) event.stopPropagation();
        }, true);
        table.addEventListener('change', event => {
            const box = event.target;
            if (busy) return;
            if (box.matches('[data-bulk-all]')) {
                boxes().forEach(item => box.checked ? selected.add(item.dataset.bulkId) : selected.delete(item.dataset.bulkId));
            } else if (box.matches('[data-bulk-id]')) {
                box.checked ? selected.add(box.dataset.bulkId) : selected.delete(box.dataset.bulkId);
            } else return;
            sync();
        });
        new MutationObserver(sync).observe(table, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bulk-id'] });
        button.addEventListener('click', async () => {
            if (busy || !selected.size) return;
            busy = true;
            sync();
            const ids = [...selected];
            try {
                const confirmation = await Swal.fire({
                    icon: 'warning', title: `Delete ${ids.length} selected records?`,
                    text: 'This cannot be undone. Records protected by existing links or account rules will be kept.',
                    showCancelButton: true, confirmButtonText: 'Delete Selected', confirmButtonColor: '#dc3545'
                });
                if (!confirmation.isConfirmed) return;
                let deleted = 0;
                const failures = [];
                for (const id of ids) {
                    try {
                        const response = await ApiService.post(`${endpoint}?action=delete`, { [idField]: id });
                        if (!response.success) throw new Error(response.message || 'Unable to delete this record.');
                        selected.delete(id);
                        deleted++;
                    } catch (error) {
                        failures.push(`Record ${id}: ${error.response?.data?.message || error.message || 'Request failed.'}`);
                    }
                }
                await Swal.fire({
                    icon: failures.length ? 'warning' : 'success', title: 'Bulk deletion complete',
                    text: `${deleted} deleted. ${failures.length} kept.${failures.length ? '\n' + failures.join('\n') : ''}`
                });
                if (deleted) await onReload();
            } finally {
                busy = false;
                sync();
            }
        });
        sync();
    }

    constructor() {
        this.table = null;
        this.cachedRows = null;
        this.semesters = [];
    }

    getCurrentPageFromDom(tableId) {
        const tableEl = document.getElementById(tableId);
        const wrapper = tableEl?.closest('.datatable-wrapper');
        const active =
            wrapper?.querySelector('.datatable-pagination .datatable-active a') ||
            wrapper?.querySelector('.datatable-pagination .datatable-active button');
        const n = parseInt(active?.textContent?.trim() || '', 10);
        return (!isNaN(n) && n > 0) ? n : 1;
    }

    getTableCurrentPage(tableId) {
        const p = this.table?.currentPage;
        const n = (typeof p === 'number') ? p : parseInt(String(p || ''), 10);
        if (!isNaN(n) && n > 0) return n;
        return this.getCurrentPageFromDom(tableId);
    }

    async init() {
        const perSel = document.getElementById('perPageSelectCustom');
        if (perSel) perSel.value = '10';
        
        // Initialize RBAC first
        await rbacUtil.init();
        
        await this.loadSemesters();
        await this.loadCounts();
        await this.buildTable();
        this.bindToolbar();
        this.bindStatCards();
        
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
        
        // Apply RBAC permissions AFTER table is built
        rbacUtil.applyActionPermissions('csdl');
        this.updateUniqueSemestersStat();
    }

    async loadSemesters() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-school-years.php', { action: 'semesters' });
            this.semesters = (data?.rows || []).map(r => ({ id: r.id, name: r.name }));
            const sel = document.getElementById('sy_semester_id');
            if (sel) {
                const frag = document.createDocumentFragment();
                this.semesters.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = s.name;
                    frag.appendChild(opt);
                });
                sel.appendChild(frag);
            }
        } catch (_) {
            this.semesters = [];
        }
    }

    bindStatCards() {
        const modalEl = document.getElementById('schoolYearsListModal');
        const show = () => {
            if (!modalEl) return;
            // eslint-disable-next-line no-undef
            const m = bootstrap.Modal.getOrCreateInstance(modalEl);
            m.show();
        };
        const setTitle = (t) => { const el = document.getElementById('schoolYearsModalTitle'); if (el) el.textContent = t; };
        const tbody = document.getElementById('schoolYearsModalTableBody');
        const thead = document.querySelector('#schoolYearsListModal thead');
        const extraHead = document.getElementById('schoolYearsModalExtraHead');

        const renderSchoolYears = (rows, showStatus = true) => {
            if (!tbody) return;
            if (extraHead) extraHead.style.display = showStatus ? '' : 'none';
            tbody.innerHTML = (rows || []).map(r => {
                const status = String(r.status) === '1' ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>';
                const startDate = r.start_date ? new Date(r.start_date).toLocaleDateString() : '-';
                const endDate = r.end_date ? new Date(r.end_date).toLocaleDateString() : '-';
                return `<tr>
                    <td class="text-center">${escapeHtml(r.code || '')}</td>
                    <td class="text-center">${escapeHtml(r.semester_name || '')}</td>
                    <td class="text-center">${escapeHtml(startDate)}</td>
                    <td class="text-center">${escapeHtml(endDate)}</td>
                    ${showStatus ? `<td class="text-center">${status}</td>` : ''}
                </tr>`;
            }).join('');
        };

        const cards = document.querySelectorAll('[data-view]');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                if (view === 'activeSchoolYears') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">School Year Code</th><th class="text-center">Semester</th><th class="text-center">Start Date</th><th class="text-center">End Date</th><th class="text-center">Status</th></tr>';
                    setTitle('Active School Years');
                    renderSchoolYears(rows.filter(r => String(r.status) === '1'));
                    show();
                } else if (view === 'inactiveSchoolYears') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">School Year Code</th><th class="text-center">Semester</th><th class="text-center">Start Date</th><th class="text-center">End Date</th><th class="text-center">Status</th></tr>';
                    setTitle('Inactive School Years');
                    renderSchoolYears(rows.filter(r => String(r.status) === '0'));
                    show();
                } else if (view === 'uniqueSemesters') {
                    setTitle('Unique Semesters');
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Semester</th><th class="text-center">School Years</th></tr>';
                    (async () => {
                        try {
                            const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                            const counts = new Map();
                            (rows || []).forEach(sy => {
                                const semName = String(sy.semester_name || '');
                                if (semName) {
                                    counts.set(semName, (counts.get(semName) || 0) + 1);
                                }
                            });
                            const list = Array.from(counts.entries()).map(([semester, count]) => ({ semester, count }))
                                .sort((a,b) => String(a.semester).localeCompare(String(b.semester)));
                            if (tbody) {
                                tbody.innerHTML = (list || []).map(r => `
                                    <tr>
                                        <td class="text-center">${escapeHtml(r.semester || '')}</td>
                                        <td class="text-center">${escapeHtml(r.count || 0)}</td>
                                    </tr>
                                `).join('');
                                if (!list || list.length === 0) tbody.innerHTML = '<tr><td class="text-center" colspan="2">No data</td></tr>';
                            }
                        } catch (_) {
                            if (tbody) tbody.innerHTML = '<tr><td class="text-center" colspan="2">No data</td></tr>';
                        }
                        show();
                    })();
                } else {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">School Year Code</th><th class="text-center">Semester</th><th class="text-center">Start Date</th><th class="text-center">End Date</th><th class="text-center">Status</th></tr>';
                    setTitle('All School Years');
                    renderSchoolYears(rows);
                    show();
                }
            });
        });
    }

    async updateUniqueSemestersStat() {
        try {
            const rows = this.cachedRows || await this.fetchSchoolYears();
            const semesterSet = new Set();
            (rows || []).forEach(sy => {
                const semId = String(sy.semester_id || sy.sy_semester_id || '');
                const semName = String(sy.semester_name || '');
                if (semId && semId !== 'null' && semId !== 'undefined') {
                    semesterSet.add(semId);
                } else if (semName) {
                    semesterSet.add(semName);
                }
            });
            const el = document.getElementById('statUniqueSemesters');
            if (el) el.textContent = String(semesterSet.size || 0);
        } catch (_) {
            const el = document.getElementById('statUniqueSemesters');
            if (el) el.textContent = '0';
        }
    }

    getBaseURL() {
        return AppPaths.apiBase;
    }

    async fetchSchoolYears() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-school-years.php', { action: 'list' });
            if (data && Array.isArray(data.rows)) {
                this.cachedRows = data.rows;
                this.hydrateCounts(data);
                return data.rows;
            }
            return [];
        } catch (_) {
            return [];
        }
    }

    async buildTable() {
        const el = document.getElementById('schoolYearsTable');
        if (!el) return;

        const rows = this.cachedRows || await this.fetchSchoolYears();

        const totalSchoolYearsEl = document.getElementById('statTotalSchoolYears');
        if (totalSchoolYearsEl) totalSchoolYearsEl.textContent = String(rows.length);
        this.updateUniqueSemestersStat();

        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;
        const dataset = rows.map(r => {
            const isActive = String(r.status) === '1';
            const toggleLabel = isActive ? 'Deactivate' : 'Activate';
            const startDate = r.start_date ? new Date(r.start_date).toLocaleDateString() : '-';
            const endDate = r.end_date ? new Date(r.end_date).toLocaleDateString() : '-';
            return [
                bulkSelectionCell(r.id || r.sy_id),
            toCenter(r.code || ''),
            toCenter(r.semester_name || ''),
            toCenter(startDate),
            toCenter(endDate),
            (isActive
                ? '<span class="badge bg-success">Active</span>'
                : '<span class="badge bg-secondary">Inactive</span>'),
            masterfileEditToggleDelete({ isActive }),
            ];
        });

        this.tableSourceRows = rows;
        this.tableSourceData = dataset.map(cells => [...cells]);

        // eslint-disable-next-line no-undef
        this.table = new simpleDatatables.DataTable(el, {
            data: {
                headings: [bulkSelectionHeading, 'School Year Code','Semester','Start Date','End Date','Status','Actions'],
                data: dataset
            },
            columns: [{ select: 0, sortable: false }],
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('perPageSelectCustom')?.value || '10', 10),
            perPageSelect: false,
            info: false
        });

        this.populateSchoolYearFilter(rows);
        this.bindFilters();
        this.bindPaginationFooter();
        this.updatePageInfo();
        this.movePaginationOutside();

        const updateRowIndices = () => {
            const tbody = el.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('schoolYearsTable');
            const perPage = this.table.options?.perPage || 10;
            const startIndex = (currentPage - 1) * perPage;
            Array.from(tbody.rows).forEach((tr, localIdx) => {
                const globalIdx = startIndex + localIdx;
                tr.setAttribute('data-row-index', String(globalIdx));
            });
        };

        const getRowData = (tr) => {
            const id = tr?.querySelector('[data-record-id]')?.dataset.recordId;
            return this.cachedRows?.find(row => String(row.id || row.sy_id) === id) || null;
        };

        const tbody = el.querySelector('tbody');
        if (tbody) {
            updateRowIndices();

            const observer = new MutationObserver(() => {
                setTimeout(updateRowIndices, 0);
            });
            observer.observe(tbody, { childList: true, subtree: false });

            tbody.addEventListener('click', (ev) => {
                const target = ev.target;
                if (!(target instanceof Element)) return;
                if (target.closest(`${INLINE_ACTION_IGNORE}, .action-edit, .action-delete, .action-toggle`)) return;
                const tr = target.closest('tr');
                if (!tr) return;
                const row = getRowData(tr);
                if (!row) return;
                this.openViewModal(row);
            });

            tbody.addEventListener('click', (ev) => {
                const target = ev.target;
                if (!(target instanceof Element)) return;
                const tr = target.closest('tr');
                if (!tr) return;
                const row = getRowData(tr);
                if (!row) return;
                if (target.closest('.action-edit')) {
                    ev.preventDefault();
                    this.openEditModal(row);
                } else if (target.closest('.action-delete')) {
                    ev.preventDefault();
                    this.confirmDelete(row);
                } else if (target.closest('.action-toggle')) {
                    ev.preventDefault();
                    this.toggleStatus(row);
                }
            });
        }
    }

    async loadCounts() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-school-years.php', { action: 'list' });
            if (res && Array.isArray(res.rows)) {
                this.cachedRows = res.rows;
                this.hydrateCounts(res);
            }
        } catch (_) {
            // graceful fallback: leave defaults (0)
        }
    }

    hydrateCounts(src) {
        const { totalSchoolYears, activeSchoolYears, inactiveSchoolYears } = src || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && (val || val === 0)) el.textContent = String(val);
        };
        set('statTotalSchoolYears', totalSchoolYears ?? 0);
        set('statActiveSchoolYears', activeSchoolYears ?? 0);
        set('statInactiveSchoolYears', inactiveSchoolYears ?? 0);
    }

    bindToolbar() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
        const addBtn = document.getElementById('addSchoolYearBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.openAddModal());
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.onExportClick());
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const schoolYearMobile = document.getElementById('filterSchoolYearMobile');
                const statusMobile = document.getElementById('filterStatusMobile');
                
                // Sync mobile filters to desktop filters
                const schoolYearDesktop = document.getElementById('filterSchoolYear');
                const statusDesktop = document.getElementById('filterStatus');
                
                if (schoolYearMobile && schoolYearDesktop) schoolYearDesktop.value = schoolYearMobile.value;
                if (statusMobile && statusDesktop) statusDesktop.value = statusMobile.value;
                
                // Trigger filter change
                if (schoolYearDesktop) schoolYearDesktop.dispatchEvent(new Event('change'));
                if (statusDesktop) statusDesktop.dispatchEvent(new Event('change'));
                
                // Close mobile dropdown
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }
        
        // Sync mobile search with desktop search
        const searchMobile = document.getElementById('searchSchoolYearsMobile');
        const searchDesktop = document.getElementById('searchSchoolYears');
        if (searchMobile && searchDesktop) {
            searchMobile.addEventListener('input', (e) => {
                searchDesktop.value = e.target.value;
                searchDesktop.dispatchEvent(new Event('input'));
            });
            searchDesktop.addEventListener('input', (e) => {
                searchMobile.value = e.target.value;
            });
        }
    }

    populateSchoolYearFilter(rows) {
        const sel = document.getElementById('filterSchoolYear');
        const selMobile = document.getElementById('filterSchoolYearMobile');
        const codes = Array.from(new Set((rows || []).map(r => (r.code || r.sy_code || '').toString().trim()).filter(Boolean))).sort();
        
        if (sel) {
            const frag = document.createDocumentFragment();
            codes.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                frag.appendChild(opt);
            });
            sel.appendChild(frag);
        }
        
        // Populate mobile filter
        if (selMobile) {
            const frag = document.createDocumentFragment();
            codes.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                frag.appendChild(opt);
            });
            selMobile.appendChild(frag);
        }
    }

    bindFilters() {
        const schoolYearSel = document.getElementById('filterSchoolYear');
        const statusSel = document.getElementById('filterStatus');
        const searchEl = document.getElementById('searchSchoolYears');
        const apply = () => {
            if (!this.table) return;
            const schoolYear = schoolYearSel?.value || '';
            const status = statusSel?.value || '';
            const terms = (searchEl?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [];
            this.tableSourceRows.forEach((row, index) => {
                if (schoolYear && String(row.code || row.sy_code || '') !== schoolYear) return;
                if (status && (String(row.status) === '1') !== (status === 'active')) return;
                const searchable = [row.code, row.semester_name, row.start_date, row.end_date]
                    .filter(Boolean).join(' ').toLowerCase();
                if (terms.every(term => searchable.includes(term))) matches.push(this.tableSourceData[index]);
            });
            const rowCount = this.table.data?.data?.length || 0;
            if (rowCount) this.table.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (matches.length) this.table.insert({ data: matches });
            this.table.page(1);
            this.updatePageInfo();
        };
        if (schoolYearSel) schoolYearSel.addEventListener('change', apply);
        if (statusSel) statusSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', apply);
    }

    bindPaginationFooter() {
        const el = document.getElementById('schoolYearsTable');
        const updateRowIndices = () => {
            const tbody = el?.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('schoolYearsTable');
            const perPage = this.table.options?.perPage || 10;
            const startIndex = (currentPage - 1) * perPage;
            Array.from(tbody.rows).forEach((tr, localIdx) => {
                const globalIdx = startIndex + localIdx;
                tr.setAttribute('data-row-index', String(globalIdx));
            });
        };

        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');
        const perPageSel = document.getElementById('perPageSelectCustom');
        if (prevBtn) prevBtn.addEventListener('click', () => { 
            if (this.table) { 
                this.table.page(Math.max(1, this.getTableCurrentPage('schoolYearsTable') - 1)); 
                setTimeout(() => {
                    updateRowIndices();
                    this.updatePageInfo();
                }, 100);
            } 
        });
        if (nextBtn) nextBtn.addEventListener('click', () => { 
            if (this.table) { 
                this.table.page(this.getTableCurrentPage('schoolYearsTable') + 1); 
                setTimeout(() => {
                    updateRowIndices();
                    this.updatePageInfo();
                }, 100);
            } 
        });
        if (perPageSel) perPageSel.addEventListener('change', () => {
            if (!this.table) return;
            const n = parseInt(perPageSel.value, 10) || 10;
            this.table.options.perPage = n;
            if (typeof this.table.update === 'function') {
                this.table.update();
            }
            setTimeout(() => {
                updateRowIndices();
                this.updatePageInfo();
            }, 100);
        });
    }

    updatePageInfo() {
        const infoEl = document.getElementById('pageInfo');
        if (!infoEl || !this.table) return;
        const perPage = this.table.options?.perPage || 10;
        const total = this.table.data?.data?.length ?? 0;
        const page = Math.min(this.getTableCurrentPage('schoolYearsTable'), Math.max(1, Math.ceil(total / perPage)));
        const start = total === 0 ? 0 : (page - 1) * perPage + 1;
        const end = Math.min(page * perPage, total);
        infoEl.textContent = `Showing ${start} to ${end} of ${total} entries`;
        const nav = document.getElementById('masterfilesPagination');
        if (!nav) return;
        const pages = Math.max(1, Math.ceil(total / perPage));
        const current = Math.min(page, pages);
        const numbers = pages <= 7 ? Array.from({ length: pages }, (_, index) => index + 1)
            : [...new Set([1, current - 1, current, current + 1, pages].filter((number) => number >= 1 && number <= pages))].sort((a, b) => a - b);
        const buttons = [];
        let previous = 0;
        for (const number of numbers) {
            if (previous && number > previous + 1) buttons.push('<span class="px-1 text-muted">…</span>');
            buttons.push(`<button type="button" class="btn btn-sm ${number === current ? 'btn-success' : 'btn-outline-secondary'}" data-page="${number}" ${number === current ? 'aria-current="page"' : ''}>${number}</button>`);
            previous = number;
        }
        nav.innerHTML = pages <= 1 ? '' : `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${current - 1}" ${current === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${current + 1}" ${current === pages ? 'disabled' : ''}>Next</button>`;
        nav.onclick = (event) => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            this.table.page(Number(button.dataset.page));
            setTimeout(() => this.updatePageInfo(), 100);
        };
    }

    movePaginationOutside() {
        // Only on mobile - move simple-datatables pagination outside table-responsive
        const checkAndMove = () => {
            const tableEl = document.getElementById('schoolYearsTable');
            if (!tableEl) return;
            
            const tableResponsive = tableEl.closest('.table-responsive');
            if (!tableResponsive) return;
            
            const wrapper = tableEl.closest('.datatable-wrapper');
            if (!wrapper) return;
            
            if (window.innerWidth > 767.98) {
                // On desktop, move pagination back inside wrapper if it was moved
                const pagination = tableResponsive.parentElement?.querySelector('.table-responsive ~ .datatable-pagination');
                if (pagination && wrapper && !wrapper.contains(pagination)) {
                    wrapper.appendChild(pagination);
                }
                return;
            }
            
            let pagination = wrapper.querySelector('.datatable-pagination');
            if (!pagination) return;
            
            // Check if already moved
            if (pagination.parentElement === tableResponsive.parentElement && 
                tableResponsive.nextSibling === pagination) {
                return; // Already moved
            }
            
            // Move pagination after table-responsive
            tableResponsive.parentElement.insertBefore(pagination, tableResponsive.nextSibling);
            
            // Use event delegation from card-body to handle clicks
            const cardBody = tableResponsive.closest('.card-body');
            if (cardBody && !cardBody.hasAttribute('data-pagination-bound')) {
                cardBody.setAttribute('data-pagination-bound', 'true');
                cardBody.addEventListener('click', (e) => {
                    if (!e.target.closest('.datatable-pagination')) return;
                    
                    const btn = e.target.closest('button, a');
                    if (!btn || !this.table) return;
                    
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const text = btn.textContent.trim();
                    if (text === '‹' || text === '←') {
                        this.table.page(Math.max(1, this.getTableCurrentPage('schoolYearsTable') - 1));
                    } else if (text === '›' || text === '→') {
                        this.table.page(this.getTableCurrentPage('schoolYearsTable') + 1);
                    } else {
                        const pageNum = parseInt(text, 10);
                        if (!isNaN(pageNum)) {
                            this.table.page(pageNum);
                        }
                    }
                    
                    setTimeout(() => {
                        this.updatePageInfo();
                    }, 100);
                });
            }
        };
        
        // Run immediately and after a short delay (in case pagination renders later)
        checkAndMove();
        setTimeout(checkAndMove, 100);
        setTimeout(checkAndMove, 500);
        
        // Also run on window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(checkAndMove, 100);
        });
    }

    openAddModal() {
        if (!rbacUtil.requireMasterfilePermission('school_years', 'create', 'create school years')) {
            return;
        }
        const title = document.getElementById('schoolYearModalTitle');
        if (title) title.textContent = 'Add School Year';
        this.fillForm({});
        this.showModal('schoolYearModal');
        const saveBtn = document.getElementById('saveSchoolYearBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveSchoolYear('create');
            };
        }
    }

    openEditModal(row) {
        if (!rbacUtil.requireMasterfilePermission('school_years', 'edit', 'edit school years')) {
            return;
        }
        const title = document.getElementById('schoolYearModalTitle');
        if (title) title.textContent = 'Edit School Year';
        this.fillForm(row);
        this.showModal('schoolYearModal');
        const saveBtn = document.getElementById('saveSchoolYearBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveSchoolYear('update');
            };
        }
    }

    openViewModal(row) {
        const code = row.code || '';
        const semester = row.semester_name || '-';
        const startDate = row.start_date ? new Date(row.start_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '-';
        const endDate = row.end_date ? new Date(row.end_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '-';
        const status = String(row.status) === '1' ? 'Active' : 'Inactive';
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
        
        // Store current row for edit button
        this.currentViewRow = row;
        
        // School Year Information
        setText('viewSchoolYearCodeText', code);
        setText('viewSchoolYearSemester', semester);
        
        // Active Status
        const statusEl = document.getElementById('viewSchoolYearStatus');
        if (statusEl) {
            statusEl.textContent = status;
            statusEl.className = status === 'Active' ? 'badge bg-success' : 'badge bg-secondary';
        }
        
        // Date Information
        setText('viewSchoolYearStartDate', startDate);
        setText('viewSchoolYearEndDate', endDate);
        
        // Bind edit button if not already bound
        const editBtn = document.getElementById('editSchoolYearFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                await this.hideModalAndWait('viewSchoolYearModal');
                this.openEditModal(row);
            });
        }
        
        this.showModal('viewSchoolYearModal');
    }

    fillForm(row) {
        const byId = (id) => document.getElementById(id);
        const setVal = (id, val) => { const el = byId(id); if (el) el.value = val || ''; };
        setVal('sy_id', row.id || row.sy_id || '');
        setVal('sy_code', row.code || row.sy_code || '');
        setVal('sy_semester_id', row.semester_id || row.sy_semester_id || '');
        setVal('sy_start_date', row.start_date || row.sy_start_date || '');
        setVal('sy_end_date', row.end_date || row.sy_end_date || '');
    }

    saveSchoolYear(mode) {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('school_years', 'create', 'create school years')) {
            return;
        }
        if ((mode === 'update' || (document.getElementById('sy_id')?.value || '').trim()) && !rbacUtil.requireMasterfilePermission('school_years', 'edit', 'edit school years')) {
            return;
        }
        const id = (document.getElementById('sy_id')?.value || '').trim();
        const code = (document.getElementById('sy_code')?.value || '').trim();
        const semesterId = (document.getElementById('sy_semester_id')?.value || '').trim();
        const startDate = (document.getElementById('sy_start_date')?.value || '').trim();
        const endDate = (document.getElementById('sy_end_date')?.value || '').trim();
        if (!code || !semesterId) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire('Missing fields', 'School Year Code and Semester are required.', 'warning');
            return;
        }
        const payload = { sy_code: code, sy_semester_id: semesterId, sy_start_date: startDate || null, sy_end_date: endDate || null };
        if (id) payload.sy_id = id;
        const url = mode === 'update' || id
            ? '/masterfiles/masterfiles-school-years.php?action=update'
            : '/masterfiles/masterfiles-school-years.php?action=create';
        ApiService.post(url, payload)
            .then(() => {
                this.hideModal('schoolYearModal');
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Success', `School Year ${mode === 'update' || id ? 'updated' : 'added'} successfully.`, 'success')
                    .then(() => window.location.reload());
            })
            .catch(() => {
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', 'Operation failed.', 'error');
            });
    }

    toggleStatus(row) {
        if (!rbacUtil.requireMasterfilePermission('school_years', 'edit', 'edit school years')) {
            return;
        }
        const isActive = String(row.status) === '1';
        const nextLabel = isActive ? 'deactivate' : 'activate';
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: `Confirm ${nextLabel}?`,
                text: (row.code || row.sy_code || ''),
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: isActive ? 'Deactivate' : 'Activate'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-school-years.php?action=toggle', { sy_id: row.id || row.sy_id })
                        .then(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Updated', 'Status updated.', 'success').then(() => window.location.reload());
                        })
                        .catch(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', 'Failed to update status.', 'error');
                        });
                }
            });
        }
    }

    confirmDelete(row) {
        if (!rbacUtil.requireMasterfilePermission('school_years', 'delete', 'delete school years')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Delete school year?',
                text: (row.code || row.sy_code || ''),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Delete',
                confirmButtonColor: '#d33'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-school-years.php?action=delete', { sy_id: row.id || row.sy_id })
                        .then(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Deleted', 'School Year deleted.', 'success').then(() => window.location.reload());
                        })
                        .catch(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', 'Failed to delete school year.', 'error');
                        });
                }
            });
        }
    }

    showModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        // eslint-disable-next-line no-undef
        const m = bootstrap.Modal.getOrCreateInstance(el);
        m.show();
    }

    hideModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        // eslint-disable-next-line no-undef
        const m = bootstrap.Modal.getInstance(el);
        if (m) m.hide();
    }

    async hideModalAndWait(id) {
        const el = document.getElementById(id);
        const modal = el ? bootstrap.Modal.getInstance(el) : null;
        if (!el || !modal || !el.classList.contains('show')) return;
        await new Promise((resolve) => {
            let completed = false;
            const finish = () => {
                if (completed) return;
                completed = true;
                resolve();
            };
            el.addEventListener('hidden.bs.modal', finish, { once: true });
            modal.hide();
            window.setTimeout(finish, 400);
        });
    }

    // ===== Export helpers =====
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

    async onExportClick() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        const result = await swal.fire({
            title: 'Export School Years',
            input: 'select',
            inputOptions: { csv: 'CSV', xls: 'Excel (.xls)', doc: 'Word (.doc)', pdf: 'PDF (.pdf)' },
            inputValue: 'csv',
            showCancelButton: true,
            confirmButtonText: 'Export',
            cancelButtonText: 'Cancel',
            buttonsStyling: false,
            customClass: { confirmButton: 'btn btn-success px-4', cancelButton: 'btn btn-secondary px-4', actions: 'd-flex gap-2', popup: 'swal2-custom-popup' }
        });
        if (!result.isConfirmed) return;

        const rows = (this.cachedRows || []).map(r => ({
            Code: r.code || r.sy_code || '',
            Semester: r.semester_name || '',
            'Start Date': r.start_date || r.sy_start_date || '',
            'End Date': r.end_date || r.sy_end_date || ''
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no school years to export.', confirmButtonColor: '#007319' });
            return;
        }

        const choice = result.value;
        if (choice === 'csv') {
            const headers = Object.keys(rows[0] || { Code: '', Semester: '', 'Start Date': '', 'End Date': '' });
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'school-years.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(rows[0] || { Code: '', Semester: '', 'Start Date': '', 'End Date': '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'school-years.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(rows[0] || { Code: '', Semester: '', 'Start Date': '', 'End Date': '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'school-years.doc');
            return;
        }

        if (choice === 'pdf') {
            this.exportSchoolYearsPDF(rows);
        }
    }
    
    exportSchoolYearsPDF(rows) {
        // Professional PDF export with enhanced HTML print design
        const escapeHtml = (str) => {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        const headers = ['School Year Code', 'Semester', 'Start Date', 'End Date'];
        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = rows.map((r, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            const rowData = [r.Code, r.Semester, r['Start Date'], r['End Date']];
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>School Years Report</title>
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
                            <h2>School Years Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> School Years</div>
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
    
    bindOutsideActionMenuClose() {}

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

export default MasterfilesSchoolYearsModule;

