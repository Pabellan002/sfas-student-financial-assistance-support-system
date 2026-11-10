import ApiService from '../services/services-apiService.js';
import { escapeHtml } from '../shared/shared-escape.js';
import rbacUtil from '../shared/shared-rbac.js?v=20261008-server-rbac';
import { inlineActionButton, inlineActionsRow } from '../shared/shared-inline-actions.js';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    await rbacUtil.init();

    const byId = id => document.getElementById(id);
    const table = byId('modalitiesTable');
    const tbody = byId('modalitiesBody');
    const form = byId('modalityForm');
    const editModalElement = byId('modalityModal');
    const viewModalElement = byId('viewModalityModal');
    const listModalElement = byId('modalitiesListModal');
    const editModal = bootstrap.Modal.getOrCreateInstance(editModalElement);
    const viewModal = bootstrap.Modal.getOrCreateInstance(viewModalElement);
    const listModal = bootstrap.Modal.getOrCreateInstance(listModalElement);
    let rows = [];
    let page = 1;
    let sortKey = 'id';
    let sortDirection = 1;
    let currentViewId = null;

    const canEdit = () => rbacUtil.canEditMasterfile('modalities');
    const canDelete = () => rbacUtil.canDeleteMasterfile('modalities');
    const rowById = id => rows.find(row => Number(row.id) === Number(id));
    const isDeleteProtected = row => Number(row.id) === 1 || Number(row.students) > 0;
    const showSuccess = (title, message) => Swal.fire({ icon: 'success', title, text: message, confirmButtonColor: '#198754' });

    function filteredRows() {
        const term = byId('searchModalities').value.trim().toLowerCase();
        const status = byId('filterModalityStatus').value;
        return rows.filter(row => {
            if (status === 'active' && Number(row.status) !== 1) return false;
            if (status === 'inactive' && Number(row.status) === 1) return false;
            return !term || `${row.code} ${row.name}`.toLowerCase().includes(term);
        }).sort((a, b) => {
            if (sortKey === 'students' || sortKey === 'status' || sortKey === 'id') {
                return sortDirection * (Number(a[sortKey]) - Number(b[sortKey]));
            }
            return sortDirection * String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''));
        });
    }

    function actionCell(row) {
        const buttons = [];
        if (canEdit()) {
            buttons.push(inlineActionButton({ type: 'edit', title: 'Edit', actionClass: 'action-edit', dataAttrs: { action: 'edit' } }));
            const activate = Number(row.status) !== 1;
            let toggle = inlineActionButton({
                type: activate ? 'toggleOff' : 'toggleOn',
                title: activate ? 'Activate' : 'Deactivate',
                actionClass: 'action-toggle',
                dataAttrs: { action: 'toggle' },
                active: !activate,
            });
            if (!activate && (Number(row.id) === 1 || Number(row.students) > 0)) {
                toggle = toggle.replace('<button ', '<button disabled ');
            }
            buttons.push(toggle);
        }
        if (canDelete()) {
            let remove = inlineActionButton({ type: 'delete', title: 'Delete', actionClass: 'action-delete', dataAttrs: { action: 'delete' } });
            if (isDeleteProtected(row)) remove = remove.replace('<button ', '<button disabled ');
            buttons.push(remove);
        }
        return `<span class="d-inline-flex justify-content-center w-100">${inlineActionsRow(buttons.join(''))}</span>`;
    }

    function renderPagination(totalPages) {
        const nav = byId('modalitiesPagination');
        if (totalPages <= 1) {
            nav.innerHTML = '';
            return;
        }
        const buttons = [];
        const pageButton = (target, label, active = false, disabled = false) =>
            `<button type="button" class="btn btn-sm ${active ? 'btn-success' : 'btn-outline-secondary'}" data-page="${target}" ${active ? 'aria-current="page"' : ''} ${disabled ? 'disabled' : ''}>${label}</button>`;

        buttons.push(pageButton(Math.max(1, page - 1), 'Previous', false, page === 1));
        const pageNumbers = totalPages <= 7
            ? Array.from({ length: totalPages }, (_, index) => index + 1)
            : [...new Set([1, totalPages, page - 1, page, page + 1].filter(value => value >= 1 && value <= totalPages))].sort((a, b) => a - b);
        let previous = 0;
        for (const number of pageNumbers) {
            if (previous && number > previous + 1) buttons.push('<span class="px-1 text-muted">…</span>');
            buttons.push(pageButton(number, String(number), number === page));
            previous = number;
        }
        buttons.push(pageButton(Math.min(totalPages, page + 1), 'Next', false, page === totalPages));
        nav.innerHTML = buttons.join('');
    }

    function render() {
        const filtered = filteredRows();
        const perPage = Number(byId('perPageSelectCustom').value) || 10;
        const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
        page = Math.min(Math.max(1, page), totalPages);
        const start = (page - 1) * perPage;
        const visible = filtered.slice(start, start + perPage);

        byId('modalityCount').textContent = String(rows.length);
        byId('activeModalityCount').textContent = String(rows.filter(row => Number(row.status) === 1).length);
        byId('modalityStudentCount').textContent = String(rows.reduce((sum, row) => sum + Number(row.students || 0), 0));
        byId('pageInfo').textContent = `Showing ${filtered.length ? start + 1 : 0} to ${Math.min(start + perPage, filtered.length)} of ${filtered.length} entries`;

        tbody.innerHTML = visible.length ? visible.map(row => {
            const id = Number(row.id);
            const statusBadge = Number(row.status) === 1
                ? '<span class="badge bg-success">Active</span>'
                : '<span class="badge bg-secondary">Inactive</span>';
            return `<tr class="cursor-pointer" data-id="${id}" tabindex="0" aria-label="View ${escapeHtml(row.name)} details">
                <td class="text-center">${escapeHtml(row.code)}</td>
                <td class="text-center">${escapeHtml(row.name)}</td>
                <td class="text-center">${Number(row.students || 0)}</td>
                <td class="text-center">${statusBadge}</td>
                <td class="text-center">${actionCell(row)}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="5" class="text-center text-muted py-4">No modalities found.</td></tr>';
        renderPagination(totalPages);
        table.querySelectorAll('thead [data-sort]').forEach(button => {
            button.closest('th').setAttribute('aria-sort', button.dataset.sort === sortKey ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none');
        });
    }

    async function load() {
        try {
            const result = await ApiService.get('/masterfiles/masterfiles-modalities.php', { action: 'list' });
            rows = result.rows || [];
            render();
        } catch (error) {
            await Swal.fire('Unable to load modalities', error.response?.data?.message || error.message || 'Please try again.', 'error');
        }
    }

    function openEdit(row) {
        if (!rbacUtil.requireMasterfilePermission('modalities', 'edit', 'edit modalities')) return;
        form.reset();
        byId('modalityId').value = row.id;
        byId('modalityCode').value = row.code;
        byId('modalityName').value = row.name;
        byId('modalityModalTitle').textContent = 'Edit Modality';
        editModal.show();
    }

    function openView(row) {
        currentViewId = Number(row.id);
        byId('viewModalityCode').textContent = row.code || '-';
        byId('viewModalityName').textContent = row.name || '-';
        byId('viewModalityStudents').textContent = String(row.students || 0);
        const badge = byId('viewModalityStatus');
        badge.textContent = Number(row.status) === 1 ? 'Active' : 'Inactive';
        badge.className = `badge ${Number(row.status) === 1 ? 'bg-success' : 'bg-secondary'}`;
        byId('editModalityFromViewBtn').hidden = !canEdit();
        viewModal.show();
    }

    function openList(kind) {
        const list = kind === 'active' ? rows.filter(row => Number(row.status) === 1)
            : kind === 'assigned' ? rows.filter(row => Number(row.students) > 0)
            : rows;
        byId('modalitiesListTitle').textContent = kind === 'active' ? 'Active Modalities' : kind === 'assigned' ? 'Modalities Assigned to Students' : 'All Modalities';
        byId('modalitiesListCount').textContent = `${list.length} ${list.length === 1 ? 'record' : 'records'}`;
        byId('modalitiesListBody').innerHTML = list.length ? list.map(row => `<tr class="cursor-pointer" data-id="${Number(row.id)}" tabindex="0" aria-label="View ${escapeHtml(row.name)} details">
            <td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td class="text-center">${Number(row.students || 0)}</td>
            <td class="text-center"><span class="badge ${Number(row.status) === 1 ? 'bg-success' : 'bg-secondary'}">${Number(row.status) === 1 ? 'Active' : 'Inactive'}</span></td>
        </tr>`).join('') : '<tr><td colspan="4" class="text-center text-muted py-4">No modalities found.</td></tr>';
        listModal.show();
    }

    async function deleteRow(row) {
        if (!rbacUtil.requireMasterfilePermission('modalities', 'delete', 'delete modalities')) return;
        const confirmation = await Swal.fire({
            titleText: `Delete ${row.name}?`,
            text: 'This action cannot be undone.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete',
            confirmButtonColor: '#dc3545',
        });
        if (!confirmation.isConfirmed) return;
        try {
            await ApiService.post('/masterfiles/masterfiles-modalities.php?action=delete', { modality_id: row.id });
            await showSuccess('Modality deleted', `${row.name} was deleted.`);
            window.location.reload();
        } catch (error) {
            await Swal.fire('Unable to delete modality', error.response?.data?.message || error.message || 'Please try again.', 'error');
        }
    }

    async function toggleRow(row) {
        if (!rbacUtil.requireMasterfilePermission('modalities', 'edit', 'change modality status')) return;
        const activate = Number(row.status) !== 1;
        if (!activate) {
            const confirmation = await Swal.fire({
                titleText: `Deactivate ${row.name}?`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Deactivate',
                confirmButtonColor: '#dc3545',
            });
            if (!confirmation.isConfirmed) return;
        }
        try {
            await ApiService.post('/masterfiles/masterfiles-modalities.php?action=update', {
                modality_id: row.id,
                modality_code: row.code,
                modality_name: row.name,
                modality_status: activate ? 1 : 0,
            });
            await showSuccess(activate ? 'Modality activated' : 'Modality deactivated', `${row.name} is now ${activate ? 'active' : 'inactive'}.`);
            window.location.reload();
        } catch (error) {
            await Swal.fire('Unable to change status', error.response?.data?.message || error.message || 'Please try again.', 'error');
        }
    }

    byId('addModalityBtn').hidden = !rbacUtil.canCreateMasterfile('modalities');
    document.querySelectorAll('[data-view]').forEach(card => {
        card.addEventListener('click', () => openList(card.dataset.view));
        card.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            openList(card.dataset.view);
        });
    });
    const openDetailFromList = target => {
        const tr = target.closest('tr[data-id]');
        if (!tr) return;
        const id = tr.dataset.id;
        listModalElement.addEventListener('hidden.bs.modal', () => {
            const row = rowById(id);
            if (row) openView(row);
        }, { once: true });
        listModal.hide();
    };
    byId('modalitiesListBody').addEventListener('click', event => openDetailFromList(event.target));
    byId('modalitiesListBody').addEventListener('keydown', event => {
        if (event.target.tagName !== 'TR' || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        openDetailFromList(event.target);
    });
    byId('addModalityBtn').addEventListener('click', () => {
        if (!rbacUtil.requireMasterfilePermission('modalities', 'create', 'add modalities')) return;
        form.reset();
        byId('modalityId').value = '';
        byId('modalityModalTitle').textContent = 'Add Modality';
        editModal.show();
    });
    byId('refreshBtn').addEventListener('click', load);
    byId('searchModalities').addEventListener('input', () => {
        byId('searchModalitiesMobile').value = byId('searchModalities').value;
        page = 1;
        render();
    });
    byId('searchModalitiesMobile').addEventListener('input', () => {
        byId('searchModalities').value = byId('searchModalitiesMobile').value;
        page = 1;
        render();
    });
    byId('filterModalityStatus').addEventListener('change', () => {
        byId('filterModalityStatusMobile').value = byId('filterModalityStatus').value;
        page = 1;
        render();
    });
    byId('mobileModalityFilterBtn').addEventListener('show.bs.dropdown', () => {
        byId('filterModalityStatusMobile').value = byId('filterModalityStatus').value;
    });
    byId('applyMobileModalityFilterBtn').addEventListener('click', () => {
        byId('filterModalityStatus').value = byId('filterModalityStatusMobile').value;
        page = 1;
        render();
        bootstrap.Dropdown.getOrCreateInstance(byId('mobileModalityFilterBtn')).hide();
    });
    byId('perPageSelectCustom').addEventListener('change', () => { page = 1; render(); });
    byId('modalitiesPagination').addEventListener('click', event => {
        const button = event.target.closest('button[data-page]');
        if (!button || button.disabled) return;
        page = Number(button.dataset.page);
        render();
    });
    table.querySelector('thead').addEventListener('click', event => {
        const button = event.target.closest('button[data-sort]');
        if (!button) return;
        if (sortKey === button.dataset.sort) sortDirection *= -1;
        else { sortKey = button.dataset.sort; sortDirection = 1; }
        page = 1;
        render();
    });
    tbody.addEventListener('click', event => {
        const tr = event.target.closest('tr[data-id]');
        if (!tr) return;
        const row = rowById(tr.dataset.id);
        if (!row) return;
        const button = event.target.closest('button[data-action]');
        if (button) {
            if (button.disabled) return;
            if (button.dataset.action === 'edit') openEdit(row);
            if (button.dataset.action === 'toggle') toggleRow(row);
            if (button.dataset.action === 'delete') deleteRow(row);
            return;
        }
        if (event.target.closest('input,button,a,label')) return;
        openView(row);
    });
    tbody.addEventListener('keydown', event => {
        if (event.target.tagName !== 'TR' || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        const row = rowById(event.target.dataset.id);
        if (row) openView(row);
    });
    byId('editModalityFromViewBtn').addEventListener('click', () => {
        const id = currentViewId;
        viewModalElement.addEventListener('hidden.bs.modal', () => {
            const row = rowById(id);
            if (row) openEdit(row);
        }, { once: true });
        viewModal.hide();
    });

    byId('exportBtn').addEventListener('click', async () => {
        const exportRows = filteredRows();
        if (!exportRows.length) {
            await Swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no modalities to export for the selected filters.', confirmButtonColor: '#007319' });
            return;
        }
        const choice = await Swal.fire({
            title: 'Export Modalities',
            input: 'select',
            inputOptions: { csv: 'CSV', xls: 'Excel (.xls)', doc: 'Word (.doc)', pdf: 'PDF (.pdf)' },
            inputValue: 'csv',
            showCancelButton: true,
            confirmButtonText: 'Export',
            cancelButtonText: 'Cancel',
            buttonsStyling: false,
            customClass: { confirmButton: 'btn btn-success px-4', cancelButton: 'btn btn-secondary px-4', actions: 'd-flex gap-2', popup: 'swal2-custom-popup' },
        });
        if (!choice.isConfirmed) return;
        const values = exportRows.map(row => [row.code, row.name, Number(row.students || 0), Number(row.status) === 1 ? 'Active' : 'Inactive']);
        const headers = ['Code', 'Modality Name', 'Students', 'Status'];
        const download = (blob, filename) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        if (choice.value === 'pdf') {
            const th = headers.map(header => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(header)}</th>`).join('');
            const trs = values.map((row, index) => `<tr style="background-color:${index % 2 === 0 ? '#ffffff' : '#f8f9fa'};">${row.map(value => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(value ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<!DOCTYPE html>
                <html><head><meta charset="utf-8"><title>Modalities Report</title>
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
                    @media print { body { padding: 0; } @page { margin: 15mm; } }
                </style></head><body>
                <div class="header"><div class="header-content">
                    <img src="${new URL('../../assets/images/i.png', document.baseURI).href}" alt="Logo" class="logo">
                    <div class="header-title"><h1>Student Financial Assistance</h1><h2>Modalities Masterfile Report</h2></div>
                    <div class="report-info">
                        <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                        <div><strong>Module:</strong> Modalities</div>
                        <div><strong>Total Records:</strong> ${values.length}</div>
                    </div>
                </div></div>
                <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
                <div class="footer"><div><strong>Student Financial Assistance Management System</strong></div>
                    <div>This is a system-generated report. No signature required.</div>
                    <div style="margin-top: 5px;">© ${new Date().getFullYear()} Student Financial Assistance</div>
                </div></body></html>`;
            const printWindow = window.open('', '_blank');
            if (printWindow) {
                printWindow.document.write(html);
                printWindow.document.close();
                printWindow.focus();
                Promise.all(Array.from(printWindow.document.images, image => image.decode ? image.decode().catch(() => {}) : Promise.resolve()))
                    .then(() => printWindow.print());
            }
            return;
        }
        const cell = value => {
            let text = String(value ?? '');
            if (/^[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
        };
        if (choice.value === 'csv') {
            const csv = '\uFEFF' + [headers, ...values].map(row => row.map(cell).join(',')).join('\r\n');
            download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'modalities.csv');
            return;
        }
        const safeHtml = value => escapeHtml(/^[=+\-@]/.test(String(value ?? '')) ? `'${value}` : String(value ?? ''));
        const tableHtml = `<table border="1" cellspacing="0" cellpadding="4"><thead><tr>${headers.map(value => `<th>${safeHtml(value)}</th>`).join('')}</tr></thead><tbody>${values.map(row => `<tr>${row.map(value => `<td>${safeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        if (choice.value === 'xls') download(new Blob([tableHtml], { type: 'application/vnd.ms-excel' }), 'modalities.xls');
        if (choice.value === 'doc') download(new Blob([`<html><body><h2>Modalities Masterfile</h2>${tableHtml}</body></html>`], { type: 'application/msword' }), 'modalities.doc');
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const id = byId('modalityId').value;
        const action = id ? 'update' : 'create';
        if (!rbacUtil.requireMasterfilePermission('modalities', id ? 'edit' : 'create', `${action} modalities`)) return;
        const name = byId('modalityName').value.trim();
        const payload = {
            modality_id: id,
            modality_code: byId('modalityCode').value.trim(),
            modality_name: name,
        };
        const saveButton = form.querySelector('button[type="submit"]');
        saveButton.disabled = true;
        try {
            await ApiService.post(`/masterfiles/masterfiles-modalities.php?action=${action}`, payload);
            editModal.hide();
            await showSuccess(id ? 'Modality updated' : 'Modality added', `${name} was ${id ? 'updated' : 'added'}.`);
            window.location.reload();
        } catch (error) {
            await Swal.fire('Unable to save modality', error.response?.data?.message || error.message || 'Please try again.', 'error');
        } finally {
            saveButton.disabled = false;
        }
    });

    new CsdlNotificationsModule().init();
    await load();
});
