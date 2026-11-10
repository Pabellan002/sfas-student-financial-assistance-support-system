import AppPaths from '../../services/services-appPaths.js';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { INLINE_ACTION_IGNORE, masterfileEditToggleDelete } from '../../shared/shared-inline-actions.js';

const bulkSelectionHeading = '<input type="checkbox" class="form-check-input" data-bulk-all aria-label="Select all records on this page" hidden>';

function bulkSelectionCell(id) {
    return `<span data-record-id="${escapeHtml(String(id))}"><input type="checkbox" class="form-check-input" data-bulk-id="${escapeHtml(String(id))}" aria-label="Select record ${escapeHtml(String(id))}" hidden></span>`;
}

class MasterfilesScholarshipsModule {
    async bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        const tableId = 'scholarshipsTable';
        const refreshId = 'refreshBtn';
        const resource = 'scholarships';
        const endpoint = '/masterfiles/masterfiles-scholarships.php';
        const idField = 'scholarship_id';
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
        this.bindImportModal();
        this.bindStatCards();
        this.updateScholarshipsByStudentsStat();
        
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
        // Apply RBAC permissions AFTER table is built
        rbacUtil.applyActionPermissions('csdl');
    }

    bindStatCards() {
        const modalEl = document.getElementById('scholarshipsListModal');
        const show = () => {
            if (!modalEl) return;
            // eslint-disable-next-line no-undef
            const m = bootstrap.Modal.getOrCreateInstance(modalEl);
            m.show();
        };
        const setTitle = (t) => { const el = document.getElementById('scholarshipsModalTitle'); if (el) el.textContent = t; };
        const tbody = document.getElementById('scholarshipsModalTableBody');
        const thead = document.querySelector('#scholarshipsListModal thead');
        const extraHead = document.getElementById('scholarshipsModalExtraHead');

        const renderScholarships = (rows, showStatus = true) => {
            if (!tbody) return;
            if (extraHead) extraHead.style.display = showStatus ? '' : 'none';
            tbody.innerHTML = (rows || []).map(r => {
                const status = String(r.status) === '1' ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>';
                const percentage = r.percentage ? `${Number(r.percentage).toFixed(2)}%` : '0.00%';
                return `<tr>
                    <td class="text-center">${escapeHtml(r.code || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${percentage}</td>
                    ${showStatus ? `<td class="text-center">${status}</td>` : ''}
                </tr>`;
            }).join('');
        };

        const cards = document.querySelectorAll('[data-view]');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                if (view === 'activeScholarships') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Scholarship Code</th><th class="text-center">Scholarship Name</th><th class="text-center">Percentage</th><th class="text-center">Status</th></tr>';
                    setTitle('Active Scholarships');
                    renderScholarships(rows.filter(r => String(r.status) === '1'));
                    show();
                } else if (view === 'inactiveScholarships') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Scholarship Code</th><th class="text-center">Scholarship Name</th><th class="text-center">Percentage</th><th class="text-center">Status</th></tr>';
                    setTitle('Inactive Scholarships');
                    renderScholarships(rows.filter(r => String(r.status) === '0'));
                    show();
                } else if (view === 'scholarshipsByStudents') {
                    setTitle('Scholarships by Students');
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Scholarship</th><th class="text-center">Students</th></tr>';
                    (async () => {
                        try {
                            const students = await this.fetchStudentsList();
                            const idToScholarship = new Map();
                            (this.cachedRows || []).forEach(s => { idToScholarship.set(String(s.id || s.scholarship_id), s.name || s.scholarship_name || s.code || s.scholarship_code); });
                            const counts = new Map();
                            (students || []).forEach(st => {
                                const sid = String(st.scholarship_id || st.student_scholarship_id || '');
                                const scholarshipName = idToScholarship.get(sid) || st.scholarship_name || '';
                                if (!scholarshipName) return;
                                counts.set(scholarshipName, (counts.get(scholarshipName) || 0) + 1);
                            });
                            const list = Array.from(counts.entries()).map(([scholarship, students]) => ({ scholarship, students }))
                                .sort((a,b) => String(a.scholarship).localeCompare(String(b.scholarship)));
                            if (tbody) {
                                tbody.innerHTML = (list || []).map(r => `
                                    <tr>
                                        <td class=\"text-center\">${escapeHtml(r.scholarship || '')}</td>
                                        <td class=\"text-center\">${escapeHtml(r.students || 0)}</td>
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
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Scholarship Code</th><th class="text-center">Scholarship Name</th><th class="text-center">Percentage</th><th class="text-center">Status</th></tr>';
                    setTitle('All Scholarships');
                    renderScholarships(rows);
                    show();
                }
            });
        });
    }

    async updateScholarshipsByStudentsStat() {
        const totalScholars = (this.cachedRows || []).reduce(
            (total, scholarship) => total + (Number(scholarship.students) || 0),
            0
        );
        const el = document.getElementById('statScholarshipsByStudents');
        if (el) el.textContent = String(totalScholars);
    }

    async fetchStudentsList() {
        const candidates = [
            async () => {
                try {
                    const r = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'list' });
                    const rows = r?.rows || r?.data?.rows || [];
                    return rows;
                } catch (e) { return []; }
            },
            async () => {
                try {
                    const base = this.getBaseURL();
                    const res = await fetch(`${base}/masterfiles/masterfiles-students.php?action=list`, { credentials: 'same-origin', cache: 'no-store' });
                    if (!res.ok) return [];
                    const d = await res.json();
                    return d?.rows || d?.data?.rows || [];
                } catch (e) { return []; }
            },
            async () => {
                try {
                    const base = this.getBaseURL();
                    const res2 = await fetch(`${base}/csdl/csdl-dashboard.php?detail=studentsList`, { credentials: 'same-origin', cache: 'no-store' });
                    const d2 = await res2.json();
                    const rows = Array.isArray(d2?.rows) ? d2.rows : [];
                    return rows;
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

    async fetchScholarships() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-scholarships.php', { action: 'list' });
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
        const el = document.getElementById('scholarshipsTable');
        if (!el) return;

        const rows = this.cachedRows || await this.fetchScholarships();

        const totalScholarshipsEl = document.getElementById('statTotalScholarships');
        if (totalScholarshipsEl) totalScholarshipsEl.textContent = String(rows.length);
        this.updateScholarshipsByStudentsStat();

        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;
        const dataset = rows.map(r => {
            const isActive = String(r.status) === '1';
            const toggleLabel = isActive ? 'Deactivate' : 'Activate';
            const percentage = r.percentage ? `${Number(r.percentage).toFixed(2)}%` : '0.00%';
            const description = (r.description || '').substring(0, 50) + ((r.description || '').length > 50 ? '...' : '');
            const studentsCount = r.students ?? 0;
            const type = String(r.type || 'Internal') === 'External'
                ? '<span class="badge bg-info text-dark">External</span>'
                : '<span class="badge bg-success-subtle text-success-emphasis">Internal</span>';
            return [
                bulkSelectionCell(r.id || r.scholarship_id),
            toCenter(r.code || ''),
            toCenter(r.name || ''),
            toCenter(type),
            toCenter(description),
            toCenter(percentage),
            toCenter(studentsCount),
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
                headings: [bulkSelectionHeading, 'Scholarship Code','Scholarship Name','Type','Description','Percentage','Students','Status','Actions'],
                data: dataset
            },
            columns: [{ select: 0, sortable: false }],
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('perPageSelectCustom')?.value || '10', 10),
            perPageSelect: false,
            info: false
        });

        this.populateScholarshipFilter(rows);
        this.bindFilters();
        this.bindPaginationFooter();
        this.updatePageInfo();
        this.movePaginationOutside();

        const updateRowIndices = () => {
            const tbody = el.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('scholarshipsTable');
            const perPage = this.table.options?.perPage || 10;
            const startIndex = (currentPage - 1) * perPage;
            Array.from(tbody.rows).forEach((tr, localIdx) => {
                const globalIdx = startIndex + localIdx;
                tr.setAttribute('data-row-index', String(globalIdx));
            });
        };

        const getRowData = (tr) => {
            const id = tr?.querySelector('[data-record-id]')?.dataset.recordId;
            return this.cachedRows?.find(row => String(row.id || row.scholarship_id) === id) || null;
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
            const res = await ApiService.get('/masterfiles/masterfiles-scholarships.php', { action: 'list' });
            if (res && Array.isArray(res.rows)) {
                this.cachedRows = res.rows;
                this.hydrateCounts(res);
            }
        } catch (_) {
            // graceful fallback: leave defaults (0)
        }
    }

    hydrateCounts(src) {
        const { totalScholarships } = src || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && (val || val === 0)) el.textContent = String(val);
        };
        set('statTotalScholarships', totalScholarships ?? 0);
    }

    bindToolbar() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
        const addBtn = document.getElementById('addScholarshipBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.openAddModal());
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.showImportExportDialog());
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const scholarshipMobile = document.getElementById('filterScholarshipMobile');
                const statusMobile = document.getElementById('filterStatusMobile');
                
                // Sync mobile filters to desktop filters
                const scholarshipDesktop = document.getElementById('filterScholarship');
                const statusDesktop = document.getElementById('filterStatus');
                
                if (scholarshipMobile && scholarshipDesktop) scholarshipDesktop.value = scholarshipMobile.value;
                if (statusMobile && statusDesktop) statusDesktop.value = statusMobile.value;
                
                // Trigger filter change
                if (scholarshipDesktop) scholarshipDesktop.dispatchEvent(new Event('change'));
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
        const searchMobile = document.getElementById('searchScholarshipsMobile');
        const searchDesktop = document.getElementById('searchScholarships');
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

    populateScholarshipFilter(rows) {
        const sel = document.getElementById('filterScholarship');
        const selMobile = document.getElementById('filterScholarshipMobile');
        const names = Array.from(new Set((rows || []).map(r => (r.name || r.scholarship_name || '').toString().trim()).filter(Boolean))).sort();
        
        if (sel) {
            const frag = document.createDocumentFragment();
            names.forEach(n => {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = n;
                frag.appendChild(opt);
            });
            sel.appendChild(frag);
        }
        
        // Populate mobile filter
        if (selMobile) {
            const frag = document.createDocumentFragment();
            names.forEach(n => {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = n;
                frag.appendChild(opt);
            });
            selMobile.appendChild(frag);
        }
    }

    bindFilters() {
        const scholarshipSel = document.getElementById('filterScholarship');
        const statusSel = document.getElementById('filterStatus');
        const searchEl = document.getElementById('searchScholarships');
        const apply = () => {
            if (!this.table) return;
            const scholarship = scholarshipSel?.value || '';
            const status = statusSel?.value || '';
            const terms = (searchEl?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [];
            this.tableSourceRows.forEach((row, index) => {
                if (scholarship && String(row.name || row.scholarship_name || '') !== scholarship) return;
                if (status && (String(row.status) === '1') !== (status === 'active')) return;
                const searchable = [row.code, row.name, row.type, row.description, row.percentage]
                    .filter(Boolean).join(' ').toLowerCase();
                if (terms.every(term => searchable.includes(term))) matches.push(this.tableSourceData[index]);
            });
            const rowCount = this.table.data?.data?.length || 0;
            if (rowCount) this.table.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (matches.length) this.table.insert({ data: matches });
            this.table.page(1);
            this.updatePageInfo();
        };
        if (scholarshipSel) scholarshipSel.addEventListener('change', apply);
        if (statusSel) statusSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', apply);
    }

    bindPaginationFooter() {
        const el = document.getElementById('scholarshipsTable');
        const updateRowIndices = () => {
            const tbody = el?.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('scholarshipsTable');
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
                this.table.page(Math.max(1, this.getTableCurrentPage('scholarshipsTable') - 1)); 
                setTimeout(() => {
                    updateRowIndices();
                    this.updatePageInfo();
                }, 100);
            } 
        });
        if (nextBtn) nextBtn.addEventListener('click', () => { 
            if (this.table) { 
                this.table.page(this.getTableCurrentPage('scholarshipsTable') + 1); 
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
        const page = Math.min(this.getTableCurrentPage('scholarshipsTable'), Math.max(1, Math.ceil(total / perPage)));
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
            const tableEl = document.getElementById('scholarshipsTable');
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
                        this.table.page(Math.max(1, this.getTableCurrentPage('scholarshipsTable') - 1));
                    } else if (text === '›' || text === '→') {
                        this.table.page(this.getTableCurrentPage('scholarshipsTable') + 1);
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
        if (!rbacUtil.requireMasterfilePermission('scholarships', 'create', 'create scholarships')) {
            return;
        }
        const title = document.getElementById('scholarshipModalTitle');
        if (title) title.textContent = 'Add Scholarship';
        this.fillForm({});
        this.showModal('scholarshipModal');
        const saveBtn = document.getElementById('saveScholarshipBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveScholarship('create');
            };
        }
    }

    openEditModal(row) {
        if (!rbacUtil.requireMasterfilePermission('scholarships', 'edit', 'edit scholarships')) {
            return;
        }
        const title = document.getElementById('scholarshipModalTitle');
        if (title) title.textContent = 'Edit Scholarship';
        this.fillForm(row);
        this.showModal('scholarshipModal');
        const saveBtn = document.getElementById('saveScholarshipBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveScholarship('update');
            };
        }
    }

    openViewModal(row) {
        const name = row.name || '';
        const code = row.code || '';
        const description = row.description || '-';
        const percentage = row.percentage ? `${Number(row.percentage).toFixed(2)}%` : '0.00%';
        const students = row.students ?? 0;
        const status = String(row.status) === '1' ? 'Active' : 'Inactive';
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
        
        // Store current row for edit button
        this.currentViewRow = row;
        
        // Scholarship Information
        setText('viewScholarshipCodeText', code);
        setText('viewScholarshipNameText', name);
        const type = String(row.type || row.scholarship_type || 'Internal') === 'External' ? 'External' : 'Internal';
        const typeEl = document.getElementById('viewScholarshipType');
        if (typeEl) {
            typeEl.textContent = type;
            typeEl.className = type === 'External' ? 'badge bg-info text-dark' : 'badge bg-success';
        }
        
        // Active Status
        const statusEl = document.getElementById('viewScholarshipStatus');
        if (statusEl) {
            statusEl.textContent = status;
            statusEl.className = status === 'Active' ? 'badge bg-success' : 'badge bg-secondary';
        }
        
        // Details
        setText('viewScholarshipDescription', description);
        setText('viewScholarshipPercentage', percentage);
        setText('viewScholarshipStudents', String(students));
        
        // Bind edit button if not already bound
        const editBtn = document.getElementById('editScholarshipFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                await this.hideModalAndWait('viewScholarshipModal');
                this.openEditModal(row);
            });
        }
        
        this.showModal('viewScholarshipModal');
    }

    fillForm(row) {
        const byId = (id) => document.getElementById(id);
        const setVal = (id, val) => { const el = byId(id); if (el) el.value = val || ''; };
        setVal('scholarship_id', row.id || row.scholarship_id || '');
        setVal('scholarship_code', row.code || row.scholarship_code || '');
        setVal('scholarship_name', row.name || row.scholarship_name || '');
        setVal('scholarship_description', row.description || row.scholarship_description || '');
        setVal('scholarship_percentage', row.percentage || row.scholarship_percentage || '0.00');
        const externalCheck = byId('scholarship_is_external');
        if (externalCheck) externalCheck.checked = String(row.type || row.scholarship_type || 'Internal') === 'External';
    }

    showModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        // eslint-disable-next-line no-undef
        const modal = bootstrap.Modal.getOrCreateInstance(el);
        modal.show();
    }

    hideModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        // eslint-disable-next-line no-undef
        const modal = bootstrap.Modal.getOrCreateInstance(el);
        modal.hide();
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

    confirmDelete(row) {
        if (!rbacUtil.requireMasterfilePermission('scholarships', 'delete', 'delete scholarships')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Delete scholarship?',
                text: (row.name || ''),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Delete',
                confirmButtonColor: '#d33'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-scholarships.php?action=delete', { scholarship_id: row.id || row.scholarship_id })
                        .then(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Deleted', 'Scholarship deleted.', 'success').then(() => window.location.reload());
                        })
                        .catch(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', 'Failed to delete scholarship.', 'error');
                        });
                }
            });
        }
    }

    toggleStatus(row) {
        if (!rbacUtil.requireMasterfilePermission('scholarships', 'edit', 'edit scholarships')) {
            return;
        }
        const isActive = String(row.status) === '1';
        const nextLabel = isActive ? 'deactivate' : 'activate';
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: `Confirm ${nextLabel}?`,
                text: (row.name || ''),
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: isActive ? 'Deactivate' : 'Activate'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-scholarships.php?action=toggle', { scholarship_id: row.id || row.scholarship_id })
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

    saveScholarship(mode) {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('scholarships', 'create', 'create scholarships')) {
            return;
        }
        if ((mode === 'update' || (document.getElementById('scholarship_id')?.value || '').trim()) && !rbacUtil.requireMasterfilePermission('scholarships', 'edit', 'edit scholarships')) {
            return;
        }
        const id = (document.getElementById('scholarship_id')?.value || '').trim();
        const code = (document.getElementById('scholarship_code')?.value || '').trim();
        const name = (document.getElementById('scholarship_name')?.value || '').trim();
        const description = (document.getElementById('scholarship_description')?.value || '').trim();
        const percentage = parseFloat(document.getElementById('scholarship_percentage')?.value || '0.00');
        const type = document.getElementById('scholarship_is_external')?.checked ? 'External' : 'Internal';
        if (!code || !name) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire('Missing fields', 'Scholarship Code and Name are required.', 'warning');
            return;
        }
        const payload = { scholarship_code: code, scholarship_name: name, scholarship_description: description, scholarship_percentage: percentage, scholarship_type: type };
        if (id) payload.scholarship_id = id;
        const url = mode === 'update' || id
            ? '/masterfiles/masterfiles-scholarships.php?action=update'
            : '/masterfiles/masterfiles-scholarships.php?action=create';
        ApiService.post(url, payload)
            .then(() => {
                this.hideModal('scholarshipModal');
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Success', `Scholarship ${mode === 'update' || id ? 'updated' : 'added'} successfully.`, 'success')
                    .then(() => window.location.reload());
            })
            .catch(() => {
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', 'Operation failed.', 'error');
            });
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

    async showImportExportDialog() {
        if (!window.Swal) return;
        const result = await window.Swal.fire({
            title: 'Import or Export',
            text: 'Choose an action for scholarships.',
            icon: 'question',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: '<i class="bi bi-upload me-1"></i>Import',
            denyButtonText: '<i class="bi bi-download me-1"></i>Export',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#03600f',
            denyButtonColor: '#03600f',
            cancelButtonColor: '#6c757d',
            reverseButtons: true,
        });
        if (result.isConfirmed) this.openImportModal();
        else if (result.isDenied) await this.onExportClick();
    }

    bindImportModal() {
        document.getElementById('scholarshipImportFile')?.addEventListener('change', (event) => this.previewScholarshipImport(event));
        document.getElementById('downloadScholarshipTemplateBtn')?.addEventListener('click', () => this.downloadScholarshipTemplate());
        document.getElementById('confirmScholarshipImportBtn')?.addEventListener('click', () => this.confirmScholarshipImport());
    }

    openImportModal() {
        if (!rbacUtil.requireMasterfilePermission('scholarships', 'create', 'import scholarships') ||
            !rbacUtil.requireMasterfilePermission('scholarships', 'edit', 'update scholarships through import')) return;
        this.importFile = null;
        document.getElementById('scholarshipImportFile').value = '';
        document.getElementById('scholarshipImportErrors').innerHTML = '';
        document.getElementById('scholarshipImportPreview').classList.add('d-none');
        document.getElementById('confirmScholarshipImportBtn').disabled = true;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('scholarshipImportModal')).show();
    }

    downloadScholarshipTemplate() {
        const rows = [
            ['Code', 'Scholarship', 'Type', 'Description', 'Percentage', 'Status'],
            ['EXAMPLE', 'Example Scholarship', 'Internal', 'Example description', '50.00%', 'Active'],
        ];
        const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
        this.downloadBlob(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }), 'scholarships_import_template.csv');
    }

    parseScholarshipCsv(text) {
        const rows = [];
        let row = [];
        let value = '';
        let quoted = false;
        const source = String(text || '');
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (char === '"') {
                if (quoted && source[index + 1] === '"') {
                    value += '"';
                    index++;
                } else quoted = !quoted;
            } else if (char === ',' && !quoted) {
                row.push(value);
                value = '';
            } else if ((char === '\n' || char === '\r') && !quoted) {
                if (char === '\r' && source[index + 1] === '\n') index++;
                row.push(value);
                if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
                row = [];
                value = '';
            } else value += char;
        }
        if (quoted) throw new Error('The CSV file has an unclosed quoted field.');
        row.push(value);
        if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
        return rows;
    }

    async previewScholarshipImport(event) {
        const file = event.target.files?.[0];
        const errors = document.getElementById('scholarshipImportErrors');
        const preview = document.getElementById('scholarshipImportPreview');
        const confirm = document.getElementById('confirmScholarshipImportBtn');
        errors.innerHTML = '';
        preview.classList.add('d-none');
        confirm.disabled = true;
        this.importFile = null;
        if (!file) return;
        try {
            if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Only CSV files can be imported.');
            if (file.size > 5 * 1024 * 1024) throw new Error('The CSV file must not exceed 5 MB.');
            const rows = this.parseScholarshipCsv(await file.text());
            if (rows.length < 2) throw new Error('The CSV file must contain a header and at least one data row.');
            const headers = rows[0].map(value => String(value).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
            if (!['code', 'scholarshipcode'].some(value => headers.includes(value)) ||
                !['scholarship', 'scholarshipname', 'name'].some(value => headers.includes(value))) {
                throw new Error('Invalid template. Required columns: Code and Scholarship.');
            }
            const previewRows = rows.slice(1, 11);
            document.getElementById('scholarshipImportPreviewHead').innerHTML = `<tr>${rows[0].map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr>`;
            document.getElementById('scholarshipImportPreviewBody').innerHTML = previewRows.map(row =>
                `<tr>${rows[0].map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`
            ).join('');
            document.getElementById('scholarshipImportCount').textContent = `${rows.length - 1} row${rows.length === 2 ? '' : 's'}`;
            preview.classList.remove('d-none');
            this.importFile = file;
            confirm.disabled = false;
        } catch (error) {
            errors.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(error.message || 'Unable to read this CSV file.')}</div>`;
        }
    }

    async confirmScholarshipImport() {
        if (!this.importFile || !window.Swal) return;
        const confirmation = await window.Swal.fire({
            title: 'Import Scholarships?',
            text: 'New codes will be added and existing codes will be updated.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Import',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#03600f',
        });
        if (!confirmation.isConfirmed) return;
        const button = document.getElementById('confirmScholarshipImportBtn');
        button.disabled = true;
        const startedAt = Date.now();
        let elapsedTimer = null;
        try {
            window.Swal.fire({
                title: 'Importing Scholarships...',
                html: `
                    <div>Validating and saving scholarships.</div>
                    <div class="progress mt-3" style="height: 20px;" role="progressbar" aria-label="Estimated scholarship import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="1">
                        <div id="scholarshipImportProgress" class="progress-bar progress-bar-striped progress-bar-animated bg-success" style="width: 1%; min-width: 2.5rem;">1%</div>
                    </div>
                    <div class="small text-muted mt-1">Estimated progress while the server processes the file</div>
                    <div id="scholarshipImportElapsed" class="small text-muted mt-2">Elapsed time: 0 seconds</div>
                `,
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    window.Swal.showLoading();
                    elapsedTimer = window.setInterval(() => {
                        const elapsedMs = Date.now() - startedAt;
                        const elapsed = Math.floor(elapsedMs / 1000);
                        const label = document.getElementById('scholarshipImportElapsed');
                        if (label) label.textContent = `Elapsed time: ${elapsed} second${elapsed === 1 ? '' : 's'}`;
                        const percent = Math.min(99, 1 + Math.floor(98 * (1 - Math.exp(-elapsedMs / 20000))));
                        const bar = document.getElementById('scholarshipImportProgress');
                        if (bar) {
                            bar.style.width = `${percent}%`;
                            bar.textContent = `${percent}%`;
                            bar.parentElement.setAttribute('aria-valuenow', String(percent));
                        }
                    }, 200);
                },
            });
            const formData = new FormData();
            formData.append('file', this.importFile);
            const response = await ApiService.postFormData('/masterfiles/masterfiles-scholarships.php?action=import', formData);
            if (!response?.success) throw new Error(response?.message || 'Unable to import scholarships.');
            if (elapsedTimer !== null) {
                window.clearInterval(elapsedTimer);
                elapsedTimer = null;
            }
            const bar = document.getElementById('scholarshipImportProgress');
            if (bar) {
                bar.style.width = '100%';
                bar.textContent = '100%';
                bar.parentElement.setAttribute('aria-valuenow', '100');
            }
            await new Promise(resolve => window.setTimeout(resolve, 300));
            const details = Array.isArray(response.errors) ? response.errors : [];
            bootstrap.Modal.getInstance(document.getElementById('scholarshipImportModal'))?.hide();
            await window.Swal.fire({
                icon: details.length ? 'warning' : 'success',
                title: 'Scholarships Imported',
                html: `<div class="text-start"><div><strong>${Number(response.created || 0)}</strong> added</div><div><strong>${Number(response.updated || 0)}</strong> updated</div><div><strong>${Number(response.skipped || 0)}</strong> skipped</div>${details.length ? `<hr><small>${details.slice(0, 8).map(escapeHtml).join('<br>')}${details.length > 8 ? `<br>...and ${details.length - 8} more` : ''}</small>` : ''}</div>`,
            });
            window.location.reload();
        } catch (error) {
            await window.Swal.fire({ icon: 'error', title: 'Import Failed', text: error?.response?.data?.message || error.message || 'Please try again.' });
            button.disabled = false;
        } finally {
            if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
        }
    }

    async onExportClick() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        const result = await swal.fire({
            title: 'Export Scholarships',
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
            Code: r.code || '',
            Scholarship: r.name || '',
            Type: r.type || 'Internal',
            Description: r.description || '',
            Percentage: r.percentage ? `${Number(r.percentage).toFixed(2)}%` : '0.00%',
            Status: String(r.status) === '1' ? 'Active' : 'Inactive'
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no scholarships to export.', confirmButtonColor: '#007319' });
            return;
        }

        const choice = result.value;
        if (choice === 'csv') {
            const headers = Object.keys(rows[0] || { Code: '', Scholarship: '', Type: '', Description: '', Percentage: '', Status: '' });
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }), 'scholarships.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(rows[0] || { Code: '', Scholarship: '', Type: '', Description: '', Percentage: '', Status: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${escapeHtml(String(r[h] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'scholarships.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(rows[0] || { Code: '', Scholarship: '', Type: '', Description: '', Percentage: '', Status: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${escapeHtml(String(r[h] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'scholarships.doc');
            return;
        }

        if (choice === 'pdf') {
            this.exportScholarshipsPDF(rows);
        }
    }
    
    exportScholarshipsPDF(rows) {
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

        const headers = ['Code', 'Scholarship Name', 'Type', 'Description', 'Percentage', 'Status'];
        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = rows.map((r, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            const rowData = [r.Code, r.Scholarship, r.Type, r.Description, r.Percentage, r.Status];
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Scholarships Report</title>
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
                            <h2>Scholarships Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> Scholarships</div>
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

export default MasterfilesScholarshipsModule;
