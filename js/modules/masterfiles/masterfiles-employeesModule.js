import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import { INLINE_ACTION_IGNORE, masterfileEmployeeActions } from '../../shared/shared-inline-actions.js';

const bulkSelectionHeading = '<input type="checkbox" class="form-check-input" data-bulk-all aria-label="Select all records on this page" hidden>';

function bulkSelectionCell(id) {
    return `<span data-record-id="${escapeHtml(String(id))}"><input type="checkbox" class="form-check-input" data-bulk-id="${escapeHtml(String(id))}" aria-label="Select record ${escapeHtml(String(id))}" hidden></span>`;
}

class MasterfilesEmployeesModule {
    async bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        const tableId = 'employeesTable';
        const refreshId = 'refreshBtn';
        const resource = 'employees';
        const endpoint = '/masterfiles/masterfiles-employees.php';
        const idField = 'employee_id';
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

    renderEmployeeActions(row) {
        const actions = masterfileEmployeeActions(row.status);
        if (!rbacUtil.canEditMasterfile('employees')) return actions;
        const reset = '<button type="button" class="inline-action-btn inline-action-btn--edit action-reset-password" title="Reset Password" aria-label="Reset Password"><i class="bi bi-key"></i></button>';
        return actions.replace('</div>', reset + '</div>');
    }

    async resetPassword(row) {
        if (this._passwordResetPending || !rbacUtil.requireMasterfilePermission('employees', 'edit', 'reset employee passwords')) return;
        this._passwordResetPending = true;
        const name = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ') || row.school_id;
        try {
            const result = await Swal.fire({
                title: 'Reset password?',
                text: 'Reset ' + name + ' (' + row.school_id + ') to their school ID password? Their current session will end, and they must change the password at their next sign-in.',
                icon: 'warning', showCancelButton: true,
                confirmButtonText: 'Reset Password', cancelButtonText: 'Cancel',
                confirmButtonColor: '#dc3545', reverseButtons: false,
                showLoaderOnConfirm: true,
                allowOutsideClick: () => !Swal.isLoading(),
                preConfirm: async () => {
                    try {
                        const response = await ApiService.post('/masterfiles/masterfiles-employees.php?action=reset_password', { employee_id: row.id || row.employee_id });
                        if (!response?.success) throw new Error(response?.message || 'Unable to reset the password.');
                        return response;
                    } catch (error) {
                        Swal.showValidationMessage(error.response?.data?.message || error.message || 'Unable to reset the password.');
                        return false;
                    }
                },
            });
            if (result.isConfirmed) await Swal.fire('Password reset', result.value.message, 'success');
        } finally {
            this._passwordResetPending = false;
        }
    }

    constructor() {
        this.table = null;
        this.cachedRows = null;
        this.roles = [];
        this.campuses = [];
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
        
        // Initialize RBAC first
        await rbacUtil.init();
        
        await this.loadRoles();
        await this.loadCampuses();
        await this.loadCounts();
        await this.buildTable();
        this.bindToolbar();
        this.bindStatCards();
        
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
        this.bindPasswordTracking();
        this.bindInputValidations();
        
        // Apply RBAC permissions AFTER table is built
        rbacUtil.applyActionPermissions('csdl');
    }

    async loadRoles() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-employees.php', { action: 'get_roles' });
            this.roles = data?.roles || [];
            const sel = document.getElementById('role_id');
            const filterSel = document.getElementById('filterRole');
            const filterSelMobile = document.getElementById('filterRoleMobile');
            if (sel) {
                const frag = document.createDocumentFragment();
                this.roles.forEach(r => {
                    const opt = document.createElement('option');
                    opt.value = r.role_id;
                    opt.textContent = r.role_name;
                    frag.appendChild(opt);
                });
                sel.appendChild(frag);
            }
            if (filterSel) {
                const frag = document.createDocumentFragment();
                this.roles.forEach(r => {
                    const opt = document.createElement('option');
                    opt.value = r.role_id;
                    opt.textContent = r.role_name;
                    frag.appendChild(opt);
                });
                filterSel.appendChild(frag);
            }
            // Populate mobile filter
            if (filterSelMobile) {
                const frag = document.createDocumentFragment();
                this.roles.forEach(r => {
                    const opt = document.createElement('option');
                    opt.value = r.role_id;
                    opt.textContent = r.role_name;
                    frag.appendChild(opt);
                });
                filterSelMobile.appendChild(frag);
            }
        } catch (_) {
            this.roles = [];
        }
    }

    async loadCampuses() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-employees.php', { action: 'get_campuses' });
            this.campuses = data?.campuses || [];
            const sel = document.getElementById('campus_id');
            const filterSel = document.getElementById('filterCampus');
            const filterSelMobile = document.getElementById('filterCampusMobile');
            if (sel) {
                const frag = document.createDocumentFragment();
                this.campuses.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.campus_id;
                    opt.textContent = c.campus_name;
                    frag.appendChild(opt);
                });
                sel.appendChild(frag);
            }
            if (filterSel) {
                const frag = document.createDocumentFragment();
                this.campuses.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.campus_id;
                    opt.textContent = c.campus_name;
                    frag.appendChild(opt);
                });
                filterSel.appendChild(frag);
            }
            // Populate mobile filter
            if (filterSelMobile) {
                const frag = document.createDocumentFragment();
                this.campuses.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.campus_id;
                    opt.textContent = c.campus_name;
                    frag.appendChild(opt);
                });
                filterSelMobile.appendChild(frag);
            }
        } catch (_) {
            this.campuses = [];
        }
    }

    bindPasswordTracking() {
        const schoolIdInput = document.getElementById('school_id');
        const passwordInput = document.getElementById('password');
        const toggleBtn = document.getElementById('togglePasswordBtn');
        const toggleIcon = document.getElementById('togglePasswordIcon');
        let isPasswordVisible = false;

        if (schoolIdInput && passwordInput) {
            schoolIdInput.addEventListener('input', () => {
                passwordInput.value = schoolIdInput.value.trim();
            });
        }

        if (toggleBtn && passwordInput && toggleIcon) {
            toggleBtn.addEventListener('click', () => {
                isPasswordVisible = !isPasswordVisible;
                passwordInput.type = isPasswordVisible ? 'text' : 'password';
                toggleIcon.classList.toggle('bi-eye', isPasswordVisible);
                toggleIcon.classList.toggle('bi-eye-slash', !isPasswordVisible);
            });
        }
    }

    bindInputValidations() {
        // Name fields - only letters, spaces, hyphens, and apostrophes
        const nameFields = ['first_name', 'middle_name', 'last_name'];
        nameFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.addEventListener('input', (e) => {
                    // Remove any numbers or special characters except spaces, hyphens, and apostrophes
                    e.target.value = e.target.value.replace(/[^a-zA-Z\s\-']/g, '');
                });
                field.addEventListener('keypress', (e) => {
                    // Prevent numbers and special characters on keypress
                    const char = String.fromCharCode(e.which);
                    if (!/[a-zA-Z\s\-']/.test(char)) {
                        e.preventDefault();
                    }
                });
            }
        });

        // Contact number - exactly 11 digits, Philippine format (starts with 09)
        const contactField = document.getElementById('contact_number');
        if (contactField) {
            contactField.addEventListener('input', (e) => {
                // Remove any non-numeric characters
                let value = e.target.value.replace(/\D/g, '');
                
                // Limit to 11 digits
                if (value.length > 11) {
                    value = value.substring(0, 11);
                }
                
                // If starts with 0, ensure it's followed by 9
                if (value.length > 1 && value[0] === '0' && value[1] !== '9') {
                    value = '09' + value.substring(2).replace(/[^0-9]/g, '');
                }
                
                // If doesn't start with 0, prepend 0 if it starts with 9
                if (value.length > 0 && value[0] === '9' && value.length <= 10) {
                    value = '0' + value;
                }
                
                e.target.value = value;
            });
            
            contactField.addEventListener('keypress', (e) => {
                // Only allow numbers
                const char = String.fromCharCode(e.which);
                if (!/[0-9]/.test(char)) {
                    e.preventDefault();
                }
            });

            // Add validation on blur
            contactField.addEventListener('blur', () => {
                this.validateContactNumber(contactField);
            });
        }
    }

    validateContactNumber(inputElement) {
        if (!inputElement) return false;
        const contact = inputElement.value.trim();
        inputElement.classList.remove('border-success', 'border-danger', 'is-valid', 'is-invalid');
        
        if (contact === '') {
            return false;
        }
        const phonePattern = /^09\d{9}$/;
        if (phonePattern.test(contact)) {
            return true;
        } else {
            inputElement.classList.add('border-danger', 'is-invalid');
            return false;
        }
    }

    async fetchEmployees() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-employees.php', { action: 'list' });
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
        const modalEl = document.getElementById('employeesListModal');
        const show = () => {
            if (!modalEl) return;
            // eslint-disable-next-line no-undef
            const m = bootstrap.Modal.getOrCreateInstance(modalEl);
            m.show();
        };
        const setTitle = (t) => { const el = document.getElementById('employeesModalTitle'); if (el) el.textContent = t; };
        const tbody = document.getElementById('employeesModalTableBody');
        const thead = document.querySelector('#employeesListModal thead');

        const renderEmployees = (rows) => {
            if (!tbody) return;
            tbody.innerHTML = (rows || []).map(r => {
                const name = `${r.first_name || ''} ${r.middle_name || ''} ${r.last_name || ''}`.trim();
                const status = String(r.status) === '1' ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>';
                return `<tr>
                    <td class="text-center">${escapeHtml(r.school_id || '')}</td>
                    <td class="text-center">${escapeHtml(name)}</td>
                    <td class="text-center">${escapeHtml(r.role_name || '')}</td>
                    <td class="text-center">${status}</td>
                </tr>`;
            }).join('');
        };

        const cards = document.querySelectorAll('[data-view]');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                if (thead) thead.innerHTML = '<tr><th class="text-center">Employee ID</th><th class="text-center">Name</th><th class="text-center">Department</th><th class="text-center">Status</th></tr>';
                if (view === 'allEmployees') {
                    setTitle('All Employees');
                    renderEmployees(rows);
                } else if (view === 'activeEmployees') {
                    setTitle('Active Employees');
                    renderEmployees(rows.filter(r => String(r.status) === '1'));
                } else if (view === 'inactiveEmployees') {
                    setTitle('Inactive Employees');
                    renderEmployees(rows.filter(r => String(r.status) === '0'));
                } else {
                    setTitle('Employees');
                    renderEmployees(rows);
                }
                show();
            });
        });
    }

    async loadCounts() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-employees.php', { action: 'list' });
            if (res && Array.isArray(res.rows)) {
                this.cachedRows = res.rows;
                this.hydrateCounts(res);
            }
        } catch (_) {
            // graceful fallback
        }
    }

    hydrateCounts(src) {
        const { totalEmployees, activeEmployees, inactiveEmployees } = src || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el && (val || val === 0)) el.textContent = String(val);
        };
        set('statTotalEmployees', totalEmployees ?? 0);
        set('statActiveEmployees', activeEmployees ?? 0);
        set('statInactiveEmployees', inactiveEmployees ?? 0);
        
    }

    bindToolbar() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
        const addBtn = document.getElementById('addEmployeeBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.openAddModal());
        const importExportBtn = document.getElementById('importExportBtn');
        if (importExportBtn) importExportBtn.addEventListener('click', () => this.showImportExportDialog());
        const downloadTemplateBtn = document.getElementById('downloadTemplateBtn');
        if (downloadTemplateBtn) downloadTemplateBtn.addEventListener('click', () => this.downloadTemplate());
        const importFileInput = document.getElementById('importFileInput');
        if (importFileInput) importFileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        const confirmImportBtn = document.getElementById('confirmImportBtn');
        if (confirmImportBtn) confirmImportBtn.addEventListener('click', () => this.confirmImport());
        
        // Mobile filter apply button
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const roleMobile = document.getElementById('filterRoleMobile');
                const campusMobile = document.getElementById('filterCampusMobile');
                
                // Sync mobile filters to desktop filters
                const roleDesktop = document.getElementById('filterRole');
                const campusDesktop = document.getElementById('filterCampus');
                
                if (roleMobile && roleDesktop) {
                    roleDesktop.value = roleMobile.value;
                }
                if (campusMobile && campusDesktop) {
                    campusDesktop.value = campusMobile.value;
                }
                
                // Trigger filter change
                if (roleDesktop) roleDesktop.dispatchEvent(new Event('change'));
                if (campusDesktop) campusDesktop.dispatchEvent(new Event('change'));
                
                // Close mobile dropdown
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }
        
        // Sync mobile search with desktop search
        const searchMobile = document.getElementById('searchEmployeesMobile');
        const searchDesktop = document.getElementById('searchEmployees');
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

    async showImportExportDialog() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;

        const result = await swal.fire({
            title: 'Import or Export',
            text: 'Choose an action to continue',
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
            reverseButtons: true
        });

        if (result.isConfirmed) {
            // User clicked Import
            this.openImportModal();
        } else if (result.isDenied) {
            // User clicked Export
            this.onExportClick();
        }
        // If cancelled, do nothing
    }

    async buildTable() {
        const el = document.getElementById('employeesTable');
        if (!el) return;

        const rows = this.cachedRows || await this.fetchEmployees();

        const dataset = rows.map(r => this.employeeTableRow(r));

        // eslint-disable-next-line no-undef
        this.table = new simpleDatatables.DataTable(el, {
            data: {
                headings: [bulkSelectionHeading, 'Employee ID', 'Name', 'Department', 'Campus', 'Access Granted', 'Status', 'Actions'],
                data: dataset
            },
            columns: [{ select: 0, sortable: false }],
            searchable: false,
            fixedHeight: false,
            perPage: parseInt(document.getElementById('perPageSelectCustom')?.value || '10', 10),
            perPageSelect: false,
            info: false
        });

        this.bindFilters();
        this.bindPaginationFooter();
        this.updatePageInfo();
        this.movePaginationOutside();

        const getRowData = (tr) => {
            const employeeId = tr?.querySelector('[data-employee-id]')?.dataset.employeeId;
            if (!employeeId || !this.cachedRows) return null;
            return this.cachedRows.find(row => String(row.id || row.employee_id || '') === employeeId) || null;
        };

        const tbody = el.querySelector('tbody');
        if (tbody) {
            el.addEventListener('click', (ev) => {
                const raw = ev.target;
                const target = raw instanceof Element ? raw : raw.parentElement;
                if (!target) return;
                if (target.closest(`${INLINE_ACTION_IGNORE}, .action-edit, .action-delete, .action-toggle, .action-permissions`)) return;
                const tr = target.closest('tbody tr');
                if (!tr) return;
                const row = getRowData(tr);
                if (!row) return;
                this.openViewModal(row);
            });

            el.addEventListener('click', (ev) => {
                const raw = ev.target;
                const target = raw instanceof Element ? raw : raw.parentElement;
                if (!target) return;
                const tr = target.closest('tbody tr');
                if (!tr) return;
                const row = getRowData(tr);
                if (!row) return;
                if (target.closest('.action-edit')) {
                    ev.preventDefault();
                    this.openEditModal(row);
                } else if (target.closest('.action-permissions')) {
                    ev.preventDefault();
                    this.openManagePermissionsModal(row);
                } else if (target.closest('.action-reset-password')) {
                    ev.preventDefault();
                    this.resetPassword(row);
                } else if (target.closest('.action-toggle')) {
                    ev.preventDefault();
                    this.toggleStatus(row);
                } else if (target.closest('.action-delete')) {
                    ev.preventDefault();
                    this.confirmDelete(row);
                }
            });
        }
    }

    employeeTableRow(row) {
        const toCenter = (value) => `<span class="d-block text-center">${value ?? ''}</span>`;
        const name = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ');
        const status = String(row.status) === '1'
            ? '<span class="badge bg-success">Active</span>'
            : '<span class="badge bg-secondary">Inactive</span>';
        return [
            bulkSelectionCell(row.id || row.employee_id),
            `<span class="d-block text-center" data-employee-id="${escapeHtml(String(row.id || row.employee_id || ''))}">${escapeHtml(row.school_id || '')}</span>`,
            toCenter(escapeHtml(name)),
            toCenter(escapeHtml(row.role_name || '')),
            toCenter(escapeHtml(row.campus_name || '-')),
            toCenter(String(row.access_granted || 'Limited Access') === 'All Access'
                ? '<span class="badge bg-success">All Access</span>'
                : '<span class="badge bg-warning text-dark">Limited Access</span>'),
            toCenter(status),
            this.renderEmployeeActions(row),
        ];
    }

    bindFilters() {
        const roleSel = document.getElementById('filterRole');
        const campusSel = document.getElementById('filterCampus');
        const searchEl = document.getElementById('searchEmployees');
        const apply = () => {
            if (!this.table) return;
            const role = roleSel?.value || '';
            const campus = campusSel?.value || '';
            const terms = (searchEl?.value || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
            const filteredRows = (this.cachedRows || []).filter(row => {
                if (role && String(row.role_id) !== role) return false;
                if (campus && String(row.campus_id) !== campus) return false;
                if (!terms.length) return true;
                const searchable = [row.school_id, row.first_name, row.middle_name, row.last_name,
                    row.role_name, row.campus_name, row.email].filter(Boolean).join(' ').toLocaleLowerCase();
                return terms.every(term => searchable.includes(term));
            });
            const rowCount = this.table.data?.data?.length || 0;
            if (rowCount) this.table.rows.remove(Array.from({ length: rowCount }, (_, index) => index));
            if (filteredRows.length) this.table.insert({ data: filteredRows.map(row => this.employeeTableRow(row)) });
            this.table.page(1);
            this.updatePageInfo();
        };
        if (roleSel) roleSel.addEventListener('change', apply);
        if (campusSel) campusSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', apply);
    }

    bindPaginationFooter() {
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');
        const perPageSel = document.getElementById('perPageSelectCustom');
        if (prevBtn) prevBtn.addEventListener('click', () => {
            if (this.table) {
                this.table.page(Math.max(1, this.getTableCurrentPage('employeesTable') - 1));
                setTimeout(() => {
                    this.updatePageInfo();
                }, 100);
            }
        });
        if (nextBtn) nextBtn.addEventListener('click', () => {
            if (this.table) {
                this.table.page(this.getTableCurrentPage('employeesTable') + 1);
                setTimeout(() => {
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
        const page = Math.min(this.getTableCurrentPage('employeesTable'), Math.max(1, Math.ceil(total / perPage)));
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
            const tableEl = document.getElementById('employeesTable');
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
                        this.table.page(Math.max(1, this.getTableCurrentPage('employeesTable') - 1));
                    } else if (text === '›' || text === '→') {
                        this.table.page(this.getTableCurrentPage('employeesTable') + 1);
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
        if (!rbacUtil.requireMasterfilePermission('employees', 'create', 'create employees')) {
            return;
        }
        const title = document.getElementById('employeeModalTitle');
        if (title) title.textContent = 'Add Employee';
        this.fillForm({});
        
        // Enable all fields for add mode
        this.setFieldsEditable(true);
        
        // Reset password field to hidden
        const passwordInput = document.getElementById('password');
        const toggleIcon = document.getElementById('togglePasswordIcon');
        const passwordContainer = document.getElementById('employeePasswordField');
        if (passwordInput) {
            passwordInput.type = 'password';
            passwordInput.value = '';
        }
        if (toggleIcon) {
            toggleIcon.classList.remove('bi-eye');
            toggleIcon.classList.add('bi-eye-slash');
        }
        if (passwordContainer) {
            passwordContainer.style.display = 'block';
        }
        
        this.showModal('employeeModal');
        const saveBtn = document.getElementById('saveEmployeeBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveEmployee('create');
            };
        }
    }

    openEditModal(row) {
        if (!rbacUtil.requireMasterfilePermission('employees', 'edit', 'edit employees')) {
            return;
        }
        const title = document.getElementById('employeeModalTitle');
        if (title) title.textContent = 'Edit Employee';
        this.fillForm(row);
        
        // Disable fields that shouldn't be edited
        this.setFieldsEditable(false);
        
        // Hide password field in edit mode
        const passwordInput = document.getElementById('password');
        const passwordContainer = document.getElementById('employeePasswordField');
        if (passwordContainer) {
            passwordContainer.style.display = 'none';
        }
        
        this.showModal('employeeModal');
        const saveBtn = document.getElementById('saveEmployeeBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveEmployee('update');
            };
        }
    }

    setFieldsEditable(editable) {
        // Keep the employee's login ID fixed when editing an existing record.
        const fieldsToDisable = ['school_id'];
        
        fieldsToDisable.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                if (editable) {
                    field.removeAttribute('readonly');
                    field.removeAttribute('disabled');
                    field.style.backgroundColor = '';
                    field.style.cursor = '';
                    field.style.pointerEvents = '';
                } else {
                    // For select elements, use disabled + pointer-events
                    if (field.tagName === 'SELECT') {
                        field.setAttribute('disabled', 'disabled');
                        field.style.pointerEvents = 'none';
                    } else {
                        // For input elements, use readonly
                        field.setAttribute('readonly', 'readonly');
                    }
                    field.style.backgroundColor = '#e9ecef';
                    field.style.cursor = 'not-allowed';
                }
            }
        });
        
        // Profile, role, and contact details can be corrected in edit mode.
        const editableFields = ['first_name', 'middle_name', 'last_name', 'role_id', 'date_of_birth', 'gender', 'contact_number', 'email', 'campus_id'];
        editableFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.removeAttribute('disabled');
                field.removeAttribute('readonly');
                field.style.backgroundColor = '';
                field.style.cursor = '';
                field.style.pointerEvents = '';
            }
        });
    }

    openViewModal(row) {
        const name = `${row.first_name || ''} ${row.middle_name || ''} ${row.last_name || ''}`.trim();
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
        
        // Store current row for edit button
        this.currentViewRow = row;
        
        // Employee Information
        setText('viewEmployeeSchoolId', row.school_id);
        setText('viewEmployeeNameText', name);
        setText('viewEmployeeRoleText', row.role_name);
        
        // Active Status
        const statusEl = document.getElementById('viewEmployeeStatus');
        if (statusEl) {
            statusEl.textContent = String(row.status) === '1' ? 'Active' : 'Inactive';
            statusEl.className = String(row.status) === '1' ? 'badge bg-success' : 'badge bg-secondary';
        }
        
        // Work Information
        setText('viewEmployeeCampus', row.campus_name);
        
        // Personal Information
        setText('viewEmployeeFirstName', row.first_name);
        setText('viewEmployeeMiddleName', row.middle_name);
        setText('viewEmployeeLastName', row.last_name);
        setText('viewEmployeeGender', row.gender);
        
        // Format date of birth
        const dateOfBirth = row.date_of_birth || '';
        const formattedDate = dateOfBirth ? new Date(dateOfBirth).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '-';
        setText('viewEmployeeDateOfBirth', formattedDate);
        
        setText('viewEmployeeContact', row.contact_number);
        setText('viewEmployeeEmail', row.email);
        
        // Bind edit button if not already bound
        const editBtn = document.getElementById('editEmployeeFromViewBtn');
        if (editBtn && !editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                if (!this.currentViewRow) return;
                await this.hideModalAndWait('viewEmployeeModal');
                this.openEditModal(this.currentViewRow);
            });
        }
        
        this.showModal('viewEmployeeModal');
    }

    fillForm(row) {
        const byId = (id) => document.getElementById(id);
        const setVal = (id, val) => { const el = byId(id); if (el) el.value = val || ''; };
        setVal('employee_id', row.id || row.employee_id || '');
        setVal('school_id', row.school_id || '');
        setVal('role_id', row.role_id || '');
        setVal('first_name', row.first_name || '');
        setVal('middle_name', row.middle_name || '');
        setVal('last_name', row.last_name || '');
        setVal('date_of_birth', row.date_of_birth || '');
        setVal('gender', row.gender || '');
        setVal('contact_number', row.contact_number || '');
        setVal('email', row.email || '');
        setVal('campus_id', row.campus_id || '');
        const passwordInput = byId('password');
        if (passwordInput && !row.id) {
            passwordInput.value = row.school_id || '';
            passwordInput.placeholder = 'Will auto-fill with Employee ID';
        }
    }

    saveEmployee(mode) {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('employees', 'create', 'create employees')) {
            return;
        }
        if (mode === 'update' && !rbacUtil.requireMasterfilePermission('employees', 'edit', 'edit employees')) {
            return;
        }
        const form = document.getElementById('employeeForm');
        if (!form || !form.checkValidity()) {
            form?.reportValidity();
            return;
        }

        const byId = (id) => document.getElementById(id);
        // Get value even if field is disabled
        const getVal = (id) => {
            const el = byId(id);
            return el ? (el.value || '').trim() : '';
        };
        
        // Validate contact number if provided
        const contactNumber = getVal('contact_number');
        if (contactNumber && !this.validateContactNumber(byId('contact_number'))) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire({
                icon: 'error',
                title: 'Invalid Contact Number',
                text: 'Contact number must be exactly 11 digits and start with 09 (e.g., 09123456789)',
                confirmButtonColor: '#0a8f1b'
            });
            return;
        }

        const data = {
            school_id: getVal('school_id'),
            role_id: getVal('role_id'),
            first_name: getVal('first_name'),
            middle_name: getVal('middle_name'),
            last_name: getVal('last_name'),
            date_of_birth: getVal('date_of_birth') || null,
            gender: getVal('gender') || null,
            contact_number: contactNumber || null,
            email: getVal('email') || null,
            campus_id: getVal('campus_id') || null
        };

        if (mode === 'update') {
            data.employee_id = getVal('employee_id');
            // Password field is hidden in edit mode, so don't include it
        }

        const url = mode === 'update'
            ? '/masterfiles/masterfiles-employees.php?action=update'
            : '/masterfiles/masterfiles-employees.php?action=create';

        ApiService.post(url, data)
            .then((response) => {
                if (response?.success !== true) {
                    throw new Error(response?.message || 'Could not save employee.');
                }
                this.hideModal('employeeModal');
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Success', `Employee ${mode === 'update' ? 'updated' : 'added'} successfully.`, 'success')
                    .then(() => window.location.reload());
            })
            .catch((err) => {
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', err?.response?.data?.message || err?.message || 'Operation failed.', 'error');
            });
    }

    toggleStatus(row) {
        if (!rbacUtil.requireMasterfilePermission('employees', 'edit', 'edit employees')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Confirm Status Change',
                text: `Are you sure you want to ${String(row.status) === '1' ? 'deactivate' : 'activate'} this employee?`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#0a8f1b'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-employees.php?action=toggle', { employee_id: row.id || row.employee_id })
                        .then((response) => {
                            if (response?.success !== true) {
                                throw new Error(response?.message || 'Failed to update employee status.');
                            }
                            // eslint-disable-next-line no-undef
                            Swal.fire('Success', 'Employee status updated successfully.', 'success').then(() => window.location.reload());
                        })
                        .catch((err) => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', err?.response?.data?.message || err?.message || 'Failed to update employee status.', 'error');
                        });
                }
            });
        }
    }

    confirmDelete(row) {
        if (!rbacUtil.requireMasterfilePermission('employees', 'delete', 'delete employees')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Confirm Delete',
                text: `Are you sure you want to delete "${name || row.school_id || 'this employee'}"? This action cannot be undone.`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes, delete',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#dc3545'
            }).then((res) => {
                if (res.isConfirmed) {
                    const eid = row.id || row.employee_id;
                    if (eid == null || eid === '') {
                        // eslint-disable-next-line no-undef
                        Swal.fire('Error', 'Missing employee id for this row. Try refreshing the page.', 'error');
                        return;
                    }
                    ApiService.post('/masterfiles/masterfiles-employees.php?action=delete', { employee_id: eid })
                        .then((data) => {
                            if (data?.success !== true) {
                                // eslint-disable-next-line no-undef
                                Swal.fire('Cannot delete', data.message || 'Delete was not completed.', 'error');
                                return;
                            }
                            // eslint-disable-next-line no-undef
                            Swal.fire('Deleted', 'Employee deleted.', 'success').then(() => window.location.reload());
                        })
                        .catch((err) => {
                            const msg = err.response?.data?.message || 'Failed to delete employee.';
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', msg, 'error');
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
            title: 'Export Employees',
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
            'Employee ID': r.school_id || '',
            'Name': `${r.first_name || ''} ${r.middle_name || ''} ${r.last_name || ''}`.trim(),
            'Department': r.role_name || '',
            'Access Granted': r.access_granted || 'Limited Access',
            'Email': r.email || '',
            'Campus': r.campus_name || '',
            'Contact': r.contact_number || '',
            'Status': String(r.status) === '1' ? 'Active' : 'Inactive'
        }));
        if (!rows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no employees to export.', confirmButtonColor: '#007319' });
            return;
        }

        const choice = result.value;
        if (choice === 'csv') {
            const headers = Object.keys(rows[0] || {});
            const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
            const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'employees.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = Object.keys(rows[0] || {});
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'employees.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = Object.keys(rows[0] || {});
            const th = headers.map(h => `<th>${h}</th>`).join('');
            const trs = rows.map(r => `<tr>${headers.map(h => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'employees.doc');
            return;
        }

        if (choice === 'pdf') {
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

            const headers = ['Employee ID', 'Name', 'Department', 'Access Granted', 'Email', 'Campus', 'Contact', 'Status'];
            const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
            
            const trs = rows.map((r, idx) => {
                const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                const rowData = [r['Employee ID'], r.Name, r.Department, r['Access Granted'], r.Email, r.Campus, r.Contact, r.Status];
                return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
            }).join('');

            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Employees Report</title>
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
                                <h2>Employees Masterfile Report</h2>
                            </div>
                            <div class="report-info">
                                <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                <div><strong>Module:</strong> Employees</div>
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

    openImportModal() {
        this.showModal('importEmployeesModal');
        // Reset form
        this.importFile = null;
        this.importPreviewRequest = (this.importPreviewRequest || 0) + 1;
        const fileInput = document.getElementById('importFileInput');
        const preview = document.getElementById('importPreview');
        const confirmBtn = document.getElementById('confirmImportBtn');
        if (fileInput) fileInput.value = '';
        if (preview) preview.style.display = 'none';
        if (confirmBtn) confirmBtn.disabled = true;
        const errorsDiv = document.getElementById('importErrors');
        if (errorsDiv) errorsDiv.innerHTML = '';
    }

    downloadTemplate() {
        const headers = ['Employee ID', 'First Name', 'Middle Name', 'Last Name', 'Department', 'Email', 'Campus', 'Contact Number', 'Date of Birth', 'Gender', 'Status'];
        const sampleRow = ['01-2020-00001', 'John', 'Doe', 'Smith', 'CSDL', 'john.smith@example.com', 'Main Campus', '09123456789', '1990-01-01', 'Male', 'Active'];
        const csv = [headers.join(','), sampleRow.join(',')].join('\n');
        this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'employees_import_template.csv');
    }

    async handleFileSelect(event) {
        const file = event.target.files[0];
        const requestId = this.importPreviewRequest = (this.importPreviewRequest || 0) + 1;
        this.importFile = null;

        const preview = document.getElementById('importPreview');
        const previewBody = document.getElementById('importPreviewBody');
        const previewCount = document.getElementById('previewCount');
        const confirmBtn = document.getElementById('confirmImportBtn');
        const errorsDiv = document.getElementById('importErrors');

        if (!preview || !previewBody || !previewCount || !confirmBtn) return;

        // Reset
        previewBody.innerHTML = '';
        errorsDiv.innerHTML = '';
        confirmBtn.disabled = true;
        preview.style.display = 'none';
        if (!file) return;

        try {
            if (!/\.(csv|xls|xlsx)$/i.test(file.name)) {
                throw new Error('Only CSV and Excel files are allowed.');
            }
            if (file.size > 5 * 1024 * 1024) {
                throw new Error('File size exceeds 5MB limit.');
            }
            errorsDiv.innerHTML = '<div class="alert alert-info">Reading file preview...</div>';
            const formData = new FormData();
            formData.append('file', file);
            const response = await ApiService.postFormData('/masterfiles/masterfiles-employees.php?action=import_preview', formData);
            if (requestId !== this.importPreviewRequest) return;
            if (!response.success) throw new Error(response.message || 'Unable to preview file.');

            const columns = ['employee_id', 'first_name', 'middle_name', 'last_name', 'department', 'email', 'campus', 'status'];
            previewBody.innerHTML = response.rows.map(row => `<tr>${columns.map(key => `<td>${this.escapeHtml(row[key] ?? (key === 'status' ? 'Active' : ''))}</td>`).join('')}</tr>`).join('');

            errorsDiv.innerHTML = '';
            previewCount.textContent = response.total;
            preview.style.display = 'block';
            confirmBtn.disabled = false;
            this.importFile = file;

        } catch (error) {
            if (requestId !== this.importPreviewRequest) return;
            const message = error.response?.data?.message || error.message || 'Unable to preview file.';
            errorsDiv.innerHTML = `<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>${this.escapeHtml(message)}</div>`;
            preview.style.display = 'none';
            confirmBtn.disabled = true;
        }
    }

    async confirmImport() {
        if (!this.importFile) return;

        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;

        const result = await swal.fire({
            title: 'Confirm Import',
            html: `Are you sure you want to import employees from this file?<br><small class="text-muted">This action cannot be undone.</small>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Import',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#0a8f1b'
        });

        if (!result.isConfirmed) return;

        const formData = new FormData();
        formData.append('file', this.importFile);
        const startedAt = Date.now();
        let elapsedTimer = null;

        try {
            swal.fire({
                title: 'Importing Employees...',
                html: `
                    <div>Validating and saving employee records.</div>
                    <div class="progress mt-3" style="height: 20px;" role="progressbar" aria-label="Estimated employee import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="1">
                        <div id="employeeImportProgress" class="progress-bar progress-bar-striped progress-bar-animated bg-success" style="width: 1%; min-width: 2.5rem;">1%</div>
                    </div>
                    <div class="small text-muted mt-1">Estimated progress while the server processes the file</div>
                    <div id="employeeImportElapsed" class="small text-muted mt-2">Elapsed time: 0 seconds</div>
                `,
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    swal.showLoading();
                    elapsedTimer = window.setInterval(() => {
                        const elapsedMs = Date.now() - startedAt;
                        const elapsed = Math.floor(elapsedMs / 1000);
                        const label = document.getElementById('employeeImportElapsed');
                        if (label) label.textContent = `Elapsed time: ${elapsed} second${elapsed === 1 ? '' : 's'}`;
                        const percent = Math.min(99, 1 + Math.floor(98 * (1 - Math.exp(-elapsedMs / 20000))));
                        const bar = document.getElementById('employeeImportProgress');
                        if (bar) {
                            bar.style.width = `${percent}%`;
                            bar.textContent = `${percent}%`;
                            bar.parentElement.setAttribute('aria-valuenow', String(percent));
                        }
                    }, 200);
                }
            });
            const response = await ApiService.postFormData('/masterfiles/masterfiles-employees.php?action=import', formData);

            if (response.success) {
                if (elapsedTimer !== null) {
                    window.clearInterval(elapsedTimer);
                    elapsedTimer = null;
                }
                const bar = document.getElementById('employeeImportProgress');
                if (bar) {
                    bar.style.width = '100%';
                    bar.textContent = '100%';
                    bar.parentElement.setAttribute('aria-valuenow', '100');
                }
                await new Promise(resolve => window.setTimeout(resolve, 300));
                const { imported, skipped, errors } = response;
                let message = `Successfully imported ${imported} employee(s).`;
                if (skipped > 0) {
                    message += ` ${skipped} row(s) skipped.`;
                }
                if (errors && errors.length > 0) {
                    message += `<br><br><strong>Errors:</strong><br><small>${errors.slice(0, 5).join('<br>')}${errors.length > 5 ? `<br>... and ${errors.length - 5} more` : ''}</small>`;
                }
                await swal.fire({
                    title: 'Import Successful',
                    html: message,
                    icon: 'success',
                    confirmButtonColor: '#0a8f1b'
                });
                this.hideModal('importEmployeesModal');
                window.location.reload();
            } else {
                throw new Error(response.message || 'Import failed');
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message || 'Import failed';
            await swal.fire({
                title: 'Import Failed',
                text: errorMsg,
                icon: 'error',
                confirmButtonColor: '#0a8f1b'
            });
        } finally {
            if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================
    // Permission Management Methods
    // ============================================

    async openManagePermissionsModal(employee) {
        if (!rbacUtil.requireMasterfilePermission('employees', 'edit', 'manage employee permissions')) {
            return;
        }

        console.log('[Permissions] Opening modal for employee:', JSON.stringify(employee, null, 2));
        
        const modal = document.getElementById('managePermissionsModal');
        if (!modal) {
            console.error('[Permissions] Modal not found');
            return;
        }

        // Store employee data for later use
        this.currentEmployee = employee;
        modal.classList.toggle('is-csdl-permissions', String(employee.role_id) === '100');

        // Set employee info in modal
        const nameEl = document.getElementById('permissionsEmployeeName');
        const roleEl = document.getElementById('permissionsEmployeeRole');
        if (nameEl) {
            const fullName = `${employee.first_name || ''} ${employee.middle_name || ''} ${employee.last_name || ''}`.trim();
            nameEl.textContent = fullName;
        }
        if (roleEl) {
            roleEl.textContent = employee.role_name || '';
        }

        // Show loading state
        const container = document.getElementById('permissionsContainer');
        if (container) {
            container.innerHTML = `
                <div class="text-center py-4">
                    <div class="spinner-border text-success" role="status">
                        <span class="visually-hidden">Loading...</span>
                    </div>
                    <p class="text-muted mt-2">Loading permissions...</p>
                </div>
            `;
        }

        // Show modal
        const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
        bsModal.show();

        // Load permissions - try multiple field names
        const employeeId = employee.employee_id || employee.id || employee.school_id;
        console.log('[Permissions] Extracted employee_id:', employeeId, 'from fields:', {
            employee_id: employee.employee_id,
            id: employee.id,
            school_id: employee.school_id
        });
        
        if (!employeeId) {
            console.error('[Permissions] No employee_id found in employee object:', Object.keys(employee));
            if (container) {
                container.innerHTML = `
                    <div class="alert alert-danger">
                        <i class="bi bi-exclamation-triangle me-2"></i>
                        Invalid employee data. Missing employee ID.
                    </div>
                `;
            }
            return;
        }
        
        await this.loadEmployeePermissions(employeeId);

        // Bind save button
        const saveBtn = document.getElementById('savePermissionsBtn');
        if (saveBtn) {
            saveBtn.onclick = () => this.saveEmployeePermissions(employeeId);
        }
    }

    async loadEmployeePermissions(employeeId) {
        try {
            console.log('[Permissions] Loading permissions for employee:', employeeId);
            
            if (!employeeId) {
                throw new Error('Employee ID is required');
            }
            
            // Ensure employeeId is a number or string, not undefined
            const cleanId = String(employeeId).trim();
            if (!cleanId || cleanId === 'undefined' || cleanId === 'null') {
                throw new Error('Invalid employee ID: ' + employeeId);
            }
            
            console.log('[Permissions] Making API call with employee_id:', cleanId);
            
            const data = await ApiService.get('/masterfiles/masterfiles-permissions.php', {
                action: 'get_employee_permissions',
                employee_id: cleanId
            });

            console.log('[Permissions] API response:', data);

            if (data?.success && data?.permissions) {
                this.renderPermissionsUI(data.permissions);
            } else {
                throw new Error(data?.message || 'Failed to load permissions');
            }
        } catch (error) {
            console.error('[Permissions] Error loading permissions:', error);
            const container = document.getElementById('permissionsContainer');
            if (container) {
                container.innerHTML = `
                    <div class="alert alert-danger">
                        <i class="bi bi-exclamation-triangle me-2"></i>
                        Failed to load permissions: ${error.message}
                    </div>
                `;
            }
        }
    }

    renderPermissionsUI(permissions) {
        const container = document.getElementById('permissionsContainer');
        if (!container) return;

        // Get employee role to filter permissions
        const employeeRole = this.currentEmployee?.role_id;
        const employeeRoleName = this.currentEmployee?.role_name || '';
        
        console.log('[Permissions] Rendering UI for role:', employeeRole, employeeRoleName);

        // Map role_id to module name(s)
        const roleModuleMap = {
            100: ['csdl', 'masterfiles'],           // CSDL Admin - CSDL + masterfiles permissions
            99: ['cashier'],         // Cashier - financial review, balances, and PN monitoring
            98: ['branch_admin'],    // Branch Admin - only branch_admin
            97: ['coo'],             // COO - only coo
            101: ['assessment']      // Assessment - PN tagging and the only reports role
        };

        const allowedModules = roleModuleMap[employeeRole] || [];
        
        // Filter permissions based on role
        let filteredPermissions = permissions;
        if (allowedModules.length > 0) {
            // Only show permissions for the employee's module(s)
            filteredPermissions = permissions.filter(perm => 
                allowedModules.includes(perm.permission_module)
            );
            console.log('[Permissions] Filtered to', filteredPermissions.length, 'permissions for modules:', allowedModules);
        } else {
            console.log('[Permissions] Unknown role, showing all', permissions.length, 'permissions');
        }

        // Group permissions by module
        const grouped = {};
        filteredPermissions.forEach(perm => {
            const module = perm.permission_module || 'other';
            if (!grouped[module]) {
                grouped[module] = { pages: [], actions: [] };
            }
            if (perm.permission_type === 'page') {
                grouped[module].pages.push(perm);
            } else if (perm.permission_type === 'action') {
                grouped[module].actions.push(perm);
            }
        });

        // Build UI
        let html = '';
        const moduleNames = {
            'csdl': 'CSDL Admin',
            'assessment': 'Assessment',
            'branch_admin': 'Branch Admin',
            'coo': 'COO',
            'cashier': 'Cashier',
            'masterfiles': 'Masterfiles Management'
        };

        // If no permissions to show
        if (Object.keys(grouped).length === 0) {
            html = `
                <div class="alert alert-info">
                    <i class="bi bi-info-circle me-2"></i>
                    No permissions available for this role.
                </div>
            `;
            container.innerHTML = html;
            return;
        }

        Object.keys(grouped).sort().forEach(module => {
            const moduleName = moduleNames[module] || module.toUpperCase();
            const data = grouped[module];

            html += `
                <div class="card mb-3">
                    <div class="card-header bg-light">
                        <h6 class="mb-0 text-success fw-bold">
                            <i class="bi bi-folder me-2"></i>${this.escapeHtml(moduleName)}
                        </h6>
                    </div>
                    <div class="card-body">
            `;

            // Pages section
            if (data.pages.length > 0) {
                html += `<div class="mb-3">
                    <p class="fw-semibold mb-2 text-muted small">
                        <i class="bi bi-file-earmark me-1"></i>Page Access
                    </p>
                    <div class="row g-2">`;
                
                data.pages.forEach(perm => {
                    const checked = Number(perm.is_granted) === 1 ? 'checked' : '';
                    html += `
                        <div class="col-md-6">
                            <div class="form-check">
                                <input class="form-check-input permission-checkbox" type="checkbox" 
                                       id="perm_${perm.permission_id}" 
                                       data-permission-id="${perm.permission_id}"
                                       data-grant-source="${perm.grant_source}"
                                       ${checked}>
                                <label class="form-check-label" for="perm_${perm.permission_id}">
                                    ${this.escapeHtml(perm.permission_name)}
                                </label>
                            </div>
                        </div>
                    `;
                });
                
                html += `</div></div>`;
            }

            // Actions section - with special handling for masterfiles
            if (data.actions.length > 0) {
                if (module === 'masterfiles') {
                    // Group masterfiles actions by entity type
                    const masterfilesGroups = {
                        'employees': { name: 'Employees Masterfile', icon: 'person-badge', actions: [] },
                        'students': { name: 'Students Masterfile', icon: 'people', actions: [] },
                        'campuses': { name: 'Campuses Masterfile', icon: 'geo-alt', actions: [] },
                        'departments': { name: 'Departments Masterfile', icon: 'building', actions: [] },
                        'scholarships': { name: 'Scholarships Masterfile', icon: 'award', actions: [] },
                        'school_years': { name: 'School Years Masterfile', icon: 'calendar3', actions: [] },
                        'year_levels': { name: 'Year Levels Masterfile', icon: 'layers', actions: [] },
                        'modalities': { name: 'Modalities Masterfile', icon: 'grid-3x3-gap', actions: [] },
                        'documents': { name: 'Document Types Masterfile', icon: 'file-earmark-text', actions: [] },
                        'programs': { name: 'Programs Masterfile', icon: 'book', actions: [] }
                    };

                    // Categorize actions by masterfile type
                    data.actions.forEach(perm => {
                        const key = perm.permission_key || '';
                        for (const [type, group] of Object.entries(masterfilesGroups)) {
                            if (key.includes(`.${type}.`)) {
                                group.actions.push(perm);
                                break;
                            }
                        }
                    });

                    // Render each masterfile group
                    Object.entries(masterfilesGroups).forEach(([type, group]) => {
                        if (group.actions.length > 0) {
                            html += `
                                <div class="mb-3 border-start border-3 border-success ps-3">
                                    <p class="fw-semibold mb-2 text-success small">
                                        <i class="bi bi-${group.icon} me-1"></i>${group.name}
                                    </p>
                                    <div class="row g-2">`;
                            
                            group.actions.forEach(perm => {
                                const checked = Number(perm.is_granted) === 1 ? 'checked' : '';
                                html += `
                                    <div class="col-md-6 col-lg-3">
                                        <div class="form-check">
                                            <input class="form-check-input permission-checkbox" type="checkbox" 
                                                   id="perm_${perm.permission_id}" 
                                                   data-permission-id="${perm.permission_id}"
                                                   data-grant-source="${perm.grant_source}"
                                                   ${checked}>
                                            <label class="form-check-label small" for="perm_${perm.permission_id}">
                                                ${this.escapeHtml(perm.permission_name)}
                                            </label>
                                        </div>
                                    </div>
                                `;
                            });
                            
                            html += `</div></div>`;
                        }
                    });
                } else {
                    // Regular actions display for non-masterfiles modules
                    html += `<div class="mb-2">
                        <p class="fw-semibold mb-2 text-muted small">
                            <i class="bi bi-lightning me-1"></i>Actions
                        </p>
                        <div class="row g-2">`;
                    
                    data.actions.forEach(perm => {
                        const checked = Number(perm.is_granted) === 1 ? 'checked' : '';
                        html += `
                            <div class="col-md-6">
                                <div class="form-check">
                                    <input class="form-check-input permission-checkbox" type="checkbox" 
                                           id="perm_${perm.permission_id}" 
                                           data-permission-id="${perm.permission_id}"
                                           data-grant-source="${perm.grant_source}"
                                           ${checked}>
                                    <label class="form-check-label" for="perm_${perm.permission_id}">
                                        ${this.escapeHtml(perm.permission_name)}
                                    </label>
                                </div>
                            </div>
                        `;
                    });
                    
                    html += `</div></div>`;
                }
            }

            html += `</div></div>`;
        });

        container.innerHTML = html;
    }

    async saveEmployeePermissions(employeeId) {
        const checkboxes = document.querySelectorAll('.permission-checkbox');
        const permissions = [];

        checkboxes.forEach(cb => {
            permissions.push({
                permission_id: parseInt(cb.dataset.permissionId),
                is_granted: cb.checked ? 1 : 0,
                grant_source: cb.dataset.grantSource
            });
        });

        try {
            const swal = window.Swal;
            
            // Show loading
            if (swal) {
                swal.fire({
                    title: 'Saving...',
                    text: 'Updating permissions',
                    allowOutsideClick: false,
                    allowEscapeKey: false,
                    didOpen: () => swal.showLoading()
                });
            }

            const data = await ApiService.post('/masterfiles/masterfiles-permissions.php?action=update_employee_permissions', {
                employee_id: employeeId,
                permissions: permissions
            });

            if (data?.success) {
                if (swal) {
                    await swal.fire({
                        title: 'Success',
                        text: 'Permissions updated successfully',
                        icon: 'success',
                        confirmButtonColor: '#03600f'
                    });
                }

                // Close modal
                const modal = document.getElementById('managePermissionsModal');
                if (modal) {
                    const bsModal = bootstrap.Modal.getInstance(modal);
                    if (bsModal) bsModal.hide();
                }
                window.location.reload();
            } else {
                throw new Error(data?.message || 'Failed to update permissions');
            }
        } catch (error) {
            const swal = window.Swal;
            if (swal) {
                await swal.fire({
                    title: 'Error',
                    text: error.message || 'Failed to update permissions',
                    icon: 'error',
                    confirmButtonColor: '#03600f'
                });
            }
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

export default MasterfilesEmployeesModule;
