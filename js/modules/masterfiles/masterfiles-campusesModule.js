import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { INLINE_ACTION_IGNORE, masterfileEditToggleDelete } from '../../shared/shared-inline-actions.js';

const bulkSelectionHeading = '<input type="checkbox" class="form-check-input" data-bulk-all aria-label="Select all records on this page" hidden>';

function bulkSelectionCell(id) {
    return `<span data-record-id="${escapeHtml(String(id))}"><input type="checkbox" class="form-check-input" data-bulk-id="${escapeHtml(String(id))}" aria-label="Select record ${escapeHtml(String(id))}" hidden></span>`;
}

class MasterfilesCampusesModule {
    async bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        const tableId = 'campusesTable';
        const refreshId = 'refreshBtn';
        const resource = 'campuses';
        const endpoint = '/masterfiles/masterfiles-campuses.php';
        const idField = 'campus_id';
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
        const paginationContainer = tableEl?.closest('.table-responsive')?.parentElement;
        const active =
            wrapper?.querySelector('.datatable-pagination .datatable-active a') ||
            wrapper?.querySelector('.datatable-pagination .datatable-active button') ||
            paginationContainer?.querySelector('.datatable-pagination .datatable-active a') ||
            paginationContainer?.querySelector('.datatable-pagination .datatable-active button');
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

        await rbacUtil.init();
        await this.loadCounts();
        await this.buildTable();
        this.bindToolbar();
        this.bindStatCards();
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
        rbacUtil.applyActionPermissions('csdl');
    }

    async fetchCampuses() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-campuses.php', { action: 'list' });
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

    async loadCounts() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-campuses.php', { action: 'list' });
            if (res && Array.isArray(res.rows)) {
                this.cachedRows = res.rows;
                this.hydrateCounts(res);
            }
        } catch (_) {
            // leave defaults
        }
    }

    hydrateCounts(src) {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && (val || val === 0)) el.textContent = String(val);
        };
        set('statTotalCampuses', src?.totalCampuses ?? 0);
        set('statTotalStudents', src?.totalStudents ?? 0);
        set('statActiveCampuses', src?.activeCampuses ?? 0);
        set('statInactiveCampuses', src?.inactiveCampuses ?? 0);
    }

    bindStatCards() {
        const modalEl = document.getElementById('campusesListModal');
        const show = () => {
            if (!modalEl) return;
            // eslint-disable-next-line no-undef
            bootstrap.Modal.getOrCreateInstance(modalEl).show();
        };
        const setTitle = (t) => {
            const el = document.getElementById('campusesModalTitle');
            if (el) el.textContent = t;
        };
        const tbody = document.getElementById('campusesModalTableBody');
        const thead = document.querySelector('#campusesListModal thead');

        const renderRows = (rows, showStatus = true) => {
            if (!tbody) return;
            tbody.innerHTML = (rows || []).map((r) => {
                const status = String(r.status) === '1'
                    ? '<span class="badge bg-success">Active</span>'
                    : '<span class="badge bg-secondary">Inactive</span>';
                return `<tr>
                    <td class="text-center">${escapeHtml(r.code || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || '')}</td>
                    <td class="text-center">${escapeHtml(r.students ?? 0)}</td>
                    ${showStatus ? `<td class="text-center">${status}</td>` : ''}
                </tr>`;
            }).join('');
            if (!rows?.length) {
                tbody.innerHTML = `<tr><td class="text-center" colspan="${showStatus ? 4 : 3}">No data</td></tr>`;
            }
        };

        document.querySelectorAll('[data-view]').forEach((card) => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                if (view === 'activeCampuses') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Campus Code</th><th class="text-center">Campus Name</th><th class="text-center">Students</th><th class="text-center">Status</th></tr>';
                    setTitle('Active Campuses');
                    renderRows(rows.filter((r) => String(r.status) === '1'));
                    show();
                } else if (view === 'inactiveCampuses') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Campus Code</th><th class="text-center">Campus Name</th><th class="text-center">Students</th><th class="text-center">Status</th></tr>';
                    setTitle('Inactive Campuses');
                    renderRows(rows.filter((r) => String(r.status) === '0'));
                    show();
                } else if (view === 'campusesByStudents') {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Campus</th><th class="text-center">Students</th></tr>';
                    setTitle('Students by Campus');
                    const sorted = [...rows].sort((a, b) => (b.students || 0) - (a.students || 0));
                    if (tbody) {
                        tbody.innerHTML = sorted.map((r) => `<tr>
                            <td class="text-center">${escapeHtml(r.name || r.code || '')}</td>
                            <td class="text-center">${escapeHtml(r.students ?? 0)}</td>
                        </tr>`).join('') || '<tr><td class="text-center" colspan="2">No data</td></tr>';
                    }
                    show();
                } else {
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Campus Code</th><th class="text-center">Campus Name</th><th class="text-center">Students</th><th class="text-center">Status</th></tr>';
                    setTitle('All Campuses');
                    renderRows(rows);
                    show();
                }
            });
        });
    }

    async buildTable() {
        const el = document.getElementById('campusesTable');
        if (!el) return;

        const rows = this.cachedRows || await this.fetchCampuses();
        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;

        const dataset = rows.map((r) => {
            const isActive = String(r.status) === '1';
            const address = (r.address || '').substring(0, 60) + ((r.address || '').length > 60 ? '...' : '');
            return [
                bulkSelectionCell(r.id || r.campus_id),
                toCenter(escapeHtml(r.code || '')),
                toCenter(escapeHtml(r.name || '')),
                toCenter(escapeHtml(address || '-')),
                toCenter(String(r.students ?? 0)),
                `<span class="d-inline-flex justify-content-center w-100">${isActive ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>'}</span>`,
                `<span class="d-inline-flex justify-content-center w-100">${masterfileEditToggleDelete({ isActive })}</span>`,
            ];
        });

        this.tableSourceRows = rows;
        this.tableSourceData = dataset.map(cells => [...cells]);

        // eslint-disable-next-line no-undef
        this.table = new simpleDatatables.DataTable(el, {
            data: {
                headings: [bulkSelectionHeading, 'Campus Code', 'Campus Name', 'Address', 'Students', 'Status', 'Actions'],
                data: dataset,
            },
            columns: [{ select: 0, sortable: false }],
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('perPageSelectCustom')?.value || '10', 10),
            perPageSelect: false,
            info: false,
        });

        this.populateCampusFilter(rows);
        this.bindFilters();
        this.bindPaginationFooter();
        this.updatePageInfo();
        this.movePaginationOutside();
        this.bindTableActions(el);
    }

    bindTableActions(el) {
        const updateRowIndices = () => {
            const tbody = el.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('campusesTable');
            const perPage = this.table.options?.perPage || 10;
            const startIndex = (currentPage - 1) * perPage;
            Array.from(tbody.rows).forEach((tr, localIdx) => {
                tr.setAttribute('data-row-index', String(startIndex + localIdx));
            });
        };

        const getRowData = (tr) => {
            const id = tr?.querySelector('[data-record-id]')?.dataset.recordId;
            return this.cachedRows?.find(row => String(row.id || row.campus_id) === id) || null;
        };

        const tbody = el.querySelector('tbody');
        if (!tbody) return;

        updateRowIndices();
        const observer = new MutationObserver(() => setTimeout(updateRowIndices, 0));
        observer.observe(tbody, { childList: true, subtree: false });

        tbody.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;
            const tr = target.closest('tr');
            if (!tr) return;
            const row = getRowData(tr);
            if (!row) return;

            if (target.closest(`${INLINE_ACTION_IGNORE}, .action-edit, .action-delete, .action-toggle`)) {
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
                return;
            }
            this.openViewModal(row);
        });
    }

    populateCampusFilter(rows) {
        ['filterCampus', 'filterCampusMobile'].forEach((id) => {
            const sel = document.getElementById(id);
            if (!sel) return;
            const names = Array.from(new Set((rows || []).map((r) => String(r.name || '').trim()).filter(Boolean))).sort();
            names.forEach((n) => {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = n;
                sel.appendChild(opt);
            });
        });
    }

    bindFilters() {
        const campusSel = document.getElementById('filterCampus');
        const statusSel = document.getElementById('filterStatus');
        const searchEl = document.getElementById('searchCampuses');
        const apply = () => {
            if (!this.table) return;
            const campus = campusSel?.value || '';
            const status = statusSel?.value || '';
            const terms = (searchEl?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [];
            this.tableSourceRows.forEach((row, index) => {
                if (campus && String(row.name || '') !== campus) return;
                if (status && (String(row.status) === '1') !== (status === 'active')) return;
                const searchable = [row.code, row.name, row.address].filter(Boolean).join(' ').toLowerCase();
                if (terms.every(term => searchable.includes(term))) matches.push(this.tableSourceData[index]);
            });
            const rowCount = this.table.data?.data?.length || 0;
            if (rowCount) this.table.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (matches.length) this.table.insert({ data: matches });
            this.table.page(1);
            this.updatePageInfo();
        };
        if (campusSel) campusSel.addEventListener('change', apply);
        if (statusSel) statusSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', apply);
    }

    bindToolbar() {
        document.getElementById('refreshBtn')?.addEventListener('click', () => window.location.reload());
        document.getElementById('addCampusBtn')?.addEventListener('click', () => this.openAddModal());
        document.getElementById('exportBtn')?.addEventListener('click', () => this.onExportClick());

        document.getElementById('applyMobileFiltersBtn')?.addEventListener('click', () => {
            const campusMobile = document.getElementById('filterCampusMobile');
            const statusMobile = document.getElementById('filterStatusMobile');
            const campusDesktop = document.getElementById('filterCampus');
            const statusDesktop = document.getElementById('filterStatus');
            if (campusMobile && campusDesktop) campusDesktop.value = campusMobile.value;
            if (statusMobile && statusDesktop) statusDesktop.value = statusMobile.value;
            campusDesktop?.dispatchEvent(new Event('change'));
            statusDesktop?.dispatchEvent(new Event('change'));
            const mobileDropdown = document.getElementById('mobileFilterBtn');
            bootstrap.Dropdown.getInstance(mobileDropdown)?.hide();
        });

        const searchMobile = document.getElementById('searchCampusesMobile');
        const searchDesktop = document.getElementById('searchCampuses');
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

    bindPaginationFooter() {
        const perPageSel = document.getElementById('perPageSelectCustom');
        perPageSel?.addEventListener('change', () => {
            if (!this.table) return;
            this.table.options.perPage = parseInt(perPageSel.value, 10) || 10;
            this.table.update?.();
            setTimeout(() => this.updatePageInfo(), 100);
        });
        this.updatePageInfo();
    }

    updatePageInfo() {
        const infoEl = document.getElementById('pageInfo');
        if (!infoEl || !this.table) return;
        const perPage = this.table.options?.perPage || 10;
        const total = this.table.data?.data?.length ?? 0;
        const page = Math.min(this.getTableCurrentPage('campusesTable'), Math.max(1, Math.ceil(total / perPage)));
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
        const checkAndMove = () => {
            const tableEl = document.getElementById('campusesTable');
            const tableResponsive = tableEl?.closest('.table-responsive');
            const wrapper = tableEl?.closest('.datatable-wrapper');
            if (!tableEl || !tableResponsive || !wrapper) return;
            if (window.innerWidth > 767.98) return;
            const pagination = wrapper.querySelector('.datatable-pagination');
            if (!pagination || pagination.parentElement === tableResponsive.parentElement) return;
            tableResponsive.parentElement.insertBefore(pagination, tableResponsive.nextSibling);
        };
        checkAndMove();
        setTimeout(checkAndMove, 100);
        setTimeout(checkAndMove, 500);
    }

    openAddModal() {
        if (!rbacUtil.requireMasterfilePermission('campuses', 'create', 'create campuses')) return;
        const title = document.getElementById('campusModalTitle');
        if (title) title.textContent = 'Add Campus';
        this.fillForm({});
        this.showModal('campusModal');
        document.getElementById('saveCampusBtn').onclick = () => this.saveCampus('create');
    }

    openEditModal(row) {
        if (!rbacUtil.requireMasterfilePermission('campuses', 'edit', 'edit campuses')) return;
        const title = document.getElementById('campusModalTitle');
        if (title) title.textContent = 'Edit Campus';
        this.fillForm(row);
        this.showModal('campusModal');
        document.getElementById('saveCampusBtn').onclick = () => this.saveCampus('update');
    }

    openViewModal(row) {
        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? '-';
        };
        setText('viewCampusCodeText', row.code || '');
        setText('viewCampusNameText', row.name || '');
        setText('viewCampusAddress', row.address || '-');
        setText('viewCampusStudents', String(row.students ?? 0));
        const statusEl = document.getElementById('viewCampusStatus');
        if (statusEl) {
            const isActive = String(row.status) === '1';
            statusEl.textContent = isActive ? 'Active' : 'Inactive';
            statusEl.className = isActive ? 'badge bg-success' : 'badge bg-secondary';
        }
        const editBtn = document.getElementById('editCampusFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                await this.hideModalAndWait('viewCampusModal');
                this.openEditModal(row);
            });
        }
        this.showModal('viewCampusModal');
    }

    fillForm(row) {
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val ?? '';
        };
        setVal('campus_id', row.id || row.campus_id || '');
        setVal('campus_code', row.code || row.campus_code || '');
        setVal('campus_name', row.name || row.campus_name || '');
        setVal('campus_address', row.address || row.campus_address || '');
    }

    saveCampus(mode) {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('campuses', 'create', 'create campuses')) return;
        if (mode === 'update' && !rbacUtil.requireMasterfilePermission('campuses', 'edit', 'edit campuses')) return;
        const form = document.getElementById('campusForm');
        if (!form?.checkValidity()) {
            form?.reportValidity();
            return;
        }
        const getVal = (id) => (document.getElementById(id)?.value || '').trim();
        const payload = {
            campus_code: getVal('campus_code'),
            campus_name: getVal('campus_name'),
            campus_address: getVal('campus_address'),
        };
        const id = getVal('campus_id');
        if (id) payload.campus_id = id;
        const url = mode === 'update' || id
            ? '/masterfiles/masterfiles-campuses.php?action=update'
            : '/masterfiles/masterfiles-campuses.php?action=create';
        ApiService.post(url, payload)
            .then(() => {
                this.hideModal('campusModal');
                Swal?.fire('Success', `Campus ${mode === 'update' || id ? 'updated' : 'added'} successfully.`, 'success')
                    .then(() => window.location.reload());
            })
            .catch((err) => {
                Swal?.fire('Error', err?.response?.data?.message || 'Operation failed.', 'error');
            });
    }

    confirmDelete(row) {
        if (!rbacUtil.requireMasterfilePermission('campuses', 'delete', 'delete campuses')) return;
        Swal?.fire({
            title: 'Delete campus?',
            text: row.name || row.code || '',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete',
            confirmButtonColor: '#d33',
        }).then((res) => {
            if (!res.isConfirmed) return;
            ApiService.post('/masterfiles/masterfiles-campuses.php?action=delete', { campus_id: row.id || row.campus_id })
                .then(() => Swal.fire('Deleted', 'Campus deleted.', 'success').then(() => window.location.reload()))
                .catch((err) => Swal.fire('Error', err?.response?.data?.message || 'Failed to delete campus.', 'error'));
        });
    }

    toggleStatus(row) {
        if (!rbacUtil.requireMasterfilePermission('campuses', 'edit', 'edit campuses')) return;
        const isActive = String(row.status) === '1';
        Swal?.fire({
            title: `Confirm ${isActive ? 'deactivate' : 'activate'}?`,
            text: row.name || '',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: isActive ? 'Deactivate' : 'Activate',
        }).then((res) => {
            if (!res.isConfirmed) return;
            ApiService.post('/masterfiles/masterfiles-campuses.php?action=toggle', { campus_id: row.id || row.campus_id })
                .then(() => Swal.fire('Updated', 'Status updated.', 'success').then(() => window.location.reload()))
                .catch(() => Swal.fire('Error', 'Failed to update status.', 'error'));
        });
    }

    showModal(id) {
        const el = document.getElementById(id);
        if (el) bootstrap.Modal.getOrCreateInstance(el).show();
    }

    hideModal(id) {
        bootstrap.Modal.getInstance(document.getElementById(id))?.hide();
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
        const swal = window.Swal;
        if (!swal) return;
        
        // Show format selection dialog
        const result = await swal.fire({
            title: 'Export Campuses',
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
            customClass: { confirmButton: 'btn btn-success px-4', cancelButton: 'btn btn-secondary px-4', actions: 'd-flex gap-2', popup: 'swal2-custom-popup' },
        });
        
        if (!result.isConfirmed) return;
        
        // Prepare data rows
        const rows = (this.cachedRows || []).map((r) => ({
            Code: r.code || '',
            Name: r.name || '',
            Address: r.address || '',
            Students: r.students ?? 0,
            Status: String(r.status) === '1' ? 'Active' : 'Inactive',
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no campuses to export.', confirmButtonColor: '#007319' });
            return;
        }
        
        const headers = ['Code', 'Name', 'Address', 'Students', 'Status'];
        const format = result.value;
        
        // CSV Export
        if (format === 'csv') {
            const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
            const csv = [headers.join(',')].concat(
                rows.map((r) => headers.map((h) => esc(r[h])).join(','))
            ).join('\n');
            this.downloadBlob(
                new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 
                'campuses.csv'
            );
            return;
        }
        
        // Excel Export
        if (format === 'xls') {
            const th = headers.map((h) => `<th>${h}</th>`).join('');
            const trs = rows.map((r) => 
                `<tr>${headers.map((h) => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`
            ).join('');
            this.downloadBlob(
                new Blob([`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`], 
                { type: 'application/vnd.ms-excel' }), 
                'campuses.xls'
            );
            return;
        }
        
        // Word Export
        if (format === 'doc') {
            const th = headers.map((h) => `<th style="background-color: #03600f; color: white; padding: 8px; border: 1px solid #ddd;">${h}</th>`).join('');
            const trs = rows.map((r) => 
                `<tr>${headers.map((h) => `<td style="padding: 8px; border: 1px solid #ddd;">${String(r[h] ?? '')}</td>`).join('')}</tr>`
            ).join('');
            const html = `
                <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
                <head><meta charset='utf-8'><title>Campuses Report</title></head>
                <body>
                    <h2 style="color: #03600f;">CSDL Campuses Report</h2>
                    <p>Generated on: ${new Date().toLocaleString()}</p>
                    <table style="border-collapse: collapse; width: 100%;">
                        <thead><tr>${th}</tr></thead>
                        <tbody>${trs}</tbody>
                    </table>
                </body>
                </html>
            `;
            this.downloadBlob(
                new Blob(['\ufeff', html], { type: 'application/msword' }), 
                'campuses.doc'
            );
            return;
        }
        
        // PDF Export
        if (format === 'pdf') {
            this.exportPDF(rows);
        }
    }
    
    exportPDF(rows) {
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

        const headers = ['Code', 'Name', 'Address', 'Students', 'Status'];
        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = rows.map((r, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            const rowData = [r.Code, r.Name, r.Address, String(r.Students), r.Status];
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Campuses Report</title>
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
                            <h2>Campuses Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> Campuses</div>
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
        const navbarToggler = document.querySelector('.navbar-toggler');
        const mobileFilterBtn = document.getElementById('mobileFilterBtn');
        navbarToggler?.addEventListener('click', () => {
            bootstrap.Dropdown.getInstance(mobileFilterBtn)?.hide();
        });
    }
}

export default MasterfilesCampusesModule;
