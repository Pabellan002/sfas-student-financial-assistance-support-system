import AppPaths from '../../services/services-appPaths.js';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { INLINE_ACTION_IGNORE, masterfileEditDelete } from '../../shared/shared-inline-actions.js';

const bulkSelectionHeading = '<input type="checkbox" class="form-check-input" data-bulk-all aria-label="Select all records on this page" hidden>';

function bulkSelectionCell(id) {
    return `<span data-record-id="${escapeHtml(String(id))}"><input type="checkbox" class="form-check-input" data-bulk-id="${escapeHtml(String(id))}" aria-label="Select record ${escapeHtml(String(id))}" hidden></span>`;
}

class MasterfilesYearLevelsModule {
    async bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        const tableId = 'yearLevelsTable';
        const refreshId = 'refreshBtn';
        const resource = 'year_levels';
        const endpoint = '/masterfiles/masterfiles-year-levels.php';
        const idField = 'year_level_id';
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
        
        await this.loadCounts();
        await this.buildTable();
        this.bindToolbar();
        this.bindStatCards();
        
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
        
        // Apply RBAC permissions AFTER table is built
        rbacUtil.applyActionPermissions('csdl');
    }

    async fetchYearLevels() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-year-levels.php', { action: 'list' });
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

    bindStatCards() {
        const modalEl = document.getElementById('yearLevelsListModal');
        const show = () => {
            if (!modalEl) return;
            // eslint-disable-next-line no-undef
            const m = bootstrap.Modal.getOrCreateInstance(modalEl);
            m.show();
        };
        const setTitle = (t) => { const el = document.getElementById('yearLevelsModalTitle'); if (el) el.textContent = t; };
        const tbody = document.getElementById('yearLevelsModalTableBody');
        const thead = document.querySelector('#yearLevelsListModal thead');

        const typeBadgeHtml = (type) => {
            const t = String(type || '').toLowerCase();
            if (t === 'college') return '<span class="badge bg-success">College</span>';
            if (t === 'senior_high') return '<span class="badge bg-info">Senior High</span>';
            if (t === 'basic_education') return '<span class="badge bg-warning text-dark">Basic Education</span>';
            return `<span class="badge bg-secondary">${escapeHtml(type || '')}</span>`;
        };

        const renderYearLevels = (rows) => {
            if (!tbody) return;
            tbody.innerHTML = (rows || []).map(r => {
                const typeBadge = typeBadgeHtml(r.type);
                return `<tr>
                    <td class="text-center">${escapeHtml(r.code || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${typeBadge}</td>
                    <td class="text-center">${escapeHtml(r.students ?? 0)}</td>
                </tr>`;
            }).join('');
        };

        const cards = document.querySelectorAll('[data-view]');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                if (view === 'collegeYearLevels') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Year Level Code</th><th class="text-center">Year Level Name</th><th class="text-center">Type</th><th class="text-center">Students</th></tr>';
                    setTitle('College Year Levels');
                    renderYearLevels(rows.filter(r => String(r.type) === 'college'));
                    show();
                } else if (view === 'seniorHighYearLevels') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Year Level Code</th><th class="text-center">Year Level Name</th><th class="text-center">Type</th><th class="text-center">Students</th></tr>';
                    setTitle('Senior High Year Levels');
                    renderYearLevels(rows.filter(r => String(r.type) === 'senior_high'));
                    show();
                } else if (view === 'basicEducationYearLevels') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Year Level Code</th><th class="text-center">Year Level Name</th><th class="text-center">Type</th><th class="text-center">Students</th></tr>';
                    setTitle('Basic Education Year Levels');
                    renderYearLevels(rows.filter(r => String(r.type) === 'basic_education'));
                    show();
                } else {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Year Level Code</th><th class="text-center">Year Level Name</th><th class="text-center">Type</th><th class="text-center">Students</th></tr>';
                    setTitle('All Year Levels');
                    renderYearLevels(rows);
                    show();
                }
            });
        });
    }

    async updateYearLevelsByStudentsStat() {
        try {
            const students = await this.fetchStudentsList();
            const yearLevelSet = new Set();
            (students || []).forEach(s => {
                const ylId = String(s.year_level_id || s.student_year_level_id || '');
                if (ylId) yearLevelSet.add(ylId);
            });
            const el = document.getElementById('statYearLevelsByStudents');
            if (el) el.textContent = String(yearLevelSet.size || 0);
        } catch (_) {
            const el = document.getElementById('statYearLevelsByStudents');
            if (el) el.textContent = '0';
        }
    }

    async fetchStudentsList() {
        const candidates = [
            async () => {
                try {
                    const base = this.getBaseURL();
                    const res = await fetch(`${base}/masterfiles/masterfiles-students.php?action=list`, { credentials: 'same-origin', cache: 'no-store' });
                    const d = await res.json();
                    return d?.rows || d?.data?.rows || [];
                } catch (e) { return []; }
            },
            async () => {
                try {
                    const base = this.getBaseURL();
                    const res = await fetch(`${base}/csdl/csdl-dashboard.php?detail=studentsList`, { credentials: 'same-origin', cache: 'no-store' });
                    const d = await res.json();
                    return d?.rows || d?.data?.rows || [];
                } catch (e) { return []; }
            }
        ];
        for (const fn of candidates) {
            // eslint-disable-next-line no-await-in-loop
            const rows = await fn();
            if (Array.isArray(rows) && rows.length > 0) return rows;
        }
        return [];
    }

    getBaseURL() {
        return AppPaths.apiBase;
    }

    async buildTable() {
        const el = document.getElementById('yearLevelsTable');
        if (!el) return;

        // Fetch year levels and student counts per year level
        const rows = this.cachedRows || await this.fetchYearLevels();
        const students = await this.fetchStudentsList();
        const studentCounts = new Map();
        (students || []).forEach(s => {
            const ylId = String(s.year_level_id || s.student_year_level_id || '');
            if (!ylId) return;
            studentCounts.set(ylId, (studentCounts.get(ylId) || 0) + 1);
        });

        const totalYearLevelsEl = document.getElementById('statTotalYearLevels');
        if (totalYearLevelsEl) totalYearLevelsEl.textContent = String(rows.length);
        this.updateYearLevelsByStudentsStat();

        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;
        const typeBadgeHtml = (type) => {
            const t = String(type || '').toLowerCase();
            if (t === 'college') return '<span class="badge bg-success">College</span>';
            if (t === 'senior_high') return '<span class="badge bg-info">Senior High</span>';
            if (t === 'basic_education') return '<span class="badge bg-warning text-dark">Basic Education</span>';
            return `<span class="badge bg-secondary">${escapeHtml(type || '')}</span>`;
        };

        const dataset = rows.map(r => {
            const typeBadge = typeBadgeHtml(r.type);
            const ylId = String(r.id || r.year_level_id || '');
            const studentsCount = studentCounts.get(ylId) || 0;
            return [
                bulkSelectionCell(r.id || r.year_level_id),
            toCenter(r.code || ''),
            toCenter(r.name || ''),
            toCenter(typeBadge),
            toCenter(studentsCount),
            masterfileEditDelete(),
            ];
        });

        this.tableSourceRows = rows;
        this.tableSourceData = dataset.map(cells => [...cells]);

        // eslint-disable-next-line no-undef
        this.table = new simpleDatatables.DataTable(el, {
            data: {
                headings: [bulkSelectionHeading, 'Year Level Code','Year Level Name','Type','Students','Actions'],
                data: dataset
            },
            columns: [{ select: 0, sortable: false }],
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('perPageSelectCustom')?.value || '10', 10),
            perPageSelect: false,
            info: false
        });

        this.populateYearLevelFilter(rows);
        this.bindFilters();
        this.bindPaginationFooter();
        this.updatePageInfo();
        this.movePaginationOutside();

        const updateRowIndices = () => {
            const tbody = el.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('yearLevelsTable');
            const perPage = this.table.options?.perPage || 10;
            const startIndex = (currentPage - 1) * perPage;
            Array.from(tbody.rows).forEach((tr, localIdx) => {
                const globalIdx = startIndex + localIdx;
                tr.setAttribute('data-row-index', String(globalIdx));
            });
        };

        const getRowData = (tr) => {
            const id = tr?.querySelector('[data-record-id]')?.dataset.recordId;
            return this.cachedRows?.find(row => String(row.id || row.year_level_id) === id) || null;
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
                if (target.closest(`${INLINE_ACTION_IGNORE}, .action-edit, .action-delete`)) return;
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
                }
            });
        }
    }

    async loadCounts() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-year-levels.php', { action: 'list' });
            if (res && Array.isArray(res.rows)) {
                this.cachedRows = res.rows;
                this.hydrateCounts(res);
            }
        } catch (_) {
            // graceful fallback: leave defaults (0)
        }
    }

    hydrateCounts(src) {
        const { totalYearLevels, collegeYearLevels, seniorHighYearLevels, basicEducationYearLevels } = src || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && (val || val === 0)) el.textContent = String(val);
        };
        set('statTotalYearLevels', totalYearLevels ?? 0);
        set('statCollegeYearLevels', collegeYearLevels ?? 0);
        set('statSeniorHighYearLevels', seniorHighYearLevels ?? 0);
        set('statBasicEducationYearLevels', basicEducationYearLevels ?? 0);
    }

    bindToolbar() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
        const addBtn = document.getElementById('addYearLevelBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.openAddModal());
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.onExportClick());
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const yearLevelMobile = document.getElementById('filterYearLevelMobile');
                const typeMobile = document.getElementById('filterTypeMobile');
                
                // Sync mobile filters to desktop filters
                const yearLevelDesktop = document.getElementById('filterYearLevel');
                const typeDesktop = document.getElementById('filterType');
                
                if (yearLevelMobile && yearLevelDesktop) yearLevelDesktop.value = yearLevelMobile.value;
                if (typeMobile && typeDesktop) typeDesktop.value = typeMobile.value;
                
                // Trigger filter change
                if (yearLevelDesktop) yearLevelDesktop.dispatchEvent(new Event('change'));
                if (typeDesktop) typeDesktop.dispatchEvent(new Event('change'));
                
                // Close mobile dropdown
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }
        
        // Sync mobile search with desktop search
        const searchMobile = document.getElementById('searchYearLevelsMobile');
        const searchDesktop = document.getElementById('searchYearLevels');
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

    populateYearLevelFilter(rows) {
        const sel = document.getElementById('filterYearLevel');
        const selMobile = document.getElementById('filterYearLevelMobile');
        const codes = Array.from(new Set((rows || []).map(r => (r.code || r.year_level_code || '').toString().trim()).filter(Boolean))).sort();
        
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
        const yearLevelSel = document.getElementById('filterYearLevel');
        const typeSel = document.getElementById('filterType');
        const searchEl = document.getElementById('searchYearLevels');
        const apply = () => {
            if (!this.table) return;
            const yearLevel = yearLevelSel?.value || '';
            const type = typeSel?.value || '';
            const terms = (searchEl?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [];
            this.tableSourceRows.forEach((row, index) => {
                if (yearLevel && String(row.code || row.year_level_code || '') !== yearLevel) return;
                if (type && String(row.type || '') !== type) return;
                const searchable = [row.code, row.name, row.type].filter(Boolean).join(' ').toLowerCase();
                if (terms.every(term => searchable.includes(term))) matches.push(this.tableSourceData[index]);
            });
            const rowCount = this.table.data?.data?.length || 0;
            if (rowCount) this.table.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (matches.length) this.table.insert({ data: matches });
            this.table.page(1);
            this.updatePageInfo();
        };
        if (yearLevelSel) yearLevelSel.addEventListener('change', apply);
        if (typeSel) typeSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', apply);
    }

    bindPaginationFooter() {
        const el = document.getElementById('yearLevelsTable');
        const updateRowIndices = () => {
            const tbody = el?.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('yearLevelsTable');
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
                this.table.page(Math.max(1, this.getTableCurrentPage('yearLevelsTable') - 1)); 
                setTimeout(() => {
                    updateRowIndices();
                    this.updatePageInfo();
                }, 100);
            } 
        });
        if (nextBtn) nextBtn.addEventListener('click', () => { 
            if (this.table) { 
                this.table.page(this.getTableCurrentPage('yearLevelsTable') + 1); 
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
        this.updatePageInfo();
    }

    updatePageInfo() {
        const infoEl = document.getElementById('pageInfo');
        if (!infoEl || !this.table) return;
        const perPage = this.table.options?.perPage || 10;
        const total = this.table.data?.data?.length ?? 0;
        const page = Math.min(this.getTableCurrentPage('yearLevelsTable'), Math.max(1, Math.ceil(total / perPage)));
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
            const tableEl = document.getElementById('yearLevelsTable');
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
                        this.table.page(Math.max(1, this.getTableCurrentPage('yearLevelsTable') - 1));
                    } else if (text === '›' || text === '→') {
                        this.table.page(this.getTableCurrentPage('yearLevelsTable') + 1);
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
        if (!rbacUtil.requireMasterfilePermission('year_levels', 'create', 'create year levels')) {
            return;
        }
        const title = document.getElementById('yearLevelModalTitle');
        if (title) title.textContent = 'Add Year Level';
        this.fillForm({});
        this.showModal('yearLevelModal');
        const saveBtn = document.getElementById('saveYearLevelBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveYearLevel('create');
            };
        }
    }

    openEditModal(row) {
        if (!rbacUtil.requireMasterfilePermission('year_levels', 'edit', 'edit year levels')) {
            return;
        }
        const title = document.getElementById('yearLevelModalTitle');
        if (title) title.textContent = 'Edit Year Level';
        this.fillForm(row);
        this.showModal('yearLevelModal');
        const saveBtn = document.getElementById('saveYearLevelBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveYearLevel('update');
            };
        }
    }

    openViewModal(row) {
        const code = row.code || '';
        const name = row.name || '';
        const type = String(row.type) === 'college' ? 'College' : String(row.type) === 'senior_high' ? 'Senior High' : 'Basic Education';
        const typeBadge = String(row.type) === 'college' ? 'badge bg-success' : String(row.type) === 'senior_high' ? 'badge bg-info' : 'badge bg-warning text-dark';
        const students = row.students || 0;
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
        
        // Store current row for edit button
        this.currentViewRow = row;
        
        // Year Level Information
        setText('viewYearLevelCodeText', code);
        setText('viewYearLevelNameText', name);
        
        // Type Badge
        const typeEl = document.getElementById('viewYearLevelType');
        if (typeEl) {
            typeEl.className = typeBadge;
            typeEl.textContent = type;
        }
        
        // Students count
        setText('viewYearLevelStudents', String(students));
        
        // Bind edit button if not already bound
        const editBtn = document.getElementById('editYearLevelFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                await this.hideModalAndWait('viewYearLevelModal');
                this.openEditModal(row);
            });
        }
        
        this.showModal('viewYearLevelModal');
    }

    fillForm(row) {
        const byId = (id) => document.getElementById(id);
        const setVal = (id, val) => { const el = byId(id); if (el) el.value = val || ''; };
        setVal('year_level_id', row.id || row.year_level_id || '');
        setVal('year_level_code', row.code || row.year_level_code || '');
        setVal('year_level_name', row.name || row.year_level_name || '');
        setVal('year_level_type', row.type || row.year_level_type || 'college');
    }

    saveYearLevel(mode) {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('year_levels', 'create', 'create year levels')) {
            return;
        }
        if (mode === 'update' && !rbacUtil.requireMasterfilePermission('year_levels', 'edit', 'edit year levels')) {
            return;
        }
        const form = document.getElementById('yearLevelForm');
        if (!form || !form.checkValidity()) {
            form?.reportValidity();
            return;
        }

        const byId = (id) => document.getElementById(id);
        const getVal = (id) => (byId(id)?.value || '').trim();
        const data = {
            year_level_code: getVal('year_level_code'),
            year_level_name: getVal('year_level_name'),
            year_level_type: getVal('year_level_type') || 'college'
        };

        if (mode === 'update') {
            data.year_level_id = getVal('year_level_id');
        }

        const url = mode === 'update'
            ? '/masterfiles/masterfiles-year-levels.php?action=update'
            : '/masterfiles/masterfiles-year-levels.php?action=create';

        ApiService.post(url, data)
            .then(() => {
                this.hideModal('yearLevelModal');
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Success', `Year Level ${mode === 'update' ? 'updated' : 'added'} successfully.`, 'success')
                    .then(() => window.location.reload());
            })
            .catch(() => {
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', 'Operation failed.', 'error');
            });
    }

    confirmDelete(row) {
        if (!rbacUtil.requireMasterfilePermission('year_levels', 'delete', 'delete year levels')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Confirm Delete',
                text: `Are you sure you want to delete "${row.code || row.year_level_code || 'this year level'}"? This action cannot be undone.`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes, delete',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#dc3545'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-year-levels.php?action=delete', { year_level_id: row.id || row.year_level_id })
                        .then(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Deleted', 'Year Level deleted.', 'success').then(() => window.location.reload());
                        })
                        .catch(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', 'Failed to delete year level.', 'error');
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
            title: 'Export Year Levels',
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
            Code: r.code || r.year_level_code || '',
            Name: r.name || r.year_level_name || '',
            Type: String(r.type) === 'college' ? 'College' : 'Senior High'
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no year levels to export.', confirmButtonColor: '#007319' });
            return;
        }

        const choice = result.value;
        if (choice === 'csv') {
            const headers = Object.keys(rows[0] || { Code: '', Name: '', Type: '' });
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'year-levels.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(rows[0] || { Code: '', Name: '', Type: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'year-levels.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(rows[0] || { Code: '', Name: '', Type: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'year-levels.doc');
            return;
        }

        if (choice === 'pdf') {
            this.exportYearLevelsPDF(rows);
        }
    }
    
    exportYearLevelsPDF(rows) {
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

        const headers = ['Year Level Code', 'Year Level Name', 'Type'];
        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = rows.map((r, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            const rowData = [r.Code, r.Name, r.Type];
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Year Levels Report</title>
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
                            <h2>Year Levels Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> Year Levels</div>
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

export default MasterfilesYearLevelsModule;
