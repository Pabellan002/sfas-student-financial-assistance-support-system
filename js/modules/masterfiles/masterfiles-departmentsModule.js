import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import {
    INLINE_ACTION_IGNORE,
    masterfileEditToggleDelete,
} from '../../shared/shared-inline-actions.js';

class MasterfilesDepartmentsModule {
    constructor() {
        this.table = null;
        this.cachedRows = null;
        this.programsTable = null;
        this.cachedPrograms = null;
        this.importMode = 'departments';
        this.importFile = null;
        this.selectedDepartmentIds = new Set();
        this.selectedProgramIds = new Set();
        this.departmentTableObserver = null;
        this.programTableObserver = null;
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
        // Initialize RBAC first
        await rbacUtil.init();
        
        await this.loadCounts();
        await this.buildTable();
        this.bindToolbar();
        this.bindDepartmentTableControls();
        this.bindStatCards();
        await this.updateDepartmentsByStudentsStat();
        
        // Apply RBAC permissions AFTER table is built
        rbacUtil.applyActionPermissions('csdl');

        // Programs tab (optional on this page)
        await this.buildProgramsTable();
        this.bindProgramsToolbar();
        this.bindProgramTableControls();
        this.bindImportModal();
        this.bindProgramsFilters();
        this.bindProgramsStatCards();
        
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
    }

    async fetchPrograms() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-programs.php', { action: 'list' });
            if (data && Array.isArray(data.rows)) {
                this.cachedPrograms = data.rows;
                return data.rows;
            }
            return [];
        } catch (_) {
            return [];
        }
    }

    hydrateProgramsCounts(rows) {
        const total = (rows || []).length;
        const active = (rows || []).filter(r => String(r.status) === '1').length;
        const inactive = total - active;
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };
        set('totalPrograms', total);
        set('programsActive', active);
        set('programsInactive', inactive);
        const badge = document.getElementById('programsTotalCountBadge');
        if (badge) badge.textContent = `${total} program${total !== 1 ? 's' : ''}`;
    }

    async buildProgramsTable() {
        const el = document.getElementById('programsTable2');
        if (!el) return;

        const rows = this.cachedPrograms || await this.fetchPrograms();
        this.selectedProgramIds.clear();
        this.hydrateProgramsCounts(rows);
        await this.updateProgramsByStudentsStat();

        // Populate program filters from programs list, and department select from departments list
        const depRows = this.cachedRows || await this.fetchDepartments();
        const progFilter = document.getElementById('programsFilterDepartment');
        const progFilterMobile = document.getElementById('programsFilterDepartmentMobile');
        const depSelect = document.getElementById('program_department_id2');
        const depNameById = new Map((depRows || []).map(d => [String(d.id || d.department_id), String(d.name || d.department_name || '')]));
        const depCodeById = new Map((depRows || []).map(d => [String(d.id || d.department_id), String(d.code || d.department_code || '')]));

        // Desktop Programs filter (by program name)
        if (progFilter) {
            progFilter.innerHTML = '<option value="">All Programs</option>';
            (rows || []).forEach(p => {
                const opt = document.createElement('option');
                const name = String(p.name || p.program_name || p.code || p.program_code || '');
                opt.value = name;
                opt.textContent = name;
                progFilter.appendChild(opt);
            });
        }

        // Mobile Programs filter (by program name)
        if (progFilterMobile) {
            progFilterMobile.innerHTML = '<option value="">All Programs</option>';
            (rows || []).forEach(p => {
                const opt = document.createElement('option');
                const name = String(p.name || p.program_name || p.code || p.program_code || '');
                opt.value = name;
                opt.textContent = name;
                progFilterMobile.appendChild(opt);
            });
        }
        if (depSelect) {
            depSelect.innerHTML = '<option value="">Select Department</option>';
            (depRows || []).forEach(d => {
                const opt = document.createElement('option');
                opt.value = String(d.id || d.department_id);
                opt.textContent = String(d.name || d.department_name || '');
                depSelect.appendChild(opt);
            });
        }

        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;
        const canBulkDelete = rbacUtil.canDeleteMasterfile('programs');
        const dataset = (rows || []).map((r) => {
            const isActive = String(r.status) === '1';
            const deptName = r.department_name || depNameById.get(String(r.department_id || r.program_department_id)) || '';
            const deptCode = r.department_code || depCodeById.get(String(r.department_id || r.program_department_id)) || '';
            const students = r.students ?? 0;
            const programId = Number(r.id || r.program_id || 0);
            const cells = [
                toCenter(`${escapeHtml(r.name || r.program_name || '')}<span class="visually-hidden">${isActive ? ' Active' : ' Inactive'}</span>`),
                toCenter(escapeHtml(r.code || r.program_code || '')),
                toCenter(escapeHtml(deptCode || '')),
                toCenter(String(students)),
                `<span class="d-inline-flex justify-content-center w-100" data-program-id="${programId}">${masterfileEditToggleDelete({
                    isActive,
                    editClass: 'programs-action-edit',
                    toggleClass: 'programs-action-toggle',
                    deleteClass: 'programs-action-delete',
                })}</span>`
            ];
            if (canBulkDelete) {
                cells.unshift(`<span class="d-flex justify-content-center"><input class="form-check-input program-select-checkbox" type="checkbox" data-program-id="${programId}" aria-label="Select ${escapeHtml(r.name || r.program_name || 'program')}"${programId > 0 ? '' : ' disabled'}></span>`);
            }
            return cells;
        });
        this.programSourceRows = rows || [];
        this.programSourceData = dataset.map(cells => [...cells]);
        const headings = ['Program', 'Code', 'Department Code', 'Students Enrolled', 'Actions'];
        if (canBulkDelete) {
            headings.unshift('<span class="d-flex justify-content-center"><input class="form-check-input" type="checkbox" id="selectAllPrograms" aria-label="Select all programs on this page"></span>');
        }

        // eslint-disable-next-line no-undef
        this.programsTable = new simpleDatatables.DataTable(el, {
            data: {
                headings,
                data: dataset
            },
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('programsPerPage')?.value || '10', 10),
            perPageSelect: false,
            info: false,
            columns: canBulkDelete
                ? [{ select: 0, sortable: false }, { select: headings.length - 1, sortable: false }]
                : [{ select: headings.length - 1, sortable: false }]
        });

        this.updateProgramsPageInfo();
        this.moveProgramsPaginationOutside();

        this.observeProgramTable(el);
        this.bindProgramTableControls();
        this.syncRenderedProgramSelections();
    }

    destroyProgramsTable() {
        const tableEl = document.getElementById('programsTable2');
        const tableResponsive = tableEl?.closest('.table-responsive');

        this.programTableObserver?.disconnect();
        this.programTableObserver = null;

        // Mobile pagination is moved outside the DataTable wrapper. Remove any
        // detached controls before destroying the table so they cannot pile up.
        tableResponsive?.parentElement
            ?.querySelectorAll('.table-responsive ~ .datatable-pagination')
            .forEach((pagination) => pagination.remove());

        if (this.programsTable) {
            this.programsTable.destroy();
            this.programsTable = null;
        }
    }

    getProgramRowFromTarget(target) {
        const tr = target.closest('tbody tr');
        const idSource = tr?.querySelector('[data-program-id]');
        const programId = Number(idSource?.dataset.programId || 0);
        if (!programId) return null;
        return (this.cachedPrograms || []).find((row) => Number(row.id || row.program_id || 0) === programId) || null;
    }

    bindProgramTableControls() {
        const table = document.getElementById('programsTable2');
        if (!table || table.dataset.programTableControlsBound === 'true') return;
        table.dataset.programTableControlsBound = 'true';

        table.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : event.target?.parentElement;
            if (!target || target.closest('.program-select-checkbox, #selectAllPrograms')) return;
            const row = this.getProgramRowFromTarget(target);
            if (!row) return;

            if (target.closest('.programs-action-edit')) {
                event.preventDefault();
                this.openProgramModal(row);
            } else if (target.closest('.programs-action-toggle')) {
                event.preventDefault();
                this.toggleProgram(row);
            } else if (target.closest('.programs-action-delete')) {
                event.preventDefault();
                this.deleteProgram(row);
            } else if (!target.closest(INLINE_ACTION_IGNORE)) {
                this.openProgramViewModal(row);
            }
        });

        table.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;

            if (target.id === 'selectAllPrograms') {
                this.getRenderedProgramCheckboxes().forEach((checkbox) => {
                    const programId = Number(checkbox.dataset.programId || 0);
                    if (!programId || checkbox.disabled) return;
                    checkbox.checked = target.checked;
                    if (target.checked) this.selectedProgramIds.add(programId);
                    else this.selectedProgramIds.delete(programId);
                });
                this.updateProgramBulkDeleteControls();
                return;
            }

            if (!target.classList.contains('program-select-checkbox')) return;
            const programId = Number(target.dataset.programId || 0);
            if (!programId) return;
            if (target.checked) this.selectedProgramIds.add(programId);
            else this.selectedProgramIds.delete(programId);
            this.updateProgramBulkDeleteControls();
        });

        const button = document.getElementById('bulkDeleteProgramsBtn');
        if (button) {
            button.style.display = rbacUtil.canDeleteMasterfile('programs') ? '' : 'none';
            if (button.dataset.bulkDeleteBound !== 'true') {
                button.dataset.bulkDeleteBound = 'true';
                button.addEventListener('click', () => this.bulkDeleteSelectedPrograms());
            }
        }
        this.updateProgramBulkDeleteControls();
    }

    observeProgramTable(table) {
        this.programTableObserver?.disconnect();
        this.programTableObserver = new MutationObserver(() => {
            window.requestAnimationFrame(() => this.syncRenderedProgramSelections());
        });
        this.programTableObserver.observe(table, { childList: true, subtree: true });
    }

    getRenderedProgramCheckboxes() {
        return Array.from(document.querySelectorAll('#programsTable2 tbody .program-select-checkbox'));
    }

    syncRenderedProgramSelections() {
        this.getRenderedProgramCheckboxes().forEach((checkbox) => {
            const programId = Number(checkbox.dataset.programId || 0);
            checkbox.checked = programId > 0 && this.selectedProgramIds.has(programId);
        });
        this.updateProgramBulkDeleteControls();
    }

    updateProgramBulkDeleteControls() {
        const count = this.selectedProgramIds.size;
        const button = document.getElementById('bulkDeleteProgramsBtn');
        const countElement = document.getElementById('bulkDeleteProgramsCount');
        if (button) button.disabled = count === 0;
        if (countElement) countElement.textContent = String(count);

        const checkboxes = this.getRenderedProgramCheckboxes().filter((checkbox) => !checkbox.disabled);
        const selectedOnPage = checkboxes.filter((checkbox) => this.selectedProgramIds.has(Number(checkbox.dataset.programId || 0))).length;
        const selectAll = document.getElementById('selectAllPrograms');
        if (selectAll) {
            selectAll.disabled = checkboxes.length === 0;
            selectAll.checked = checkboxes.length > 0 && selectedOnPage === checkboxes.length;
            selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < checkboxes.length;
        }
    }

    async bulkDeleteSelectedPrograms() {
        if (!rbacUtil.requireMasterfilePermission('programs', 'delete', 'delete programs')) return;
        const programIds = Array.from(this.selectedProgramIds);
        if (programIds.length === 0 || !window.Swal) return;

        const confirmation = await Swal.fire({
            title: `Delete ${programIds.length} selected program${programIds.length === 1 ? '' : 's'}?`,
            text: 'Programs assigned to students will be kept and reported.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete Selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc3545',
            reverseButtons: false,
        });
        if (!confirmation.isConfirmed) return;

        const button = document.getElementById('bulkDeleteProgramsBtn');
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
        }

        try {
            const response = await ApiService.post('/masterfiles/masterfiles-programs.php?action=bulk_delete', {
                program_ids: programIds,
            });
            const deletedCount = Number(response?.deleted_count || 0);
            const failed = Array.isArray(response?.failed) ? response.failed : [];

            if (failed.length > 0) {
                const labels = failed.slice(0, 4).map((item) => item.code || item.name || `Program ${item.program_id}`);
                const remaining = failed.length - labels.length;
                await Swal.fire({
                    icon: deletedCount > 0 ? 'warning' : 'error',
                    title: deletedCount > 0 ? 'Bulk delete partially completed' : 'Programs could not be deleted',
                    text: `${deletedCount} deleted. Kept: ${labels.join(', ')}${remaining > 0 ? ` and ${remaining} more` : ''}.`,
                    confirmButtonColor: '#03600f',
                });
            } else {
                await Swal.fire('Programs Deleted', `${deletedCount} program${deletedCount === 1 ? '' : 's'} deleted successfully.`, 'success');
            }
            if (deletedCount > 0) {
                window.location.hash = 'programs';
                window.location.reload();
            }
        } catch (error) {
            await Swal.fire('Bulk Delete Failed', error?.response?.data?.message || error?.message || 'Unable to delete the selected programs.', 'error');
        } finally {
            if (button) button.removeAttribute('aria-busy');
            this.updateProgramBulkDeleteControls();
        }
    }

    bindProgramsToolbar() {
        const refreshBtn = document.getElementById('programsRefreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', async () => {
            this.cachedPrograms = null;
            this.destroyProgramsTable();
            await this.buildProgramsTable();
        });

        const addBtn = document.getElementById('addProgramBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.openProgramModal(null));

        const saveBtn = document.getElementById('saveProgramBtn2');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveProgram());

        const exportBtn = document.getElementById('programsExportBtn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.showMasterDataImportExportDialog('programs'));

        // Mobile filter apply button (Programs)
        const applyMobileFiltersBtn = document.getElementById('programsApplyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const depMobile = document.getElementById('programsFilterDepartmentMobile');
                const statusMobile = document.getElementById('programsFilterStatusMobile');

                const depDesktop = document.getElementById('programsFilterDepartment');
                const statusDesktop = document.getElementById('programsFilterStatus');

                if (depMobile && depDesktop) depDesktop.value = depMobile.value;
                if (statusMobile && statusDesktop) statusDesktop.value = statusMobile.value;

                // Trigger filter change
                if (depDesktop) depDesktop.dispatchEvent(new Event('change'));
                if (statusDesktop) statusDesktop.dispatchEvent(new Event('change'));

                // Close mobile dropdown
                const mobileDropdown = document.getElementById('programsMobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }

        // Sync mobile search with desktop search (Programs)
        const searchMobile = document.getElementById('programsSearchMobile');
        const searchDesktop = document.getElementById('programsSearch');
        if (searchMobile && searchDesktop) {
            searchMobile.addEventListener('input', (e) => {
                searchDesktop.value = e.target.value;
                searchDesktop.dispatchEvent(new Event('input'));
            });
            searchDesktop.addEventListener('input', (e) => {
                searchMobile.value = e.target.value;
            });
        }

        const per = document.getElementById('programsPerPage');
        if (per) per.addEventListener('change', () => {
            if (!this.programsTable) return;
            const n = parseInt(per.value, 10) || 10;
            this.programsTable.options.perPage = n;
            if (typeof this.programsTable.update === 'function') this.programsTable.update();
            setTimeout(() => this.updateProgramsPageInfo(), 100);
        });
    }

    bindProgramsFilters() {
        const dep = document.getElementById('programsFilterDepartment');
        const st = document.getElementById('programsFilterStatus');
        const q = document.getElementById('programsSearch');
        const apply = () => {
            if (!this.programsTable) return;
            const program = dep?.value || '';
            const status = st?.value || '';
            const terms = (q?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [];
            this.programSourceRows.forEach((row, index) => {
                if (program && String(row.name || row.program_name || row.code || row.program_code || '') !== program) return;
                if (status && (String(row.status) === '1') !== (status === 'active')) return;
                const searchable = [row.name, row.program_name, row.code, row.program_code,
                    row.department_name, row.department_code].filter(Boolean).join(' ').toLowerCase();
                if (terms.every(term => searchable.includes(term))) matches.push(this.programSourceData[index]);
            });
            const rowCount = this.programsTable.data?.data?.length || 0;
            if (rowCount) this.programsTable.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (matches.length) this.programsTable.insert({ data: matches });
            this.programsTable.page(1);
            this.updateProgramsPageInfo();
        };
        if (dep) dep.addEventListener('change', apply);
        if (st) st.addEventListener('change', apply);
        if (q) q.addEventListener('input', apply);
    }

    updateProgramsPageInfo() {
        const infoEl = document.getElementById('programsPageInfo');
        if (!infoEl || !this.programsTable) return;
        const perPage = this.programsTable.options?.perPage || 10;
        const total = this.programsTable.data?.data?.length ?? 0;
        const page = Math.min(this.programsTable.currentPage || 1, Math.max(1, Math.ceil(total / perPage)));
        const start = total === 0 ? 0 : (page - 1) * perPage + 1;
        const end = Math.min(page * perPage, total);
        infoEl.textContent = `Showing ${start} to ${end} of ${total} entries`;
        const nav = document.getElementById('programsPagination');
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
            this.programsTable.page(Number(button.dataset.page));
            setTimeout(() => this.updateProgramsPageInfo(), 100);
        };
    }

    bindProgramsStatCards() {
        const cards = document.querySelectorAll('.stat-card[data-programs-view]');
        if (!cards.length) return;
        // eslint-disable-next-line no-undef
        this.programsListModal = new bootstrap.Modal(document.getElementById('programsListModal2'));
        cards.forEach(card => {
            card.addEventListener('click', async () => {
                const view = card.getAttribute('data-programs-view');
                await this.populateProgramsListModal(view);
            });
        });
    }

    async populateProgramsListModal(view) {
        const titleEl = document.getElementById('programsModalTitle2');
        const tbody = document.getElementById('programsModalTableBody2');
        const thead = document.getElementById('programsModalThead2');
        if (!titleEl || !tbody || !thead) return;

        const rows = this.cachedPrograms || await this.fetchPrograms();
        let dataRows = rows;
        let title = 'All Programs';

        if (view === 'activePrograms') {
            title = 'Active Programs';
            dataRows = (rows || []).filter(r => String(r.status) === '1');
        } else if (view === 'inactivePrograms') {
            title = 'Inactive Programs';
            dataRows = (rows || []).filter(r => String(r.status) === '0');
        } else if (view === 'programsByStudents') {
            title = 'Programs by Students';
            thead.innerHTML = '<tr><th class="text-center">Program</th><th class="text-center">Students</th></tr>';
            // Count students by program_name (quick)
            try {
                const studentsRes = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'list' });
                const students = studentsRes?.rows || [];
                const counts = new Map();
                (students || []).forEach(s => {
                    const p = String(s.program_name || 'Unknown');
                    counts.set(p, (counts.get(p) || 0) + 1);
                });
                const list = Array.from(counts.entries()).map(([program, students]) => ({ program, students }));
                tbody.innerHTML = list.map(r => `<tr><td class="text-center">${escapeHtml(r.program)}</td><td class="text-center">${escapeHtml(r.students)}</td></tr>`).join('');
                titleEl.textContent = title;
                this.programsListModal.show();
                return;
            } catch (_) {
                tbody.innerHTML = '<tr><td class="text-center" colspan="2">No data</td></tr>';
                titleEl.textContent = title;
                this.programsListModal.show();
                return;
            }
        } else {
            thead.innerHTML = '<tr><th class="text-center">Program Code</th><th class="text-center">Program Name</th><th class="text-center">Department</th><th class="text-center">Status</th></tr>';
        }

        titleEl.textContent = title;
        if (!dataRows || dataRows.length === 0) {
            tbody.innerHTML = '<tr><td class="text-center" colspan="4">No data</td></tr>';
        } else {
            tbody.innerHTML = dataRows.map(r => {
                const status = String(r.status) === '1' ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>';
                return `<tr>
                    <td class="text-center">${escapeHtml(r.code || r.program_code || '')}</td>
                    <td class="text-center">${escapeHtml(r.name || r.program_name || '')}</td>
                    <td class="text-center">${escapeHtml(r.department_name || '')}</td>
                    <td class="text-center">${status}</td>
                </tr>`;
            }).join('');
        }
        this.programsListModal.show();
    }

    async updateProgramsByStudentsStat() {
        try {
            const studentsRes = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'list' });
            const students = studentsRes?.rows || [];
            const totalStudents = (students || []).length;
            const el = document.getElementById('programsByStudents');
            if (el) el.textContent = String(totalStudents || 0);
        } catch (_) {
            const el = document.getElementById('programsByStudents');
            if (el) el.textContent = '0';
        }
    }

    openProgramModal(row) {
        if (!row && !rbacUtil.requireMasterfilePermission('programs', 'create', 'create programs')) {
            return;
        }
        if (row && !rbacUtil.requireMasterfilePermission('programs', 'edit', 'edit programs')) {
            return;
        }
        const modalEl = document.getElementById('programModal2');
        if (!modalEl) return;
        // eslint-disable-next-line no-undef
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        const title = document.getElementById('programModalTitle2');
        const idEl = document.getElementById('program_id2');
        const codeEl = document.getElementById('program_code2');
        const nameEl = document.getElementById('program_name2');
        const depEl = document.getElementById('program_department_id2');
        if (!idEl || !codeEl || !nameEl || !depEl) return;

        if (row) {
            if (title) title.textContent = 'Edit Program';
            idEl.value = row.id || row.program_id || '';
            codeEl.value = row.code || row.program_code || '';
            nameEl.value = row.name || row.program_name || '';
            depEl.value = String(row.department_id || row.program_department_id || '');
        } else {
            if (title) title.textContent = 'Add Program';
            idEl.value = '';
            codeEl.value = '';
            nameEl.value = '';
            depEl.value = '';
        }
        modal.show();
    }

    async saveProgram() {
        const idEl = document.getElementById('program_id2');
        const codeEl = document.getElementById('program_code2');
        const nameEl = document.getElementById('program_name2');
        const depEl = document.getElementById('program_department_id2');
        if (!idEl || !codeEl || !nameEl || !depEl) return;

        const payload = {
            action: idEl.value ? 'update' : 'create',
            id: idEl.value ? parseInt(idEl.value, 10) : undefined,
            code: codeEl.value.trim(),
            name: nameEl.value.trim(),
            department_id: parseInt(depEl.value, 10) || 0
        };

        if (payload.action === 'create' && !rbacUtil.requireMasterfilePermission('programs', 'create', 'create programs')) {
            return;
        }
        if (payload.action === 'update' && !rbacUtil.requireMasterfilePermission('programs', 'edit', 'edit programs')) {
            return;
        }

        if (!payload.code || !payload.name || !payload.department_id) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire('Missing fields', 'Program Code, Name, and Department are required.', 'warning');
            return;
        }

        try {
            const res = await ApiService.post('/masterfiles/masterfiles-programs.php?action=' + payload.action, payload);
            if (!res?.success) throw new Error(res?.message || 'Failed');
            const modalEl = document.getElementById('programModal2');
            // eslint-disable-next-line no-undef
            bootstrap.Modal.getInstance(modalEl)?.hide();
            // eslint-disable-next-line no-undef
            const modeText = payload.action === 'update' ? 'updated' : 'added';
            if (window.Swal) await Swal.fire('Success', `Program ${modeText} successfully.`, 'success');
            window.location.hash = 'programs';
            window.location.reload();
        } catch (e) {
            const msg = e?.response?.data?.message || e?.message || 'Failed to save program.';
            // eslint-disable-next-line no-undef
            Swal && Swal.fire('Error', String(msg), 'error');
        }
    }

    async toggleProgram(row) {
        if (!rbacUtil.requireMasterfilePermission('programs', 'edit', 'edit programs')) {
            return;
        }
        const isActive = String(row.status) === '1';
        const nextLabel = isActive ? 'deactivate' : 'activate';
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: `Confirm ${nextLabel}?`,
                text: (row.name || row.program_name || ''),
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: isActive ? 'Deactivate' : 'Activate'
            }).then(async (resDlg) => {
                if (!resDlg.isConfirmed) return;
                try {
                    const id = row.id || row.program_id;
                    const res = await ApiService.post('/masterfiles/masterfiles-programs.php?action=toggle', { id });
                    if (!res?.success) throw new Error(res?.message || 'Failed');
                    // eslint-disable-next-line no-undef
                    await Swal.fire('Updated', 'Status updated.', 'success');
                    window.location.hash = 'programs';
                    window.location.reload();
                } catch (e) {
                    // eslint-disable-next-line no-undef
                    Swal && Swal.fire('Error', String(e.message || e), 'error');
                }
            });
        }
    }

    async deleteProgram(row) {
        if (!rbacUtil.requireMasterfilePermission('programs', 'delete', 'delete programs')) {
            return;
        }
        const id = row.id || row.program_id;
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        const ok = await swal.fire({
            title: 'Delete program?',
            text: (row.name || row.program_name || ''),
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete',
            confirmButtonColor: '#d33'
        });
        if (!ok.isConfirmed) return;
        try {
            const res = await ApiService.post('/masterfiles/masterfiles-programs.php?action=delete', { id });
            if (!res?.success) throw new Error(res?.message || 'Failed');
            await swal.fire('Deleted', 'Program deleted.', 'success');
            window.location.hash = 'programs';
            window.location.reload();
        } catch (e) {
            swal.fire('Error', String(e?.response?.data?.message || e?.message || e), 'error');
        }
    }

    openProgramViewModal(row) {
        const code = row.code || row.program_code || '';
        const name = row.name || row.program_name || '';
        const dept = row.department_name || '';
        const students = row.students || 0;
        const statusLabel = String(row.status) === '1' ? 'Active' : 'Inactive';

        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val || '-';
        };

        setText('viewProgramCodeText', code);
        setText('viewProgramNameText', name);
        setText('viewProgramDepartmentText', dept);
        setText('viewProgramStudents', String(students));

        const statusEl = document.getElementById('viewProgramStatus');
        if (statusEl) {
            statusEl.textContent = statusLabel;
            statusEl.className = statusLabel === 'Active' ? 'badge bg-success' : 'badge bg-secondary';
        }

        this.currentProgramViewRow = row;

        const editBtn = document.getElementById('editProgramFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                await this.hideModalAndWait('viewProgramModal');
                this.openProgramModal(this.currentProgramViewRow);
            });
        }

        this.showModal('viewProgramModal');
    }

    async fetchDepartments() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-departments.php', { action: 'list' });
            if (data && Array.isArray(data.rows)) {
                this.cachedRows = data.rows;
                // Also hydrate counts if available
                this.hydrateCounts(data);
                return data.rows;
            }
            return [];
        } catch (_) {
            return [];
        }
    }

    // ===== Stat cards modal binding =====
    bindStatCards() {
        const cards = document.querySelectorAll('.stat-card[data-view]');
        if (!cards.length) return;
        // eslint-disable-next-line no-undef
        this.departmentsListModal = new bootstrap.Modal(document.getElementById('departmentsListModal'));
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                this.populateDepartmentsListModal(view);
            });
        });
    }

    async populateDepartmentsListModal(view) {
        const titleEl = document.getElementById('departmentsModalTitle');
        const tbody = document.getElementById('departmentsModalTableBody');
        const head1 = document.getElementById('depHeadCol1');
        const head2 = document.getElementById('depHeadCol2');
        const head3 = document.getElementById('depHeadCol3');
        if (!titleEl || !tbody || !head1 || !head2 || !head3) return;

        let rows = this.cachedRows;
        if (!rows || !Array.isArray(rows)) {
            rows = await this.fetchDepartments();
        }

        // Default: departments listing
        head1.textContent = 'Department Code';
        head2.textContent = 'Department Name';
        head3.textContent = 'Status';

        let dataRows = [];
        let title = 'Departments';

        if (view === 'allDepartments') {
            title = 'All Departments';
            dataRows = rows;
        } else if (view === 'activeDepartments') {
            title = 'Active Departments';
            dataRows = (rows || []).filter(r => String(r.status) === '1');
        } else if (view === 'inactiveDepartments') {
            title = 'Inactive Departments';
            dataRows = (rows || []).filter(r => String(r.status) === '0');
        } else if (view === 'departmentsByStudents') {
            title = 'Departments by Students';
            // Switch headers to Department + Students
            head1.textContent = 'Department';
            head2.textContent = 'Students';
            head3.textContent = '';
            // Fetch students and map to dept via programs
            try {
                const [studentsRes, programsRes] = await Promise.all([
                    ApiService.get('/masterfiles/masterfiles-students.php', { action: 'list' }),
                    ApiService.get('/masterfiles/masterfiles-programs.php', { action: 'list' })
                ]);
                const students = studentsRes?.rows || [];
                const programs = programsRes?.rows || [];
                const programIdToDept = new Map();
                (programs || []).forEach(p => {
                    programIdToDept.set(String(p.id ?? p.program_id), p.department_name || 'Unknown');
                });
                const depCounts = new Map();
                (students || []).forEach(s => {
                    const pid = String(s.program_id ?? s.student_program_id);
                    const dept = programIdToDept.get(pid) || 'Unknown';
                    depCounts.set(dept, (depCounts.get(dept) || 0) + 1);
                });
                dataRows = Array.from(depCounts.entries()).map(([department_name, students]) => ({ department_name, students }));
            } catch (_) {
                dataRows = [];
            }
        }

        titleEl.textContent = title;

        if (!dataRows || dataRows.length === 0) {
            const visibleCols = [head1.textContent, head2.textContent, head3.textContent].filter(Boolean).length;
            tbody.innerHTML = `<tr><td colspan="${Math.max(visibleCols, 1)}" class="text-center text-muted">No data</td></tr>`;
        } else {
            if (view === 'departmentsByStudents') {
                tbody.innerHTML = dataRows.map(r => (
                    `<tr>
                        <td class="text-center">${escapeHtml(r.department_name || '')}</td>
                        <td class="text-center">${escapeHtml(r.students || 0)}</td>
                    </tr>`
                )).join('');
            } else {
                tbody.innerHTML = dataRows.map(r => {
                    const statusBadge = String(r.status) === '1'
                        ? '<span class="badge bg-success">Active</span>'
                        : '<span class="badge bg-secondary">Inactive</span>';
                    return (
                        `<tr>
                            <td class="text-center">${escapeHtml(r.code || r.department_code || '')}</td>
                            <td class="text-center">${escapeHtml(r.name || r.department_name || '')}</td>
                            <td class="text-center">${statusBadge}</td>
                        </tr>`
                    );
                }).join('');
            }
        }

        this.departmentsListModal && this.departmentsListModal.show();
    }

    async updateDepartmentsByStudentsStat() {
        try {
            const [studentsRes, programsRes] = await Promise.all([
                ApiService.get('/masterfiles/masterfiles-students.php', { action: 'list' }),
                ApiService.get('/masterfiles/masterfiles-programs.php', { action: 'list' })
            ]);
            const students = studentsRes?.rows || [];
            const programs = programsRes?.rows || [];
            const programIdToDept = new Map();
            (programs || []).forEach(p => {
                programIdToDept.set(String(p.id ?? p.program_id), p.department_name || 'Unknown');
            });
            const depSet = new Set();
            (students || []).forEach(s => {
                const pid = String(s.program_id ?? s.student_program_id);
                const dept = programIdToDept.get(pid) || 'Unknown';
                if (dept) depSet.add(dept);
            });
            const el = document.getElementById('statDepartmentsByStudents');
            if (el) el.textContent = String(depSet.size || 0);
            const totalStudentsEl = document.getElementById('totalStudentsEnrolled');
            if (totalStudentsEl) totalStudentsEl.textContent = String(students.length || 0);
        } catch (_) {
            const el = document.getElementById('statDepartmentsByStudents');
            if (el) el.textContent = '0';
            const totalStudentsEl = document.getElementById('totalStudentsEnrolled');
            if (totalStudentsEl) totalStudentsEl.textContent = '0';
        }
    }

    async buildTable() {
        const el = document.getElementById('departmentsTable');
        if (!el) return;

        const rows = this.cachedRows || await this.fetchDepartments();
        this.selectedDepartmentIds.clear();

        // Update stat cards based on fetched data
        const totalEl = document.getElementById('totalDepartments');
        const codesEl = document.getElementById('departmentsWithCodes');
        if (totalEl) totalEl.textContent = String(rows.length);
        if (codesEl) codesEl.textContent = String(rows.filter(r => (r.code || r.department_code || '').toString().trim().length > 0).length);

        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;
        const canBulkDelete = rbacUtil.canDeleteMasterfile('departments');
        const dataset = rows.map(r => {
            const isActive = String(r.status) === '1';
            const students = r.students ?? 0;
            const departmentId = Number(r.id || r.department_id || 0);
            const cells = [
                toCenter(`${escapeHtml(r.name || r.department_name || '')}<span class="visually-hidden">${isActive ? ' Active' : ' Inactive'}</span>`),
                toCenter(escapeHtml(r.code || r.department_code || '')),
                toCenter(String(students)),
                `<span class="d-inline-flex justify-content-center w-100" data-department-id="${departmentId}">${masterfileEditToggleDelete({ isActive })}</span>`,
            ];
            if (canBulkDelete) {
                cells.unshift(`<span class="d-flex justify-content-center"><input class="form-check-input department-select-checkbox" type="checkbox" data-department-id="${departmentId}" aria-label="Select ${escapeHtml(r.name || r.department_name || 'department')}"${departmentId > 0 ? '' : ' disabled'}></span>`);
            }
            return cells;
        });
        this.tableSourceRows = rows;
        this.tableSourceData = dataset.map(cells => [...cells]);
        const headings = ['Department', 'Code', 'Students Enrolled', 'Actions'];
        if (canBulkDelete) {
            headings.unshift('<span class="d-flex justify-content-center"><input class="form-check-input" type="checkbox" id="selectAllDepartments" aria-label="Select all departments on this page"></span>');
        }

        // eslint-disable-next-line no-undef
        this.table = new simpleDatatables.DataTable(el, {
            data: {
                headings,
                data: dataset
            },
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('perPageSelectCustom')?.value || '10', 10),
            perPageSelect: false,
            info: false,
            columns: canBulkDelete
                ? [{ select: 0, sortable: false }, { select: headings.length - 1, sortable: false }]
                : [{ select: headings.length - 1, sortable: false }]
        });

        this.populateDepartmentFilter(rows);
        this.bindFilters();
        this.bindPaginationFooter();
        this.updatePageInfo();
        this.movePaginationOutside();

        this.observeDepartmentTable(el);
        this.bindDepartmentTableControls();
        this.syncRenderedDepartmentSelections();
    }

    getDepartmentRowFromTarget(target) {
        const tr = target.closest('tbody tr');
        const idSource = tr?.querySelector('[data-department-id]');
        const departmentId = Number(idSource?.dataset.departmentId || 0);
        if (!departmentId) return null;
        return (this.cachedRows || []).find((row) => Number(row.id || row.department_id || 0) === departmentId) || null;
    }

    bindDepartmentTableControls() {
        const table = document.getElementById('departmentsTable');
        if (!table || table.dataset.departmentTableControlsBound === 'true') return;
        table.dataset.departmentTableControlsBound = 'true';

        table.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : event.target?.parentElement;
            if (!target || target.closest('.department-select-checkbox, #selectAllDepartments')) return;
            const row = this.getDepartmentRowFromTarget(target);
            if (!row) return;

            if (target.closest('.action-edit')) {
                event.preventDefault();
                this.openEditModal(row);
            } else if (target.closest('.action-delete')) {
                event.preventDefault();
                this.confirmDelete(row);
            } else if (target.closest('.action-toggle')) {
                event.preventDefault();
                this.toggleStatus(row);
            } else if (!target.closest(INLINE_ACTION_IGNORE)) {
                this.openViewModal(row);
            }
        });

        table.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;

            if (target.id === 'selectAllDepartments') {
                this.getRenderedDepartmentCheckboxes().forEach((checkbox) => {
                    const departmentId = Number(checkbox.dataset.departmentId || 0);
                    if (!departmentId || checkbox.disabled) return;
                    checkbox.checked = target.checked;
                    if (target.checked) this.selectedDepartmentIds.add(departmentId);
                    else this.selectedDepartmentIds.delete(departmentId);
                });
                this.updateDepartmentBulkDeleteControls();
                return;
            }

            if (!target.classList.contains('department-select-checkbox')) return;
            const departmentId = Number(target.dataset.departmentId || 0);
            if (!departmentId) return;
            if (target.checked) this.selectedDepartmentIds.add(departmentId);
            else this.selectedDepartmentIds.delete(departmentId);
            this.updateDepartmentBulkDeleteControls();
        });

        const button = document.getElementById('bulkDeleteDepartmentsBtn');
        if (button) {
            button.style.display = rbacUtil.canDeleteMasterfile('departments') ? '' : 'none';
            if (button.dataset.bulkDeleteBound !== 'true') {
                button.dataset.bulkDeleteBound = 'true';
                button.addEventListener('click', () => this.bulkDeleteSelectedDepartments());
            }
        }
        this.updateDepartmentBulkDeleteControls();
    }

    observeDepartmentTable(table) {
        this.departmentTableObserver?.disconnect();
        this.departmentTableObserver = new MutationObserver(() => {
            window.requestAnimationFrame(() => this.syncRenderedDepartmentSelections());
        });
        this.departmentTableObserver.observe(table, { childList: true, subtree: true });
    }

    getRenderedDepartmentCheckboxes() {
        return Array.from(document.querySelectorAll('#departmentsTable tbody .department-select-checkbox'));
    }

    syncRenderedDepartmentSelections() {
        this.getRenderedDepartmentCheckboxes().forEach((checkbox) => {
            const departmentId = Number(checkbox.dataset.departmentId || 0);
            checkbox.checked = departmentId > 0 && this.selectedDepartmentIds.has(departmentId);
        });
        this.updateDepartmentBulkDeleteControls();
    }

    updateDepartmentBulkDeleteControls() {
        const count = this.selectedDepartmentIds.size;
        const button = document.getElementById('bulkDeleteDepartmentsBtn');
        const countElement = document.getElementById('bulkDeleteDepartmentsCount');
        if (button) button.disabled = count === 0;
        if (countElement) countElement.textContent = String(count);

        const checkboxes = this.getRenderedDepartmentCheckboxes().filter((checkbox) => !checkbox.disabled);
        const selectedOnPage = checkboxes.filter((checkbox) => this.selectedDepartmentIds.has(Number(checkbox.dataset.departmentId || 0))).length;
        const selectAll = document.getElementById('selectAllDepartments');
        if (selectAll) {
            selectAll.disabled = checkboxes.length === 0;
            selectAll.checked = checkboxes.length > 0 && selectedOnPage === checkboxes.length;
            selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < checkboxes.length;
        }
    }

    async bulkDeleteSelectedDepartments() {
        if (!rbacUtil.requireMasterfilePermission('departments', 'delete', 'delete departments')) return;
        const departmentIds = Array.from(this.selectedDepartmentIds);
        if (departmentIds.length === 0 || !window.Swal) return;

        const confirmation = await Swal.fire({
            title: `Delete ${departmentIds.length} selected department${departmentIds.length === 1 ? '' : 's'}?`,
            text: 'Departments that still contain programs will be kept and reported.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete Selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc3545',
            reverseButtons: false,
        });
        if (!confirmation.isConfirmed) return;

        const button = document.getElementById('bulkDeleteDepartmentsBtn');
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
        }

        try {
            const response = await ApiService.post('/masterfiles/masterfiles-departments.php?action=bulk_delete', {
                department_ids: departmentIds,
            });
            const deletedCount = Number(response?.deleted_count || 0);
            const failed = Array.isArray(response?.failed) ? response.failed : [];
            this.selectedDepartmentIds.clear();

            if (failed.length > 0) {
                const labels = failed.slice(0, 4).map((item) => item.code || item.name || `Department ${item.department_id}`);
                const remaining = failed.length - labels.length;
                await Swal.fire({
                    icon: deletedCount > 0 ? 'warning' : 'error',
                    title: deletedCount > 0 ? 'Bulk delete partially completed' : 'Departments could not be deleted',
                    text: `${deletedCount} deleted. Kept: ${labels.join(', ')}${remaining > 0 ? ` and ${remaining} more` : ''}.`,
                    confirmButtonColor: '#03600f',
                });
            } else {
                await Swal.fire('Departments Deleted', `${deletedCount} department${deletedCount === 1 ? '' : 's'} deleted successfully.`, 'success');
            }
            window.location.reload();
        } catch (error) {
            await Swal.fire('Bulk Delete Failed', error?.response?.data?.message || error?.message || 'Unable to delete the selected departments.', 'error');
        } finally {
            if (button) button.removeAttribute('aria-busy');
            this.updateDepartmentBulkDeleteControls();
        }
    }

    async loadCounts() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-departments.php', { action: 'list' });
            if (res && Array.isArray(res.rows)) {
                this.cachedRows = res.rows;
                this.hydrateCounts(res);
            }
        } catch (_) {
            // graceful fallback: leave defaults (0)
        }
    }

    hydrateCounts(src) {
        const { totalDepartments, totalPrograms, activeDepartments, inactiveDepartments } = src || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && (val || val === 0)) el.textContent = String(val);
        };
        set('totalDepartments', totalDepartments ?? 0);
        set('totalPrograms', totalPrograms ?? 0);
        set('activeDepartments', activeDepartments ?? 0);
        set('inactiveDepartments', inactiveDepartments ?? 0);
    }

    bindToolbar() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
        const addBtn = document.getElementById('addDepartmentBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.openAddModal());
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.showMasterDataImportExportDialog('departments'));
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const depMobile = document.getElementById('filterDepartmentMobile');
                const statusMobile = document.getElementById('filterStatusMobile');
                
                // Sync mobile filters to desktop filters
                const depDesktop = document.getElementById('filterDepartment');
                const statusDesktop = document.getElementById('filterStatus');
                
                if (depMobile && depDesktop) depDesktop.value = depMobile.value;
                if (statusMobile && statusDesktop) statusDesktop.value = statusMobile.value;
                
                // Trigger filter change
                if (depDesktop) depDesktop.dispatchEvent(new Event('change'));
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
        const searchMobile = document.getElementById('searchDepartmentsMobile');
        const searchDesktop = document.getElementById('searchDepartments');
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

    populateDepartmentFilter(rows) {
        const sel = document.getElementById('filterDepartment');
        const selMobile = document.getElementById('filterDepartmentMobile');
        const names = Array.from(new Set((rows || []).map(r => (r.name || r.department_name || '').toString().trim()).filter(Boolean))).sort();
        
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
        const depSel = document.getElementById('filterDepartment');
        const statusSel = document.getElementById('filterStatus');
        const searchEl = document.getElementById('searchDepartments');
        const apply = () => {
            if (!this.table) return;
            const department = depSel?.value || '';
            const status = statusSel?.value || '';
            const terms = (searchEl?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [];
            this.tableSourceRows.forEach((row, index) => {
                if (department && String(row.name || row.department_name || '') !== department) return;
                if (status && (String(row.status) === '1') !== (status === 'active')) return;
                const searchable = [row.name, row.department_name, row.code, row.department_code]
                    .filter(Boolean).join(' ').toLowerCase();
                if (terms.every(term => searchable.includes(term))) matches.push(this.tableSourceData[index]);
            });
            const rowCount = this.table.data?.data?.length || 0;
            if (rowCount) this.table.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (matches.length) this.table.insert({ data: matches });
            this.table.page(1);
            this.updatePageInfo();
        };
        if (depSel) depSel.addEventListener('change', apply);
        if (statusSel) statusSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', apply);
    }

    bindPaginationFooter() {
        const el = document.getElementById('departmentsTable');
        const updateRowIndices = () => {
            const tbody = el?.querySelector('tbody');
            if (!tbody || !this.table) return;
            const currentPage = this.getTableCurrentPage('departmentsTable');
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
                this.table.prev(); 
                setTimeout(() => {
                    updateRowIndices();
                    this.updatePageInfo();
                }, 100);
            } 
        });
        if (nextBtn) nextBtn.addEventListener('click', () => { 
            if (this.table) { 
                this.table.next(); 
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
        const page = Math.min(this.getTableCurrentPage('departmentsTable'), Math.max(1, Math.ceil(total / perPage)));
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
            const tableEl = document.getElementById('departmentsTable');
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
                        this.table.prev();
                    } else if (text === '›' || text === '→') {
                        this.table.next();
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

    moveProgramsPaginationOutside() {
        // Only on mobile - move simple-datatables pagination outside table-responsive for Programs table
        const checkAndMove = () => {
            const tableEl = document.getElementById('programsTable2');
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
            if (cardBody && !cardBody.hasAttribute('data-programs-pagination-bound')) {
                cardBody.setAttribute('data-programs-pagination-bound', 'true');
                cardBody.addEventListener('click', (e) => {
                    if (!e.target.closest('.datatable-pagination')) return;

                    const btn = e.target.closest('button, a');
                    if (!btn || !this.programsTable) return;

                    e.preventDefault();
                    e.stopPropagation();

                    const text = btn.textContent.trim();
                    if (text === '‹' || text === '←') {
                        this.programsTable.prev();
                    } else if (text === '›' || text === '→') {
                        this.programsTable.next();
                    } else {
                        const pageNum = parseInt(text, 10);
                        if (!isNaN(pageNum)) {
                            this.programsTable.page(pageNum);
                        }
                    }

                    setTimeout(() => {
                        this.updateProgramsPageInfo();
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

    // Modals
    openAddModal() {
        if (!rbacUtil.requireMasterfilePermission('departments', 'create', 'create departments')) {
            return;
        }
        const title = document.getElementById('departmentModalTitle');
        if (title) title.textContent = 'Add Department';
        this.fillForm({});
        this.showModal('departmentModal');
        const saveBtn = document.getElementById('saveDepartmentBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveDepartment('create');
            };
        }
    }

    openEditModal(row) {
        if (!rbacUtil.requireMasterfilePermission('departments', 'edit', 'edit departments')) {
            return;
        }
        const title = document.getElementById('departmentModalTitle');
        if (title) title.textContent = 'Edit Department';
        this.fillForm(row);
        this.showModal('departmentModal');
        const saveBtn = document.getElementById('saveDepartmentBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveDepartment('update');
            };
        }
    }

    openViewModal(row) {
        const name = row.name || row.department_name || '';
        const code = row.code || row.department_code || '';
        const students = row.students || 0;
        const status = String(row.status) === '1' ? 'Active' : 'Inactive';
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
        
        // Store current row for edit button
        this.currentViewRow = row;
        
        // Department Information
        setText('viewDeptCodeText', code);
        setText('viewDeptNameText', name);
        
        // Active Status
        const statusEl = document.getElementById('viewDeptStatus');
        if (statusEl) {
            statusEl.textContent = status;
            statusEl.className = status === 'Active' ? 'badge bg-success' : 'badge bg-secondary';
        }
        
        setText('viewDeptStudents', String(students));
        
        // Bind edit button if not already bound
        const editBtn = document.getElementById('editDepartmentFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                await this.hideModalAndWait('viewDepartmentModal');
                this.openEditModal(row);
            });
        }
        
        this.showModal('viewDepartmentModal');
    }

    fillForm(row) {
        const byId = (id) => document.getElementById(id);
        const setVal = (id, val) => { const el = byId(id); if (el) el.value = val || ''; };
        setVal('department_id', row.id || row.department_id || '');
        setVal('department_code', row.code || row.department_code || '');
        setVal('department_name', row.name || row.department_name || '');
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
        if (!rbacUtil.requireMasterfilePermission('departments', 'delete', 'delete departments')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Delete department?',
                text: (row.name || row.department_name || ''),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Delete',
                confirmButtonColor: '#d33'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-departments.php?action=delete', { id: row.id || row.department_id })
                        .then((data) => {
                            if (data && data.success === false) {
                                throw new Error(data.message || 'Delete failed.');
                            }
                            // eslint-disable-next-line no-undef
                            Swal.fire('Deleted', 'Department deleted.', 'success').then(() => window.location.reload());
                        })
                        .catch((err) => {
                            const msg = err?.response?.data?.message || err?.message || 'Failed to delete department.';
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', msg, 'error');
                        });
                }
            });
        }
    }

    toggleStatus(row) {
        if (!rbacUtil.requireMasterfilePermission('departments', 'edit', 'edit departments')) {
            return;
        }
        const isActive = String(row.status) === '1';
        const nextLabel = isActive ? 'deactivate' : 'activate';
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: `Confirm ${nextLabel}?`,
                text: (row.name || row.department_name || ''),
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: isActive ? 'Deactivate' : 'Activate'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-departments.php?action=toggle', { id: row.id || row.department_id })
                        .then((data) => {
                            if (data && data.success === false) {
                                throw new Error(data.message || 'Status update failed.');
                            }
                            // eslint-disable-next-line no-undef
                            Swal.fire('Updated', 'Status updated.', 'success').then(() => window.location.reload());
                        })
                        .catch((err) => {
                            const msg = err?.message || err?.response?.data?.message || 'Failed to update status.';
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', msg, 'error');
                        });
                }
            });
        }
    }

    saveDepartment(mode) {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('departments', 'create', 'create departments')) {
            return;
        }
        if (mode === 'update' && !rbacUtil.requireMasterfilePermission('departments', 'edit', 'edit departments')) {
            return;
        }
        const id = (document.getElementById('department_id')?.value || '').trim();
        const code = (document.getElementById('department_code')?.value || '').trim();
        const name = (document.getElementById('department_name')?.value || '').trim();
        if (!code || !name) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire('Missing fields', 'Code and Name are required.', 'warning');
            return;
        }
        const payload = { id, code, name };
        const url = mode === 'update'
            ? '/masterfiles/masterfiles-departments.php?action=update'
            : '/masterfiles/masterfiles-departments.php?action=create';
        ApiService.post(url, payload)
            .then((data) => {
                if (data && data.success === false) {
                    throw new Error(data.message || 'Operation failed.');
                }
                this.hideModal('departmentModal');
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Success', `Department ${mode === 'update' ? 'updated' : 'added'} successfully.`, 'success')
                    .then(() => window.location.reload());
            })
            .catch((err) => {
                const msg = err?.message || err?.response?.data?.message || 'Operation failed.';
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', msg, 'error');
            });
    }

    async showMasterDataImportExportDialog(mode) {
        if (!window.Swal) return;
        const config = this.getMasterDataImportConfig(mode);
        const result = await window.Swal.fire({
            title: 'Import or Export',
            text: `Choose an action for ${config.label.toLowerCase()}.`,
            icon: 'question',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: '<i class="bi bi-upload me-1"></i>Import',
            denyButtonText: '<i class="bi bi-download me-1"></i>Export',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#03600f',
            denyButtonColor: '#03600f',
            cancelButtonColor: '#6c757d',
            buttonsStyling: true,
            reverseButtons: true,
        });

        if (result.isConfirmed) {
            this.openMasterDataImport(mode);
        } else if (result.isDenied) {
            if (mode === 'programs') await this.onProgramsExportClick();
            else await this.onExportClick();
        }
    }

    getMasterDataImportConfig(mode = this.importMode) {
        if (mode === 'programs') {
            return {
                label: 'Programs',
                singular: 'program',
                endpoint: '/masterfiles/masterfiles-programs.php?action=import',
                headers: ['Code', 'Program', 'Department', 'Status'],
                sample: ['BSIT', 'Bachelor of Science in Information Technology', 'CIT', 'Active'],
                requiredAliases: [
                    ['code', 'programcode'],
                    ['program', 'programname', 'name'],
                    ['department', 'departmentcode', 'departmentname'],
                ],
                instructions: 'Use an existing department code or department name. Existing program codes will be updated and new codes will be added.',
            };
        }
        return {
            label: 'Departments',
            singular: 'department',
            endpoint: '/masterfiles/masterfiles-departments.php?action=import',
            headers: ['Code', 'Department', 'Students', 'Status'],
            sample: ['CIT', 'College of Information Technology', '0', 'Active'],
            requiredAliases: [
                ['code', 'departmentcode'],
                ['department', 'departmentname', 'name'],
            ],
            instructions: 'Existing department codes will be updated and new codes will be added. The Students column is informational and is ignored during import.',
        };
    }

    normalizeImportHeader(value) {
        return String(value ?? '')
            .replace(/^\uFEFF/, '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    parseCsv(text) {
        const rows = [];
        let row = [];
        let value = '';
        let quoted = false;
        const source = String(text ?? '');

        for (let index = 0; index < source.length; index += 1) {
            const character = source[index];
            if (character === '"') {
                if (quoted && source[index + 1] === '"') {
                    value += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else if (character === ',' && !quoted) {
                row.push(value);
                value = '';
            } else if ((character === '\n' || character === '\r') && !quoted) {
                if (character === '\r' && source[index + 1] === '\n') index += 1;
                row.push(value);
                if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
                row = [];
                value = '';
            } else {
                value += character;
            }
        }
        row.push(value);
        if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
        return rows;
    }

    bindImportModal() {
        document.getElementById('masterDataImportFile')?.addEventListener('change', (event) => this.previewMasterDataImport(event));
        document.getElementById('downloadMasterDataTemplateBtn')?.addEventListener('click', () => this.downloadMasterDataTemplate());
        document.getElementById('confirmMasterDataImportBtn')?.addEventListener('click', () => this.confirmMasterDataImport());
    }

    openMasterDataImport(mode) {
        const resource = mode === 'programs' ? 'programs' : 'departments';
        if (!rbacUtil.requireMasterfilePermission(resource, 'create', `import ${resource}`)) return;

        this.importMode = resource;
        this.importFile = null;
        const config = this.getMasterDataImportConfig(resource);
        const title = document.getElementById('masterDataImportTitle');
        const instructions = document.getElementById('masterDataImportInstructions');
        const fileInput = document.getElementById('masterDataImportFile');
        const errors = document.getElementById('masterDataImportErrors');
        const preview = document.getElementById('masterDataImportPreview');
        const confirm = document.getElementById('confirmMasterDataImportBtn');

        if (title) title.innerHTML = `<i class="bi bi-upload me-2"></i>Import ${config.label}`;
        if (instructions) instructions.textContent = config.instructions;
        if (fileInput) fileInput.value = '';
        if (errors) errors.innerHTML = '';
        preview?.classList.add('d-none');
        if (confirm) {
            confirm.disabled = true;
            confirm.textContent = `Import ${config.label}`;
        }
        const modal = document.getElementById('masterDataImportModal');
        if (modal) bootstrap.Modal.getOrCreateInstance(modal).show();
    }

    downloadMasterDataTemplate() {
        const config = this.getMasterDataImportConfig();
        const escapeCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
        const csv = [config.headers, config.sample]
            .map(row => row.map(escapeCell).join(','))
            .join('\r\n');
        this.downloadBlob(
            new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }),
            `${this.importMode}_import_template.csv`
        );
    }

    async previewMasterDataImport(event) {
        const file = event.target.files?.[0];
        const errors = document.getElementById('masterDataImportErrors');
        const preview = document.getElementById('masterDataImportPreview');
        const confirm = document.getElementById('confirmMasterDataImportBtn');
        if (errors) errors.innerHTML = '';
        preview?.classList.add('d-none');
        if (confirm) confirm.disabled = true;
        this.importFile = null;
        if (!file) return;

        try {
            if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Only CSV files can be imported.');
            if (file.size > 5 * 1024 * 1024) throw new Error('The CSV file must not exceed 5MB.');
            const rows = this.parseCsv(await file.text());
            if (rows.length < 2) throw new Error('The CSV file must contain a header and at least one data row.');

            const config = this.getMasterDataImportConfig();
            const normalizedHeaders = rows[0].map(header => this.normalizeImportHeader(header));
            const hasRequiredHeaders = config.requiredAliases.every(aliases =>
                aliases.some(alias => normalizedHeaders.includes(alias))
            );
            if (!hasRequiredHeaders) {
                throw new Error(`Invalid template. Required columns: ${config.headers.filter(header => header !== 'Students' && header !== 'Status').join(', ')}.`);
            }

            const previewRows = rows.slice(1, 11);
            const head = document.getElementById('masterDataImportPreviewHead');
            const body = document.getElementById('masterDataImportPreviewBody');
            const count = document.getElementById('masterDataImportCount');
            if (head) head.innerHTML = `<tr>${rows[0].map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;
            if (body) {
                body.innerHTML = previewRows.map(row =>
                    `<tr>${rows[0].map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`
                ).join('');
            }
            const totalRows = rows.length - 1;
            if (count) count.textContent = `${totalRows} row${totalRows === 1 ? '' : 's'}`;
            preview?.classList.remove('d-none');
            this.importFile = file;
            if (confirm) confirm.disabled = false;
        } catch (error) {
            if (errors) errors.innerHTML = `<div class="alert alert-danger mb-0"><i class="bi bi-exclamation-triangle me-2"></i>${escapeHtml(error.message || 'Unable to read this CSV file.')}</div>`;
        }
    }

    async confirmMasterDataImport() {
        if (!this.importFile || !window.Swal) return;
        const config = this.getMasterDataImportConfig();
        const confirmation = await window.Swal.fire({
            title: `Import ${config.label}?`,
            text: `New ${config.label.toLowerCase()} will be added and matching codes will be updated.`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Import',
            cancelButtonText: 'Cancel',
            buttonsStyling: false,
            customClass: { confirmButton: 'btn btn-success px-4', cancelButton: 'btn btn-secondary px-4', actions: 'd-flex gap-2' },
        });
        if (!confirmation.isConfirmed) return;

        const button = document.getElementById('confirmMasterDataImportBtn');
        if (button) button.disabled = true;
        const startedAt = Date.now();
        let elapsedTimer = null;
        try {
            window.Swal.fire({
                title: `Importing ${config.label}...`,
                html: `
                    <div>Validating and saving ${escapeHtml(config.label.toLowerCase())}.</div>
                    <div class="progress mt-3" style="height: 20px;" role="progressbar" aria-label="Estimated ${escapeHtml(config.label)} import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="1">
                        <div id="departmentImportProgress" class="progress-bar progress-bar-striped progress-bar-animated bg-success" style="width: 1%; min-width: 2.5rem;">1%</div>
                    </div>
                    <div class="small text-muted mt-1">Estimated progress while the server processes the file</div>
                    <div id="departmentImportElapsed" class="small text-muted mt-2">Elapsed time: 0 seconds</div>
                `,
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    window.Swal.showLoading();
                    elapsedTimer = window.setInterval(() => {
                        const elapsedMs = Date.now() - startedAt;
                        const elapsed = Math.floor(elapsedMs / 1000);
                        const label = document.getElementById('departmentImportElapsed');
                        if (label) label.textContent = `Elapsed time: ${elapsed} second${elapsed === 1 ? '' : 's'}`;
                        const percent = Math.min(99, 1 + Math.floor(98 * (1 - Math.exp(-elapsedMs / 20000))));
                        const bar = document.getElementById('departmentImportProgress');
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
            const response = await ApiService.postFormData(config.endpoint, formData);
            if (!response?.success) throw new Error(response?.message || `Unable to import ${config.label.toLowerCase()}.`);

            if (elapsedTimer !== null) {
                window.clearInterval(elapsedTimer);
                elapsedTimer = null;
            }
            const bar = document.getElementById('departmentImportProgress');
            if (bar) {
                bar.style.width = '100%';
                bar.textContent = '100%';
                bar.parentElement.setAttribute('aria-valuenow', '100');
            }
            await new Promise(resolve => window.setTimeout(resolve, 300));

            const errorLines = Array.isArray(response.errors) ? response.errors : [];
            const summary = `<div class="text-start">
                <div><strong>${Number(response.created || 0)}</strong> added</div>
                <div><strong>${Number(response.updated || 0)}</strong> updated</div>
                <div><strong>${Number(response.skipped || 0)}</strong> skipped</div>
                ${errorLines.length ? `<hr><small>${errorLines.slice(0, 8).map(line => escapeHtml(line)).join('<br>')}${errorLines.length > 8 ? `<br>...and ${errorLines.length - 8} more` : ''}</small>` : ''}
            </div>`;
            bootstrap.Modal.getInstance(document.getElementById('masterDataImportModal'))?.hide();
            await window.Swal.fire({ icon: 'success', title: `${config.label} Imported`, html: summary, confirmButtonText: 'OK' });
            if (this.importMode === 'programs') window.location.hash = 'programs';
            window.location.reload();
        } catch (error) {
            await window.Swal.fire({
                icon: 'error',
                title: `Import ${config.label} Failed`,
                text: error?.response?.data?.message || error.message || 'Please try again.',
                confirmButtonText: 'OK',
            });
            if (button) button.disabled = false;
        } finally {
            if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
        }
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
            title: 'Export Departments',
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
            Code: r.code || r.department_code || '',
            Department: r.name || r.department_name || '',
            Students: String(r.students ?? 0),
            Status: String(r.status) === '1' ? 'Active' : 'Inactive'
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no departments to export.', confirmButtonColor: '#007319' });
            return;
        }

        const choice = result.value;
        if (choice === 'csv') {
            const headers = Object.keys(rows[0] || { Code: '', Department: '', Students: '', Status: '' });
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'departments.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(rows[0] || { Code: '', Department: '', Students: '', Status: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'departments.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(rows[0] || { Code: '', Department: '', Students: '', Status: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'departments.doc');
            return;
        }

        if (choice === 'pdf') {
            this.exportDepartmentsPDF(rows);
        }
    }
    
    exportDepartmentsPDF(rows) {
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

        const headers = ['Code', 'Department Name', 'Students', 'Status'];
        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = rows.map((r, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            const rowData = [r.Code, r.Department, String(r.Students), r.Status];
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Departments Report</title>
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
                            <h2>Departments Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> Departments</div>
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

    async onProgramsExportClick() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;

        const result = await swal.fire({
            title: 'Export Programs',
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

        const rows = (this.cachedPrograms || []).map(r => ({
            Code: r.code || r.program_code || '',
            Program: r.name || r.program_name || '',
            Department: r.department_name || '',
            Status: String(r.status) === '1' ? 'Active' : 'Inactive'
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no programs to export.', confirmButtonColor: '#007319' });
            return;
        }

        const choice = result.value;
        if (choice === 'csv') {
            const headers = Object.keys(rows[0] || { Code: '', Program: '', Department: '', Status: '' });
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'programs.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(rows[0] || { Code: '', Program: '', Department: '', Status: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'programs.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(rows[0] || { Code: '', Program: '', Department: '', Status: '' });
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'programs.doc');
            return;
        }

        if (choice === 'pdf') {
            this.exportProgramsPDF(rows);
        }
    }
    
    exportProgramsPDF(rows) {
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

        const headers = ['Code', 'Program Name', 'Department', 'Status'];
        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = rows.map((r, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            const rowData = [r.Code, r.Program, r.Department, r.Status];
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Programs Report</title>
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
                            <h2>Programs Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> Programs</div>
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
        const programsMobileFilterBtn = document.getElementById('programsMobileFilterBtn');
        
        if (navbarToggler) {
            navbarToggler.addEventListener('click', () => {
                // Close departments filter
                if (mobileFilterBtn) {
                    const dropdown = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                    if (dropdown) {
                        dropdown.hide();
                    }
                }
                // Close programs filter
                if (programsMobileFilterBtn) {
                    const dropdown = bootstrap.Dropdown.getInstance(programsMobileFilterBtn);
                    if (dropdown) {
                        dropdown.hide();
                    }
                }
            });
        }
    }
}

export default MasterfilesDepartmentsModule;
