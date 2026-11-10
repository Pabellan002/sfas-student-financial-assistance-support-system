import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import { masterfileEditToggleDelete } from '../../shared/shared-inline-actions.js';

const bulkSelectionHeading = '<input type="checkbox" class="form-check-input" data-bulk-all aria-label="Select all records on this page" hidden>';

function bulkSelectionCell(id) {
    return `<span data-record-id="${escapeHtml(String(id))}"><input type="checkbox" class="form-check-input" data-bulk-id="${escapeHtml(String(id))}" aria-label="Select record ${escapeHtml(String(id))}" hidden></span>`;
}

export default class MasterfilesDocumentsModule {
    async bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        const tableId = 'documentTypesTable';
        const refreshId = 'documentTypeRefresh';
        const resource = 'documents';
        const endpoint = '/masterfiles/masterfiles-documents.php';
        const idField = 'doc_type_id';
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
        this.rows = [];
        this.page = 1;
        this.perPage = 10;
        this.modal = null;
        this.detailsModal = null;
        this.listModal = null;
        this.viewedRow = null;
    }

    async init() {
        this.modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('documentTypeModal'));
        this.ensureSupportingUi();
        this.bindEvents();
        await this.refresh();
    }

    ensureSupportingUi() {
        const summary = document.getElementById('documentTypesShowing');
        if (summary?.parentElement?.classList.contains('card-body')) {
            summary.insertAdjacentHTML('beforebegin', `
                <div class="document-types-table-footer">
                    <div class="d-flex align-items-center gap-2">
                        <label for="documentTypesPerPage" class="small text-muted mb-0">Show</label>
                        <select id="documentTypesPerPage" class="form-select form-select-sm">
                            <option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option>
                        </select>
                        <span class="small text-muted">entries per page</span>
                    </div>
                    <div id="documentTypesPagination" class="document-types-pagination"></div>
                </div>`);
        }

        if (!document.getElementById('documentTypeDetailsModal')) {
            document.body.insertAdjacentHTML('beforeend', `
                <div class="modal fade masterfile-view-modal" id="documentTypeDetailsModal" tabindex="-1">
                    <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
                        <div class="modal-header bg-success text-white"><h5 class="modal-title"><i class="bi bi-file-earmark-text me-2"></i>Document Type Details</h5><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
                        <div class="modal-body">
                            <div class="masterfile-details-grid">
                                <section class="masterfile-details-card">
                                    <h6><i class="bi bi-file-earmark-text me-2" aria-hidden="true"></i>Document information</h6>
                                    <div class="document-type-detail-row"><span>Document Type</span><strong id="documentTypeDetailName"></strong></div>
                                    <div class="document-type-detail-row"><span>Requirement</span><strong id="documentTypeDetailRequirement"></strong></div>
                                    <div class="document-type-detail-row"><span>Status</span><strong id="documentTypeDetailStatus"></strong></div>
                                    <div class="mt-3"><span class="detail-label">Description</span><p id="documentTypeDetailDescription" class="document-type-detail-description mb-0"></p></div>
                                </section>
                            </div>
                        </div>
                        <div class="modal-footer"><button id="documentTypeDetailsEdit" class="btn btn-success">Edit Document Type</button><button class="btn btn-secondary" data-bs-dismiss="modal">Close</button></div>
                    </div></div>
                </div>
                <div class="modal fade" id="documentTypesListModal" tabindex="-1">
                    <div class="modal-dialog modal-dialog-centered modal-lg"><div class="modal-content">
                        <div class="modal-header bg-success text-white"><h5 class="modal-title" id="documentTypesListModalTitle"><i class="bi bi-file-earmark-text me-2"></i>Document Types</h5><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
                        <div class="modal-body"><div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead class="table-light"><tr><th class="text-center">Document Type</th><th class="text-center">Requirement</th><th class="text-center">Status</th></tr></thead><tbody id="documentTypesListModalBody"></tbody></table></div></div>
                        <div class="modal-footer"><span id="documentTypesListModalCount" class="me-auto text-muted small">No records</span><button class="btn btn-secondary" data-bs-dismiss="modal">Close</button></div>
                    </div></div>
                </div>`);
        }
        this.detailsModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('documentTypeDetailsModal'));
        this.listModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('documentTypesListModal'));
    }

    bindEvents() {
        document.getElementById('documentTypeRefresh')?.addEventListener('click', () => this.refresh());
        document.getElementById('documentTypeAdd')?.addEventListener('click', () => this.openForm());
        document.getElementById('documentTypeExport')?.addEventListener('click', () => this.onExportClick());
        document.getElementById('documentTypeSearch')?.addEventListener('input', () => this.resetPageAndRender());
        document.getElementById('documentTypeStatusFilter')?.addEventListener('change', () => this.resetPageAndRender());
        document.getElementById('documentTypeRequirementFilter')?.addEventListener('change', () => this.resetPageAndRender());
        document.getElementById('documentTypeSearchMobile')?.addEventListener('input', (event) => {
            document.getElementById('documentTypeSearch').value = event.target.value;
            this.resetPageAndRender();
        });
        document.getElementById('documentTypeApplyMobileFilters')?.addEventListener('click', () => {
            document.getElementById('documentTypeStatusFilter').value = document.getElementById('documentTypeStatusFilterMobile').value;
            document.getElementById('documentTypeRequirementFilter').value = document.getElementById('documentTypeRequirementFilterMobile').value;
            this.resetPageAndRender();
            bootstrap.Dropdown.getOrCreateInstance(document.getElementById('documentTypeMobileFilterBtn')).hide();
        });
        document.getElementById('documentTypesPerPage')?.addEventListener('change', (event) => {
            this.perPage = Number(event.target.value) || 10;
            this.resetPageAndRender();
        });
        document.getElementById('documentTypesPagination')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-page]');
            if (!button || button.disabled) return;
            this.page = Number(button.dataset.page);
            this.render();
        });
        document.querySelectorAll('[data-document-view]').forEach((card) => card.addEventListener('click', () => this.openCardList(card.dataset.documentView)));
        document.getElementById('documentTypesTableBody')?.addEventListener('click', (event) => this.handleTableClick(event));
        document.getElementById('documentTypeSave')?.addEventListener('click', () => this.save());
        document.getElementById('documentTypeDetailsEdit')?.addEventListener('click', () => {
            if (!this.viewedRow) return;
            this.detailsModal.hide();
            this.openForm(this.viewedRow);
        });
    }

    async refresh() {
        const refreshButton = document.getElementById('documentTypeRefresh');
        refreshButton?.setAttribute('disabled', 'disabled');
        const icon = refreshButton?.querySelector('i');
        icon?.classList.add('spin-icon');
        document.getElementById('documentTypeSearch').value = '';
        document.getElementById('documentTypeStatusFilter').value = 'all';
        document.getElementById('documentTypeRequirementFilter').value = 'all';
        const mobileSearch = document.getElementById('documentTypeSearchMobile');
        const mobileStatus = document.getElementById('documentTypeStatusFilterMobile');
        const mobileRequirement = document.getElementById('documentTypeRequirementFilterMobile');
        if (mobileSearch) mobileSearch.value = '';
        if (mobileStatus) mobileStatus.value = 'all';
        if (mobileRequirement) mobileRequirement.value = 'all';
        this.page = 1;
        try {
            const response = await ApiService.get('/masterfiles/masterfiles-documents.php', { action: 'list' });
            this.rows = response?.rows || [];
            document.getElementById('documentTypesTotal').textContent = response?.total ?? this.rows.length;
            document.getElementById('documentTypesActive').textContent = response?.active ?? this.rows.filter((row) => Number(row.status) === 1).length;
            document.getElementById('documentTypesInactive').textContent = response?.inactive ?? this.rows.filter((row) => Number(row.status) !== 1).length;
            this.render();
        } catch (error) {
            this.rows = [];
            this.render();
            Swal.fire({ icon: 'error', title: 'Unable to load document types', text: error?.message || 'Please try again.' });
        } finally {
            refreshButton?.removeAttribute('disabled');
            icon?.classList.remove('spin-icon');
        }
    }

    getFilteredRows() {
        const term = (document.getElementById('documentTypeSearch')?.value || '').trim().toLowerCase();
        const status = document.getElementById('documentTypeStatusFilter')?.value || 'all';
        const required = document.getElementById('documentTypeRequirementFilter')?.value || 'all';
        return this.rows.filter((row) => {
            const searchable = `${row.name || ''} ${row.description || ''}`.toLowerCase();
            return (!term || searchable.includes(term))
                && (status === 'all' || String(row.status) === status)
                && (required === 'all' || String(Number(row.is_required)) === required);
        });
    }

    resetPageAndRender() {
        this.page = 1;
        this.render();
    }

    render() {
        const filteredRows = this.getFilteredRows();
        const total = filteredRows.length;
        const pages = Math.max(1, Math.ceil(total / this.perPage));
        this.page = Math.min(this.page, pages);
        const start = total ? (this.page - 1) * this.perPage : 0;
        const pageRows = filteredRows.slice(start, start + this.perPage);
        const body = document.getElementById('documentTypesTableBody');
        const summary = document.getElementById('documentTypesShowing');
        if (!body) return;

        if (!pageRows.length) {
            body.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">No document types found.</td></tr>';
        } else {
            body.innerHTML = pageRows.map((row) => this.rowHtml(row)).join('');
        }

        if (summary) {
            const first = total ? start + 1 : 0;
            const last = total ? Math.min(start + this.perPage, total) : 0;
            summary.textContent = `Showing ${first} to ${last} of ${total} entries`;
        }
        this.renderPagination(pages);
    }

    rowHtml(row) {
        const active = Number(row.status) === 1;
        const required = Number(row.is_required) === 1;
        return `<tr class="document-type-data-row" data-row-id="${row.id}" tabindex="0">
            <td class="text-center">${bulkSelectionCell(row.id)}</td>
            <td class="text-center">${escapeHtml(row.name || '')}</td>
            <td class="text-center">${escapeHtml(row.description || 'No description')}</td>
            <td class="text-center"><span class="badge ${required ? 'bg-success' : 'bg-secondary'}">${required ? 'Required' : 'Optional'}</span></td>
            <td class="text-center"><span class="badge ${active ? 'bg-success' : 'bg-secondary'}">${active ? 'Active' : 'Inactive'}</span></td>
            <td class="text-center" data-id="${row.id}">${masterfileEditToggleDelete({ isActive: active })}</td>
        </tr>`;
    }

    renderPagination(pages) {
        const container = document.getElementById('documentTypesPagination');
        if (!container) return;
        if (pages <= 1) {
            container.innerHTML = '';
            return;
        }
        const buttons = Array.from({ length: pages }, (_, index) => index + 1).map((number) => `<button class="btn btn-sm ${number === this.page ? 'btn-success' : 'btn-outline-secondary'}" data-page="${number}">${number}</button>`).join('');
        container.innerHTML = `<button class="btn btn-sm btn-outline-secondary" data-page="${this.page - 1}" ${this.page === 1 ? 'disabled' : ''}>Previous</button>${buttons}<button class="btn btn-sm btn-outline-secondary" data-page="${this.page + 1}" ${this.page === pages ? 'disabled' : ''}>Next</button>`;
    }

    openCardList(view) {
        const title = view === 'active' ? 'Active Document Types' : view === 'inactive' ? 'Inactive Document Types' : 'All Document Types';
        const rows = view === 'active' ? this.rows.filter((row) => Number(row.status) === 1) : view === 'inactive' ? this.rows.filter((row) => Number(row.status) !== 1) : this.rows;
        document.getElementById('documentTypesListModalTitle').innerHTML = `<i class="bi bi-file-earmark-text me-2"></i>${title}`;
        document.getElementById('documentTypesListModalBody').innerHTML = rows.length ? rows.map((row) => `<tr><td class="text-center">${escapeHtml(row.name || '')}</td><td class="text-center">${Number(row.is_required) === 1 ? 'Required' : 'Optional'}</td><td class="text-center">${Number(row.status) === 1 ? 'Active' : 'Inactive'}</td></tr>`).join('') : '<tr><td colspan="3" class="text-center text-muted py-4">No records</td></tr>';
        document.getElementById('documentTypesListModalCount').textContent = rows.length ? `Showing ${rows.length} ${rows.length === 1 ? 'record' : 'records'}` : 'No records';
        this.listModal.show();
    }

    openDetails(row) {
        this.viewedRow = row;
        const required = Number(row.is_required) === 1;
        const active = Number(row.status) === 1;
        document.getElementById('documentTypeDetailName').textContent = row.name || '—';
        document.getElementById('documentTypeDetailRequirement').innerHTML = `<span class="badge ${required ? 'bg-success' : 'bg-secondary'}">${required ? 'Required' : 'Optional'}</span>`;
        document.getElementById('documentTypeDetailStatus').innerHTML = `<span class="badge ${active ? 'bg-success' : 'bg-secondary'}">${active ? 'Active' : 'Inactive'}</span>`;
        document.getElementById('documentTypeDetailDescription').textContent = row.description || 'No description provided.';
        this.detailsModal.show();
    }

    handleTableClick(event) {
        const button = event.target.closest('.inline-action-btn');
        if (button) return this.handleAction(event);
        const rowElement = event.target.closest('tr[data-row-id]');
        const row = this.rows.find((item) => String(item.id) === String(rowElement?.dataset.rowId));
        if (row) this.openDetails(row);
    }

    async onExportClick() {
        const result = await Swal.fire({
            title: 'Export Document Types',
            input: 'select',
            inputOptions: { csv: 'CSV', xls: 'Excel (.xls)', doc: 'Word (.doc)', pdf: 'PDF (.pdf)' },
            inputValue: 'csv',
            showCancelButton: true,
            confirmButtonText: 'Export',
            cancelButtonText: 'Cancel',
            buttonsStyling: false,
            customClass: { confirmButton: 'btn btn-success px-4', cancelButton: 'btn btn-secondary px-4', actions: 'd-flex gap-2', popup: 'swal2-custom-popup' }
        });
        if (result.isConfirmed) this.exportRows(result.value);
    }

    exportRows(format) {
        const rows = this.getFilteredRows();
        if (!rows.length) {
            Swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no document types matching the selected filters.', confirmButtonColor: '#007319' });
            return;
        }
        const headers = ['Document Type', 'Description', 'Requirement', 'Status'];
        const data = rows.map((row) => [row.name || '', row.description || '', Number(row.is_required) === 1 ? 'Required' : 'Optional', Number(row.status) === 1 ? 'Active' : 'Inactive']);
        if (format === 'pdf') return this.exportPdf(headers, data);
        if (format === 'xls') {
            const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
            const body = data.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(String(value))}</td>`).join('')}</tr>`).join('');
            return this.downloadBlob(new Blob([`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`], { type: 'application/vnd.ms-excel' }), 'document-types-export.xls');
        }
        if (format === 'doc') {
            const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
            const body = data.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(String(value))}</td>`).join('')}</tr>`).join('');
            return this.downloadBlob(new Blob([`<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`], { type: 'application/msword' }), 'document-types-export.doc');
        }
        const content = [headers, ...data].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
        this.downloadBlob(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8;' }), 'document-types-export.csv');
    }

    exportPdf(headers, data) {
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

        const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
        
        const trs = data.map((rowData, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
            return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
        }).join('');

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Document Types Report</title>
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
                            <h2>Document Types Masterfile Report</h2>
                        </div>
                        <div class="report-info">
                            <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                            <div><strong>Module:</strong> Document Types</div>
                            <div><strong>Total Records:</strong> ${data.length}</div>
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

    downloadBlob(blob, filename) {
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    openForm(row = null) {
        document.getElementById('documentTypeModalTitle').textContent = row ? 'Edit Document Type' : 'Add Document Type';
        document.getElementById('documentTypeId').value = row?.id || '';
        document.getElementById('documentTypeName').value = row?.name || '';
        document.getElementById('documentTypeDescription').value = row?.description || '';
        document.getElementById('documentTypeRequired').checked = Number(row?.is_required) === 1;
        this.modal.show();
    }

    async handleAction(event) {
        const button = event.target.closest('.inline-action-btn');
        const cell = button?.closest('td[data-id]');
        const row = this.rows.find((item) => String(item.id) === String(cell?.dataset.id));
        if (!button || !row) return;
        if (button.classList.contains('action-edit')) return this.openForm(row);
        if (button.classList.contains('action-toggle')) {
            const action = Number(row.status) === 1 ? 'deactivate' : 'activate';
            const result = await Swal.fire({ icon: 'warning', title: `${action[0].toUpperCase()}${action.slice(1)} document type?`, text: row.name, showCancelButton: true, confirmButtonText: action[0].toUpperCase() + action.slice(1), confirmButtonColor: '#007319' });
            if (result.isConfirmed) await this.submit('toggle', { doc_type_id: row.id });
            return;
        }
        if (button.classList.contains('action-delete')) {
            const result = await Swal.fire({ icon: 'warning', title: 'Delete document type?', text: row.name, showCancelButton: true, confirmButtonText: 'Delete', confirmButtonColor: '#d33' });
            if (result.isConfirmed) await this.submit('delete', { doc_type_id: row.id });
        }
    }

    async save() {
        const id = document.getElementById('documentTypeId').value;
        const name = document.getElementById('documentTypeName').value.trim();
        if (!name) return Swal.fire({ icon: 'warning', title: 'Document type name is required.' });
        await this.submit(id ? 'update' : 'create', {
            doc_type_id: id,
            doc_type_name: name,
            doc_type_description: document.getElementById('documentTypeDescription').value.trim(),
            doc_type_is_required: document.getElementById('documentTypeRequired').checked ? 1 : 0
        }, true);
    }

    async submit(action, data, closeModal = false) {
        try {
            const response = await ApiService.post(`/masterfiles/masterfiles-documents.php?action=${action}`, data);
            if (!response?.success) throw new Error(response?.message || 'Unable to save document type.');
            if (closeModal) this.modal.hide();
            await Swal.fire({ icon: 'success', title: 'Success', text: response.message, timer: 1400, showConfirmButton: false });
            window.location.reload();
        } catch (error) {
            Swal.fire({ icon: 'error', title: 'Unable to save', text: error?.message || 'Please try again.' });
        }
    }
}
