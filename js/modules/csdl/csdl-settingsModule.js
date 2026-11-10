import TurnstileWidget from '../../shared/shared-turnstile.js?v=20260914-settings-overlay';
import ApiService from '../../services/services-apiService.js?v=20260913-csrf-retry';

class CsdlSettingsModule {
    constructor() {
        this.settings = {};
        this.permissions = [];
        this.applicationPeriods = [];
        this.examSchedules = [];
        this.examScheduleSchoolYears = [];
        this.examSchedulePeriods = [];
        this.deletedExamScheduleIds = [];
        this.savedSecuritySettings = null;
        this.savedDocumentSettings = null;
        this.savedSystemSettings = null;
        this.savedFormDescriptionSettings = null;
        this.savedPaymentLimitationSettings = null;
        this.emailTemplateOffices = [];
        this.savedApplicationPeriods = null;
        this.savedExamSchedules = null;
        this.auditLogs = {
            data: [],
            currentPage: 1,
            perPage: 10,
            total: 0,
            totalPages: 0,
            filters: {
                action: '',
                userType: '',
                dateFrom: '',
                dateTo: '',
                search: ''
            }
        };
        this.profileData = {};
        this.otpTimer = null;
        this.otpTimeLeft = 300;
        this.pendingPasswordChange = false;
    }

    normalizeDateForCompare(value) {
        const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
    }
    
    async init() {
        this.profileTurnstile = new TurnstileWidget('profileTurnstile', 'profile_update');
        this.passwordTurnstile = new TurnstileWidget('passwordTurnstile', 'password_change');
        TurnstileWidget.bindModal('otpModal', () => this.pendingPasswordChange ? 'password_change' : 'profile_update');
        await this.loadPermissions();
        await this.loadEmployeeProfile();
        await this.loadSettings();
        await this.loadEmailTemplates();
        await this.loadApplicationPeriods();
        await this.loadExamSchedules();
        await this.loadAuditActions();
        await this.loadAuditLogs();
        this.setupEventListeners();
    }

    async loadPermissions() {
        try {
            const response = await ApiService.get('/masterfiles/masterfiles-permissions.php', { action: 'get_my_permissions' });
            this.permissions = response?.permissions || [];
        } catch (_) {
            this.permissions = [];
        }
    }

    hasPermission(permissionKey) {
        const permission = (this.permissions || []).find((item) => item.permission_key === permissionKey);
        return !!permission?.is_granted;
    }

    /** Ensures FormData POSTs match CSRFProtection::validateRequest() (body + header). */
    async prepareFormDataWithCsrf(formData) {
        let token = document.querySelector('meta[name="csrf-token"]')?.content;
        if (!token) {
            token = await ApiService.refreshCSRFToken();
        }
        if (token) {
            formData.append('csrf_token', token);
        }
        return token || null;
    }
    
    async loadEmployeeProfile() {
        try {
            const response = await ApiService.get('/csdl/csdl-settings.php', { action: 'get-profile' });
            if (response.success && response.employee) {
                this.profileData = response.employee;
                
                // Store original values for change detection
                this.originalContact = response.employee.employee_contact_number || '';
                this.originalEmail = response.employee.employee_email || '';
                this.originalBirthdate = this.normalizeDateForCompare(response.employee.employee_date_of_birth);
                this.originalGender = response.employee.employee_gender || '';
                
                this.populateProfileForm();
                
                // Load profile image if exists
                if (this.profileData.employee_profile_image) {
                    const profileImg = document.getElementById('profileImagePreview');
                    if (profileImg) {
                        profileImg.src = '../../' + this.profileData.employee_profile_image;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading employee profile:', error);
        }
    }
    
    populateProfileForm() {
        this.setValue('profileEmployeeId', this.profileData.employee_school_id);
        this.setValue('profileFirstName', this.profileData.employee_first_name);
        this.setValue('profileMiddleName', this.profileData.employee_middle_name);
        this.setValue('profileLastName', this.profileData.employee_last_name);
        this.setValue('profileBirthdate', this.originalBirthdate);
        this.setValue('profileGender', this.profileData.employee_gender);
        this.setValue('profileContactNumber', this.profileData.employee_contact_number);
        this.setValue('profileEmail', this.profileData.employee_email);
    }
    
    async loadSettings() {
        if (!this.hasPermission('csdl.settings.edit')) {
            return;
        }
        try {
            const response = await ApiService.get('/csdl/csdl-settings.php', { action: 'list' });
            if (response.success) {
                this.settings = response.settings || {};
                this.populateForms();
                this.captureSettingsSnapshots();
            }
        } catch (error) {
            console.error('Error loading settings:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load settings. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }

    async loadEmailTemplates() {
        if (!this.hasPermission('csdl.settings.edit')) return;
        const status = document.getElementById('emailTemplatesStatus');
        try {
            const previousOffice = document.getElementById('emailTemplateOffice')?.value;
            const previousType = document.getElementById('emailTemplateType')?.value;
            const response = await ApiService.get('/csdl/csdl-settings.php', { action: 'email-templates' });
            if (!response?.success) throw new Error(response?.message || 'Could not load email templates.');
            this.emailTemplateOffices = response.offices || [];
            const select = document.getElementById('emailTemplateOffice');
            select.replaceChildren();
            for (const office of this.emailTemplateOffices) {
                select.add(new Option(office.label, office.role));
            }
            if (previousOffice && this.emailTemplateOffices.some(office => office.role === previousOffice)) {
                select.value = previousOffice;
            }
            this.renderEmailTemplateTypes(previousType);
            if (status) status.textContent = '';
            return true;
        } catch (error) {
            if (status) {
                status.className = 'small mb-3 text-danger';
                status.textContent = error?.response?.data?.message || error.message || 'Could not load email templates.';
            }
            return false;
        }
    }

    renderEmailTemplateTypes(preferredType = '') {
        const office = this.emailTemplateOffices.find(item => item.role === document.getElementById('emailTemplateOffice')?.value);
        const select = document.getElementById('emailTemplateType');
        if (!select || !office) return;
        select.replaceChildren();
        for (const template of office.templates) select.add(new Option(template.label, template.type));
        if (preferredType && office.templates.some(item => item.type === preferredType)) select.value = preferredType;
        this.renderEmailTemplateEditor();
    }

    selectedEmailTemplate() {
        const office = this.emailTemplateOffices.find(item => item.role === document.getElementById('emailTemplateOffice')?.value);
        const template = office?.templates.find(item => item.type === document.getElementById('emailTemplateType')?.value);
        return office && template ? { office, template } : null;
    }

    renderEmailTemplateEditor() {
        const selected = this.selectedEmailTemplate();
        if (!selected) return;
        const { template } = selected;
        document.getElementById('emailTemplateSubject').value = template.override?.subject ?? template.defaults.subject;
        document.getElementById('emailTemplateBody').value = template.override?.body ?? template.defaults.body;
        const mode = document.getElementById('emailTemplateMode');
        mode.textContent = template.override ? 'Customized' : 'Built-in';
        mode.className = template.override ? 'badge bg-success' : 'badge bg-light text-dark border';
        document.getElementById('resetEmailTemplateBtn').disabled = !template.override;
        this.previewEmailTemplate();
    }

    previewEmailTemplate() {
        const sample = { student_name: 'Juan Dela Cruz', school_id: '01-2026-0001', application_no: '2026-0001', amount: '₱3,000.00', due_date: 'October 15, 2026', destination_office: 'COO' };
        const replace = text => text.replace(/\{([a-z_]+)\}/g, (full, key) => sample[key] ?? full);
        document.getElementById('emailTemplatePreviewSubject').textContent = replace(document.getElementById('emailTemplateSubject').value);
        document.getElementById('emailTemplatePreviewBody').textContent = replace(document.getElementById('emailTemplateBody').value);
    }

    async saveEmailTemplate(reset = false) {
        if (!this.ensureSettingsEditPermission()) return;
        const selected = this.selectedEmailTemplate();
        if (!selected) return;
        const status = document.getElementById('emailTemplatesStatus');
        const button = document.getElementById(reset ? 'resetEmailTemplateBtn' : 'saveEmailTemplateBtn');
        button.disabled = true;
        try {
            const response = await ApiService.post('/csdl/csdl-settings.php', {
                action: reset ? 'reset-email-template' : 'save-email-template',
                role: selected.office.role,
                type: selected.template.type,
                subject: document.getElementById('emailTemplateSubject').value,
                body: document.getElementById('emailTemplateBody').value
            });
            if (!response?.success) throw new Error(response?.message || 'Could not update template.');
            if (!await this.loadEmailTemplates()) return;
            status.className = 'small mb-3 text-success';
            status.textContent = response.message;
        } catch (error) {
            status.className = 'small mb-3 text-danger';
            status.textContent = error?.response?.data?.message || error.message || 'Could not update template.';
        } finally {
            button.disabled = reset && !this.selectedEmailTemplate()?.template.override;
        }
    }
    
    async loadApplicationPeriods() {
        if (!this.hasPermission('csdl.settings.edit')) {
            return;
        }
        try {
            const response = await ApiService.get('/csdl/csdl-settings.php', { action: 'application-periods' });
            if (response.success) {
                this.applicationPeriods = response.periods || [];
                this.renderApplicationPeriods();
                this.savedApplicationPeriods = this.collectApplicationPeriods();
            }
        } catch (error) {
            console.error('Error loading application periods:', error);
        }
    }
    
    renderApplicationPeriods() {
        const container = document.getElementById('applicationPeriodsContainer');
        if (!container) return;
        
        if (this.applicationPeriods.length === 0) {
            container.innerHTML = '<div class="col-12"><div class="text-center text-muted py-3">No application periods found.</div></div>';
            return;
        }
        
        container.innerHTML = this.applicationPeriods.map(period => {
            const isEnabled = period.app_period_status === 1;
            return `
                <div class="col-md-6 col-lg-4">
                    <div class="card border ${isEnabled ? 'border-success' : 'border-secondary'} h-100">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <h6 class="mb-0 fw-semibold">${this.escapeHtml(period.app_period_name)}</h6>
                                <span class="badge ${isEnabled ? 'bg-success' : 'bg-secondary'}">${isEnabled ? 'Enabled' : 'Disabled'}</span>
                            </div>
                            <div class="form-check form-switch">
                                <input class="form-check-input period-switch" type="checkbox" 
                                       id="period_${period.app_period_id}" 
                                       data-period-id="${period.app_period_id}"
                                       ${isEnabled ? 'checked' : ''}
                                       role="switch">
                                <label class="form-check-label" for="period_${period.app_period_id}">
                                    ${isEnabled ? 'Enabled' : 'Disabled'}
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async loadExamSchedules() {
        if (!this.hasPermission('csdl.settings.edit')) {
            return;
        }
        try {
            const response = await ApiService.get('/csdl/csdl-settings.php', { action: 'exam-schedules' });
            if (response.success) {
                this.examSchedules = (response.schedules || []).map((row) => ({
                    id: parseInt(row.exam_schedule_id, 10) || 0,
                    sy_id: parseInt(row.exam_sy_id, 10) || 0,
                    period_id: parseInt(row.exam_period_id, 10) || 0,
                    start_date: row.exam_start_date || '',
                    end_date: row.exam_end_date || '',
                    status: parseInt(row.exam_status, 10) === 1 ? 1 : 0,
                    sy_code: row.sy_code || '',
                    app_period_name: row.app_period_name || ''
                }));
                this.examScheduleSchoolYears = response.schoolYears || [];
                this.examSchedulePeriods = response.periods || [];
                this.deletedExamScheduleIds = [];
                this.renderExamSchedules();
                this.savedExamSchedules = this.collectExamSchedulesFromTable();
            }
        } catch (error) {
            console.error('Error loading exam schedules:', error);
            const tbody = document.getElementById('examSchedulesTableBody');
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-3">Failed to load exam schedules.</td></tr>';
            }
        }
    }

    renderExamSchedules() {
        const tbody = document.getElementById('examSchedulesTableBody');
        if (!tbody) return;

        if (this.examSchedules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">No exam schedules yet. Click <strong>Add schedule</strong> to create one.</td></tr>';
            return;
        }

        tbody.innerHTML = this.examSchedules.map((schedule, index) => this.renderExamScheduleRow(schedule, index)).join('');
    }

    renderExamScheduleRow(schedule, index) {
        const syOptions = this.examScheduleSchoolYears.map((sy) => {
            const selected = parseInt(sy.sy_id, 10) === schedule.sy_id ? 'selected' : '';
            return `<option value="${sy.sy_id}" ${selected}>${this.escapeHtml(sy.sy_code)}</option>`;
        }).join('');

        const periodOptions = this.examSchedulePeriods.map((period) => {
            const selected = parseInt(period.app_period_id, 10) === schedule.period_id ? 'selected' : '';
            return `<option value="${period.app_period_id}" ${selected}>${this.escapeHtml(period.app_period_name)}</option>`;
        }).join('');

        return `
            <tr data-exam-schedule-index="${index}">
                <td>
                    <select class="form-select form-select-sm exam-schedule-sy" required>
                        <option value="">Select school year</option>
                        ${syOptions}
                    </select>
                </td>
                <td>
                    <select class="form-select form-select-sm exam-schedule-period" required>
                        <option value="">Select period</option>
                        ${periodOptions}
                    </select>
                </td>
                <td>
                    <input type="date" class="form-control form-control-sm exam-schedule-start" value="${this.escapeHtml(schedule.start_date || '')}" required>
                </td>
                <td>
                    <input type="date" class="form-control form-control-sm exam-schedule-end" value="${this.escapeHtml(schedule.end_date || '')}">
                </td>
                <td class="text-center">
                    <div class="form-check form-switch d-inline-block">
                        <input class="form-check-input exam-schedule-status" type="checkbox" role="switch" ${schedule.status === 1 ? 'checked' : ''}>
                    </div>
                </td>
                <td class="text-center">
                    <button type="button" class="btn btn-outline-danger btn-sm exam-schedule-remove" title="Remove schedule" aria-label="Remove schedule">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }

    collectExamSchedulesFromTable() {
        const rows = document.querySelectorAll('#examSchedulesTableBody tr[data-exam-schedule-index]');
        const schedules = [];

        rows.forEach((row, index) => {
            const existing = this.examSchedules[index] || {};
            schedules.push({
                id: existing.id || 0,
                sy_id: parseInt(row.querySelector('.exam-schedule-sy')?.value || '0', 10),
                period_id: parseInt(row.querySelector('.exam-schedule-period')?.value || '0', 10),
                start_date: row.querySelector('.exam-schedule-start')?.value || '',
                end_date: row.querySelector('.exam-schedule-end')?.value || '',
                status: row.querySelector('.exam-schedule-status')?.checked ? 1 : 0
            });
        });

        return schedules;
    }

    addExamScheduleRow() {
        const hasDataRows = document.querySelector('#examSchedulesTableBody tr[data-exam-schedule-index]');
        if (hasDataRows) {
            this.examSchedules = this.collectExamSchedulesFromTable();
        } else {
            this.examSchedules = [];
        }

        this.examSchedules.push({
            id: 0,
            sy_id: 0,
            period_id: 0,
            start_date: '',
            end_date: '',
            status: 1
        });
        this.renderExamSchedules();
    }

    removeExamScheduleRow(index) {
        this.examSchedules = this.collectExamSchedulesFromTable();
        const schedule = this.examSchedules[index];
        if (schedule?.id > 0) {
            this.deletedExamScheduleIds.push(schedule.id);
        }
        this.examSchedules.splice(index, 1);
        this.renderExamSchedules();
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    populateForms() {
        // Security Settings
        this.setValue('maxLoginAttempts', this.settings.max_login_attempts?.value);
        this.setValue('accountLockDuration', this.settings.account_lock_duration?.value);
        this.setValue('sessionTimeoutSeconds', Math.max(300, Number(this.settings.session_timeout_seconds?.value) || 300));
        this.setChecked('autoUnlockAccounts', this.settings.auto_unlock_accounts?.value === '1');
        
        // Document Settings
        this.setValue('documentMaxSize', this.settings.document_max_size?.value);
        this.setValue('allowedDocumentTypes', this.settings.allowed_document_types?.value);
        
        // System Settings
        this.setValue('systemName', this.settings.system_name?.value);
        this.setValue('schoolName', this.settings.school_name?.value);
        this.setChecked('emailNotifications', this.settings.email_notifications?.value === '1');
        this.setChecked('autoControlNumber', this.settings.auto_control_number?.value === '1');
        this.setValue('minimumAmountCanPay', this.settings.minimum_amount_can_pay?.value ?? '1.00');
        
        // Form Description Settings
        this.setValue('formTitle', this.settings.form_title?.value);
        this.setValue('formDescription', this.settings.form_description?.value);
        this.setValue('formInstructions', this.settings.form_instructions?.value);
        
        // Display current logo if exists
        if (this.settings.system_logo?.value) {
            const logoPreview = document.getElementById('currentLogoPreview');
            const logoImg = document.getElementById('currentLogoImg');
            if (logoPreview && logoImg) {
                logoImg.src = '../../' + this.settings.system_logo.value;
                logoPreview.style.display = 'block';
            }
        }
    }
    
    setValue(id, value) {
        const el = document.getElementById(id);
        if (el && value !== undefined && value !== null) {
            el.value = value;
        }
    }
    
    setChecked(id, checked) {
        const el = document.getElementById(id);
        if (el) {
            el.checked = checked;
        }
    }
    
    async loadAuditActions() {
        if (!this.hasPermission('csdl.settings.edit')) return;
        try {
            const response = await ApiService.get('/csdl/csdl-settings.php', { action: 'audit-actions' });
            if (!response?.success) return;
            const select = document.getElementById('logActionFilter');
            if (!select) return;
            const selected = select.value;
            select.replaceChildren(new Option('All Actions', ''));
            for (const action of response.actions || []) {
                select.add(new Option(this.getActionLabel(action), action));
            }
            if ([...select.options].some(option => option.value === selected)) select.value = selected;
        } catch (error) {
            console.error('Could not load audit action filters:', error);
        }
    }

    async loadAuditLogs() {
        if (!this.hasPermission('csdl.settings.edit')) {
            this.showAuditLogsError('You do not have permission to view audit logs.');
            return;
        }
        try {
            const params = {
                action: 'audit-logs',
                page: this.auditLogs.currentPage,
                perPage: this.auditLogs.perPage,
                actionFilter: this.auditLogs.filters.action,
                userTypeFilter: this.auditLogs.filters.userType,
                dateFrom: this.auditLogs.filters.dateFrom,
                dateTo: this.auditLogs.filters.dateTo,
                search: this.auditLogs.filters.search
            };
            
            const response = await ApiService.get('/csdl/csdl-settings.php', params);
            if (response.success) {
                this.auditLogs.data = response.logs || [];
                this.auditLogs.total = response.total || 0;
                this.auditLogs.totalPages = response.totalPages || 0;
                this.renderAuditLogs();
                this.renderLogsPagination();
            } else {
                console.error('API returned error:', response.message);
                this.showAuditLogsError(response.message || 'Failed to load audit logs');
            }
        } catch (error) {
            console.error('Error loading audit logs:', error);
            this.showAuditLogsError('Failed to load audit logs. Please try again.');
        }
    }
    
    showAuditLogsError(message) {
        const tbody = document.getElementById('auditLogsTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center text-danger py-4">
                        <i class="bi bi-exclamation-triangle me-2"></i>${this.escapeHtml(message)}
                    </td>
                </tr>
            `;
        }
    }
    
    renderAuditLogs() {
        const tbody = document.getElementById('auditLogsTableBody');
        if (!tbody) return;
        
        if (this.auditLogs.data.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center text-muted py-4">
                        <i class="bi bi-inbox me-2"></i>No audit logs found
                    </td>
                </tr>
            `;
            document.getElementById('logsCount').textContent = 'Showing 0 to 0 of 0 entries';
            return;
        }
        
        tbody.innerHTML = this.auditLogs.data.map(log => {
            const details = this.truncateText(log.audit_log_details || '-', 80);
            const actionBadge = this.getActionBadge(log.audit_log_action);
            
            return `
                <tr>
                    <td class="text-center small">${this.escapeHtml(log.user_name || 'System')}</td>
                    <td class="text-center small">${actionBadge}</td>
                    <td class="text-center small" title="${this.escapeHtml(log.audit_log_details || '')}">${this.escapeHtml(details)}</td>
                    <td class="text-center small">${this.formatDateTime(log.audit_log_created_at)}</td>
                </tr>
            `;
        }).join('');
        
        const start = (this.auditLogs.currentPage - 1) * this.auditLogs.perPage + 1;
        const end = Math.min(start + this.auditLogs.data.length - 1, this.auditLogs.total);
        document.getElementById('logsCount').textContent = `Showing ${start} to ${end} of ${this.auditLogs.total} entries`;
    }
    
    renderLogsPagination() {
        const container = document.getElementById('logsPagination');
        if (!container) return;
        
        if (this.auditLogs.totalPages <= 1) {
            container.innerHTML = '';
            return;
        }
        
        const { currentPage, totalPages } = this.auditLogs;
        const pageNumbers = totalPages <= 7
            ? Array.from({ length: totalPages }, (_, index) => index + 1)
            : [...new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages])]
                .filter(page => page >= 1 && page <= totalPages)
                .sort((a, b) => a - b);
        let html = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>Previous</button>`;
        let previousPage = 0;
        for (const page of pageNumbers) {
            if (page > previousPage + 1) html += '<span class="csdl-settings-page-ellipsis" aria-hidden="true">…</span>';
            html += `<button type="button" class="btn btn-sm ${page === currentPage ? 'btn-success' : 'btn-outline-secondary'}" data-page="${page}" ${page === currentPage ? 'aria-current="page"' : ''}>${page}</button>`;
            previousPage = page;
        }
        html += `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Next</button>`;
        container.innerHTML = html;
    }
    
    getActionBadge(action) {
        const badges = {
            'LOGIN': '<span class="badge bg-success">Login</span>',
            'LOGOUT': '<span class="badge bg-secondary">Logout</span>',
            'CREATE_EMPLOYEE': '<span class="badge bg-primary">Create Employee</span>',
            'CREATE_STUDENT': '<span class="badge bg-primary">Create Student</span>',
            'UPDATE_EMPLOYEE': '<span class="badge bg-info">Update Employee</span>',
            'UPDATE_STUDENT': '<span class="badge bg-info">Update Student</span>',
            'DELETE_EMPLOYEE': '<span class="badge bg-danger">Delete Employee</span>',
            'DELETE_STUDENT': '<span class="badge bg-danger">Delete Student</span>',
            'CHANGE_PASSWORD': '<span class="badge bg-warning text-dark">Change Password</span>'
        };
        return badges[action] || `<span class="badge bg-secondary">${this.escapeHtml(this.getActionLabel(action))}</span>`;
    }
    
    truncateText(text, maxLength) {
        if (!text || text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }
    
    formatDateTime(datetime) {
        if (!datetime) return '-';
        const date = new Date(datetime);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    getActionLabel(action) {
        const labels = {
            LOGIN: 'Login',
            LOGOUT: 'Logout',
            CREATE_EMPLOYEE: 'Create Employee',
            CREATE_STUDENT: 'Create Student',
            UPDATE_EMPLOYEE: 'Update Employee',
            UPDATE_STUDENT: 'Update Student',
            DELETE_EMPLOYEE: 'Delete Employee',
            DELETE_STUDENT: 'Delete Student',
            CHANGE_PASSWORD: 'Change Password'
        };
        return labels[action] || String(action || '-').toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
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

    async promptExportFormat(title) {
        const swal = window.Swal;
        if (!swal) return null;

        const result = await swal.fire({
            title,
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
                confirmButton: 'btn btn-success px-4',
                cancelButton: 'btn btn-secondary px-4',
                actions: 'd-flex gap-2',
                popup: 'swal2-custom-popup'
            }
        });

        return result.isConfirmed ? result.value : null;
    }

    exportAuditLogRows(format, rows) {
        const headers = Object.keys(rows[0] || {});
        const stamp = new Date().toISOString().split('T')[0];
        const filenameBase = `csdl_audit_logs_${stamp}`;
        const title = 'Audit Logs';

        if (format === 'csv') {
            const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
            const lines = [headers.map(esc).join(',')];
            rows.forEach((row) => {
                lines.push(headers.map((header) => esc(row[header])).join(','));
            });
            this.downloadBlob(new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), `${filenameBase}.csv`);
            return;
        }

        if (format === 'xls') {
            const th = headers.map((header) => `<th>${this.escapeHtml(header)}</th>`).join('');
            const trs = rows.map((row) => `<tr>${headers.map((header) => `<td>${this.escapeHtml(String(row[header] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `${filenameBase}.xls`);
            return;
        }

        if (format === 'doc') {
            const th = headers.map((header) => `<th style="border:1px solid #000;padding:8px;background:#f0f0f0;">${this.escapeHtml(header)}</th>`).join('');
            const trs = rows.map((row) => `<tr>${headers.map((header) => `<td style="border:1px solid #000;padding:8px;">${this.escapeHtml(String(row[header] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<html><head><meta charset="utf-8"><title>${this.escapeHtml(title)}</title></head><body><h2>${this.escapeHtml(title)}</h2><p>Generated on: ${this.escapeHtml(new Date().toLocaleString())}</p><table style="border-collapse:collapse;width:100%;margin-top:20px;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), `${filenameBase}.doc`);
            return;
        }

        if (format === 'pdf') {
            this.exportAuditLogsPDF(rows);
        }
    }

    exportAuditLogsPDF(rows) {
        const escapeHtml = (str) => {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        const now = new Date();
        const dateStr = now.toLocaleDateString();
        const timeStr = now.toLocaleTimeString();
        
        // Build table from rows
        const headers = Object.keys(rows[0] || {});
        const thCells = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
        const bodyRows = rows.map((row, idx) => {
            const cells = headers.map(h => `<td>${escapeHtml(String(row[h] ?? ''))}</td>`).join('');
            return `<tr class="${idx % 2 === 0 ? 'even' : 'odd'}">${cells}</tr>`;
        }).join('');

        const printHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>CSDL Activity Logs Report</title>
    <style>
        @media print {
            @page { size: landscape; margin: 15mm; }
            body { margin: 0; }
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: 10px;
            color: #333;
            line-height: 1.4;
        }
        .header {
            display: grid;
            grid-template-columns: 68px minmax(0, 1fr) minmax(170px, auto);
            column-gap: 14px;
            align-items: center;
            text-align: left;
            margin-bottom: 20px;
            border-bottom: 2px solid #198754;
            padding-bottom: 15px;
            break-inside: avoid;
        }
        .logo {
            width: 60px;
            height: 60px;
            object-fit: contain;
            grid-column: 1;
            grid-row: 1 / 4;
            margin: 0;
        }
        .system-title, .office-title, .report-title {
            grid-column: 2;
        }
        .metadata {
            grid-column: 3;
            grid-row: 1 / 4;
            text-align: right;
        }
        .system-title {
            font-size: 18px;
            font-weight: bold;
            color: #198754;
            margin: 5px 0;
        }
        .office-title {
            font-size: 14px;
            color: #666;
            margin: 5px 0;
        }
        .report-title {
            font-size: 16px;
            font-weight: bold;
            color: #333;
            margin: 10px 0 5px;
        }
        .metadata {
            font-size: 10px;
            color: #666;
            margin-top: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 6px;
            text-align: left;
            font-size: 9px;
        }
        th {
            background-color: #198754;
            color: white;
            font-weight: 600;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            text-align: center;
        }
        tr.even {
            background-color: #f8f9fa;
        }
        tr.odd {
            background-color: white;
        }
        .footer {
            margin-top: 20px;
            padding-top: 10px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 9px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="header">
        <img src="${new URL('../../assets/images/i.png', document.baseURI).href}" alt="Logo" class="logo">
        <div class="system-title">Student Financial Assistance</div>
        <div class="office-title">Central Student Development and Linkages Office</div>
        <div class="report-title">Activity Logs Report</div>
        <div class="metadata">Generated on ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)} | Total Records: ${rows.length}</div>
    </div>
    <table>
        <thead>
            <tr>${thCells}</tr>
        </thead>
        <tbody>
            ${bodyRows}
        </tbody>
    </table>
    <div class="footer">
        <p>&copy; ${now.getFullYear()} Central Student Development and Linkages Office. All rights reserved.</p>
        <p>This document is for official use only. Please handle with confidentiality.</p>
    </div>
    <script>
        window.onload = function() { 
            window.print(); 
        };
    </script>
</body>
</html>`;

        const printWindow = window.open('', '_blank');
        if (printWindow) {
            printWindow.document.write(printHtml);
            printWindow.document.close();
        }
    }

    async exportAuditLogs() {
        if (!this.ensureSettingsEditPermission()) return;

        this.auditLogs.filters.search = document.getElementById('logSearch')?.value.trim() || '';

        const swal = window.Swal;
        if (!swal) return;

        try {
            const format = await this.promptExportFormat('Export Audit Logs');
            if (!format) return;

            swal.fire({
                title: 'Preparing export...',
                allowOutsideClick: false,
                didOpen: () => {
                    swal.showLoading();
                }
            });

            const filters = {
                action: 'audit-logs',
                actionFilter: this.auditLogs.filters.action,
                userTypeFilter: this.auditLogs.filters.userType,
                dateFrom: this.auditLogs.filters.dateFrom,
                dateTo: this.auditLogs.filters.dateTo,
                search: this.auditLogs.filters.search
            };

            if (format === 'csv') {
                const countResponse = await ApiService.get('/csdl/csdl-settings.php', { ...filters, page: 1, perPage: 10 });
                if (!countResponse.success) {
                    throw new Error(countResponse.message || 'Could not check the activity history.');
                }
                if (Number(countResponse.total || 0) === 0) {
                    swal.close();
                    await swal.fire({
                        icon: 'warning',
                        title: 'No Data',
                        text: 'No audit logs found for the current filters.',
                        confirmButtonColor: '#198754'
                    });
                    return;
                }
                const params = new URLSearchParams({ ...filters, export: 'csv' });
                const url = `${ApiService.getBaseURL()}/csdl/csdl-settings.php?${params}`;
                const result = await fetch(url, { credentials: 'same-origin' });
                if (!result.ok || !result.headers.get('content-type')?.includes('text/csv')) {
                    throw new Error('Could not download the complete activity history.');
                }
                const blob = await result.blob();
                swal.close();
                this.downloadBlob(blob, `activity-history-${new Date().toISOString().split('T')[0]}.csv`);
                return;
            }

            const response = await ApiService.get('/csdl/csdl-settings.php', {
                ...filters,
                export: '1',
            });

            swal.close();

            if (!response.success || !Array.isArray(response.logs)) {
                throw new Error(response.message || 'Failed to fetch audit logs for export');
            }

            if (response.truncated) {
                await swal.fire({
                    icon: 'warning',
                    title: 'Use CSV for the full history',
                    text: 'This format supports up to 10,000 entries. Choose CSV to export every matching entry.',
                    confirmButtonText: 'OK'
                });
                return;
            }

            if (response.logs.length === 0) {
                await swal.fire({
                    icon: 'warning',
                    title: 'No Data',
                    text: 'No audit logs found for the current filters.',
                    confirmButtonText: 'OK'
                });
                return;
            }

            const rows = response.logs.map((log) => ({
                User: log.user_name || 'System',
                'User Type': log.user_type || '-',
                Action: this.getActionLabel(log.audit_log_action),
                Details: log.audit_log_details || '',
                'IP Address': log.audit_log_ip_address || '',
                'Date & Time': this.formatDateTime(log.audit_log_created_at)
            }));

            this.exportAuditLogRows(format, rows);
        } catch (error) {
            console.error('Error exporting audit logs:', error);
            swal.fire({
                icon: 'error',
                title: 'Export Failed',
                text: error.message || 'Failed to export audit logs. Please try again.',
                confirmButtonText: 'OK'
            });
        }
    }
    
    setupEventListeners() {
        const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };
        on('#emailTemplateOffice', 'change', () => this.renderEmailTemplateTypes());
        on('#emailTemplateType', 'change', () => this.renderEmailTemplateEditor());
        on('#emailTemplateSubject', 'input', () => this.previewEmailTemplate());
        on('#emailTemplateBody', 'input', () => this.previewEmailTemplate());
        on('#saveEmailTemplateBtn', 'click', () => this.saveEmailTemplate());
        on('#resetEmailTemplateBtn', 'click', () => this.saveEmailTemplate(true));
        
        // Profile image upload preview
        on('#profileImageInput', 'change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file size (max 2MB)
                if (file.size > 2 * 1024 * 1024) {
                    // eslint-disable-next-line no-undef
                    Swal.fire({
                        icon: 'error',
                        title: 'File Too Large',
                        text: 'Profile image must be less than 2MB',
                        confirmButtonText: 'OK'
                    });
                    e.target.value = '';
                    return;
                }
                
                // Validate file type
                const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
                if (!allowedTypes.includes(file.type)) {
                    // eslint-disable-next-line no-undef
                    Swal.fire({
                        icon: 'error',
                        title: 'Invalid File Type',
                        text: 'Please upload a JPG or PNG image',
                        confirmButtonText: 'OK'
                    });
                    e.target.value = '';
                    return;
                }
                
                // Preview image
                const reader = new FileReader();
                reader.onload = (event) => {
                    const img = document.getElementById('profileImagePreview');
                    if (img) {
                        img.src = event.target.result;
                    }
                };
                reader.readAsDataURL(file);
            }
        });
        
        // Profile update
        on('#updateProfileBtn', 'click', () => {
            this.handleProfileUpdate();
        });
        
        // Password change
        on('#changePasswordBtn', 'click', () => {
            this.handlePasswordChange();
        });
        
        on('#toggleCurrentPassword', 'click', () => {
            const passwordInput = document.getElementById('currentPassword');
            const icon = document.querySelector('#toggleCurrentPassword i');
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                icon.classList.remove('bi-eye');
                icon.classList.add('bi-eye-slash');
            } else {
                passwordInput.type = 'password';
                icon.classList.remove('bi-eye-slash');
                icon.classList.add('bi-eye');
            }
        });
        
        on('#toggleNewPassword', 'click', () => {
            const passwordInput = document.getElementById('newPassword');
            const icon = document.querySelector('#toggleNewPassword i');
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                icon.classList.remove('bi-eye');
                icon.classList.add('bi-eye-slash');
            } else {
                passwordInput.type = 'password';
                icon.classList.remove('bi-eye-slash');
                icon.classList.add('bi-eye');
            }
        });
        
        on('#toggleConfirmPassword', 'click', () => {
            const passwordInput = document.getElementById('confirmPassword');
            const icon = document.querySelector('#toggleConfirmPassword i');
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                icon.classList.remove('bi-eye');
                icon.classList.add('bi-eye-slash');
            } else {
                passwordInput.type = 'password';
                icon.classList.remove('bi-eye-slash');
                icon.classList.add('bi-eye');
            }
        });
        
        // OTP modal
        on('#otpVerifyBtn', 'click', () => {
            this.verifyOTP();
        });
        
        on('#otpCancelBtn', 'click', () => {
            this.closeOTPModal();
        });
        
        // Resend OTP button
        on('#resendOtpBtn', 'click', async () => {
            const resendBtn = document.getElementById('resendOtpBtn');
            if (resendBtn) {
                resendBtn.disabled = true;
                resendBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending...';
                
                try {
                    const verification = TurnstileWidget.forModal('otpModal', this.pendingPasswordChange ? 'password_change' : 'profile_update');
                    const response = await verification.post(this.pendingPasswordChange ? '/auth/auth-change-password.php' : '/csdl/csdl-settings.php', this.pendingPasswordChange ? {
                        action: 'send_otp',
                        old_password: document.getElementById('currentPassword')?.value
                    } : {
                        action: 'send-otp',
                        email: document.getElementById('profileEmail')?.value,
                        birthdate: document.getElementById('profileBirthdate')?.value,
                        gender: document.getElementById('profileGender')?.value,
                        contact_number: document.getElementById('profileContactNumber')?.value
                    });
                    
                    if (response.success) {
                        this.startOTPTimer();
                    } else {
                        Swal.fire({
                            icon: 'error',
                            title: 'Error',
                            text: response.message || 'Failed to resend OTP.',
                            confirmButtonText: 'OK'
                        });
                    }
                } catch (error) {
                    console.error('Error resending OTP:', error);
                    Swal.fire({
                        icon: 'error',
                        title: 'Error',
                        text: error.response?.data?.message || 'Failed to resend OTP. Please try again.',
                        confirmButtonText: 'OK'
                    });
                } finally {
                    resendBtn.disabled = false;
                    resendBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Resend Code';
                }
            }
        });
        
        on('#refreshBtn', 'click', () => {
            this.loadSettings();
        });
        
        on('#saveSecuritySettingsBtn', 'click', () => this.saveSecuritySettings());
        on('#saveDocumentSettingsBtn', 'click', () => this.saveDocumentSettings());
        on('#saveApplicationPeriodsBtn', 'click', () => this.saveApplicationPeriods());
        on('#saveExamSchedulesBtn', 'click', () => this.saveExamSchedules());
        on('#saveSystemSettingsBtn', 'click', () => this.saveSystemSettings());
        on('#saveFormDescriptionBtn', 'click', () => this.saveFormDescriptionSettings());
        on('#savePaymentLimitationBtn', 'click', () => this.savePaymentLimitationSettings());

        on('#addExamScheduleBtn', 'click', () => {
            this.addExamScheduleRow();
        });

        const examSchedulesTableBody = document.getElementById('examSchedulesTableBody');
        if (examSchedulesTableBody) {
            examSchedulesTableBody.addEventListener('click', (e) => {
                const removeBtn = e.target.closest('.exam-schedule-remove');
                if (!removeBtn) return;
                const row = removeBtn.closest('tr[data-exam-schedule-index]');
                if (!row) return;
                const index = parseInt(row.getAttribute('data-exam-schedule-index'), 10);
                if (!Number.isNaN(index)) {
                    this.removeExamScheduleRow(index);
                }
            });
        }
        
        // Audit logs event listeners
        on('#logsPerPage', 'change', (e) => {
            this.auditLogs.perPage = parseInt(e.target.value);
            this.auditLogs.currentPage = 1;
            this.loadAuditLogs();
        });
        on('#logsPagination', 'click', (e) => {
            const button = e.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            const page = Number(button.dataset.page);
            if (page < 1 || page > this.auditLogs.totalPages || page === this.auditLogs.currentPage) return;
            this.auditLogs.currentPage = page;
            this.loadAuditLogs();
        });
        
        on('#logActionFilter', 'change', (e) => {
            this.auditLogs.filters.action = e.target.value;
            this.auditLogs.currentPage = 1;
            this.loadAuditLogs();
        });
        
        on('#logUserTypeFilter', 'change', (e) => {
            this.auditLogs.filters.userType = e.target.value;
            this.auditLogs.currentPage = 1;
            this.loadAuditLogs();
        });
        
        on('#logDateFrom', 'change', (e) => {
            this.auditLogs.filters.dateFrom = e.target.value;
            this.auditLogs.currentPage = 1;
            this.loadAuditLogs();
        });
        
        on('#logDateTo', 'change', (e) => {
            this.auditLogs.filters.dateTo = e.target.value;
            this.auditLogs.currentPage = 1;
            this.loadAuditLogs();
        });

        on('#logSearch', 'input', (e) => {
            clearTimeout(this.auditLogsSearchTimer);
            this.auditLogsSearchTimer = setTimeout(() => {
                this.auditLogs.filters.search = e.target.value.trim();
                this.auditLogs.currentPage = 1;
                this.loadAuditLogs();
            }, 300);
        });

        on('#exportAuditLogsBtn', 'click', () => {
            this.exportAuditLogs();
        });

        const exportAuditLogsBtn = document.getElementById('exportAuditLogsBtn');
        if (exportAuditLogsBtn) {
            exportAuditLogsBtn.style.display = this.hasPermission('csdl.settings.edit') ? '' : 'none';
        }
    }
    
    ensureSettingsEditPermission() {
        if (!this.hasPermission('csdl.settings.edit')) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Access Denied',
                text: 'You do not have permission to edit settings.',
                confirmButtonText: 'OK'
            });
            return false;
        }
        return true;
    }

    getMissingRequiredFields(settings, requiredFields) {
        const missing = [];
        for (const [key, label] of Object.entries(requiredFields)) {
            const value = settings[key];
            if (value === undefined || value === null || String(value).trim() === '') {
                missing.push(label);
            }
        }
        return missing;
    }

    normalizeForComparison(value) {
        if (Array.isArray(value)) {
            return value.map((item) => this.normalizeForComparison(item));
        }
        if (value && typeof value === 'object') {
            return Object.keys(value).sort().reduce((normalized, key) => {
                normalized[key] = this.normalizeForComparison(value[key]);
                return normalized;
            }, {});
        }
        return String(value ?? '');
    }

    hasChanges(currentValue, savedValue) {
        if (savedValue === null) return true;
        return JSON.stringify(this.normalizeForComparison(currentValue))
            !== JSON.stringify(this.normalizeForComparison(savedValue));
    }

    showNoChangesAlert() {
        // eslint-disable-next-line no-undef
        return Swal.fire({
            icon: 'warning',
            title: 'No Changes',
            text: 'Please update your information before submitting.',
            confirmButtonText: 'OK',
            confirmButtonColor: '#198754'
        });
    }

    captureSettingsSnapshots() {
        this.savedSecuritySettings = this.collectSecuritySettings();
        this.savedDocumentSettings = this.collectDocumentSettings();
        this.savedSystemSettings = this.collectSystemSettings();
        this.savedFormDescriptionSettings = this.collectFormDescriptionSettings();
        this.savedPaymentLimitationSettings = this.collectPaymentLimitationSettings();
    }

    showSettingsLoading(title = 'Saving...') {
        // eslint-disable-next-line no-undef
        Swal.fire({
            title,
            allowOutsideClick: false,
            didOpen: () => {
                // eslint-disable-next-line no-undef
                Swal.showLoading();
            }
        });
    }

    showSettingsError(error, fallbackMessage = 'Failed to save settings. Please try again.') {
        console.error('Error saving settings:', error);
        let errorMessage = fallbackMessage;
        if (error?.response) {
            errorMessage = error.response.data?.message || error.response.statusText || errorMessage;
        } else if (error?.message) {
            errorMessage = error.message;
        }
        // eslint-disable-next-line no-undef
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: errorMessage,
            confirmButtonText: 'OK'
        });
    }

    validateLogoFile(logoFile) {
        if (!logoFile) return true;
        const maxSize = 2 * 1024 * 1024;
        if (logoFile.size > maxSize) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'File Too Large',
                text: 'Logo file must be less than 2MB',
                confirmButtonText: 'OK'
            });
            return false;
        }
        const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
        if (!allowedTypes.includes(logoFile.type)) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Invalid File Type',
                text: 'Logo must be PNG, JPG, or GIF format',
                confirmButtonText: 'OK'
            });
            return false;
        }
        return true;
    }

    collectSecuritySettings() {
        return {
            max_login_attempts: document.getElementById('maxLoginAttempts')?.value || '',
            account_lock_duration: document.getElementById('accountLockDuration')?.value || '',
            session_timeout_seconds: document.getElementById('sessionTimeoutSeconds')?.value || '',
            auto_unlock_accounts: document.getElementById('autoUnlockAccounts')?.checked ? '1' : '0'
        };
    }

    collectDocumentSettings() {
        return {
            document_max_size: document.getElementById('documentMaxSize')?.value || '',
            allowed_document_types: document.getElementById('allowedDocumentTypes')?.value || ''
        };
    }

    collectSystemSettings() {
        return {
            system_name: document.getElementById('systemName')?.value || '',
            school_name: document.getElementById('schoolName')?.value || '',
            email_notifications: document.getElementById('emailNotifications')?.checked ? '1' : '0',
            auto_control_number: document.getElementById('autoControlNumber')?.checked ? '1' : '0'
        };
    }

    collectFormDescriptionSettings() {
        return {
            form_title: document.getElementById('formTitle')?.value || '',
            form_description: document.getElementById('formDescription')?.value || '',
            form_instructions: document.getElementById('formInstructions')?.value || ''
        };
    }

    collectPaymentLimitationSettings() {
        return {
            minimum_amount_can_pay: document.getElementById('minimumAmountCanPay')?.value || ''
        };
    }

    collectApplicationPeriods() {
        const periods = [];
        document.querySelectorAll('.period-switch').forEach((switchEl) => {
            const periodId = parseInt(switchEl.dataset.periodId, 10);
            const status = switchEl.checked ? 1 : 0;
            periods.push({ id: periodId, status });
        });
        return periods;
    }

    async postSettingsUpdate(settings, { logoFile = null, loadingTitle = 'Saving...' } = {}) {
        if (!this.validateLogoFile(logoFile)) {
            return null;
        }

        this.showSettingsLoading(loadingTitle);

        let response;
        if (logoFile) {
            const formData = new FormData();
            formData.append('action', 'update');
            formData.append('settings', JSON.stringify(settings));
            formData.append('systemLogo', logoFile);
            const csrfToken = await this.prepareFormDataWithCsrf(formData);
            const fetchResponse = await fetch('../../api/csdl/csdl-settings.php', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin',
                headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
            });
            response = await fetchResponse.json();
        } else {
            response = await ApiService.post('/csdl/csdl-settings.php', {
                action: 'update',
                settings
            });
        }

        // eslint-disable-next-line no-undef
        Swal.close();
        return response;
    }

    async saveSecuritySettings() {
        if (!this.ensureSettingsEditPermission()) return;
        const settings = this.collectSecuritySettings();
        const missing = this.getMissingRequiredFields(settings, {
            max_login_attempts: 'Maximum Login Attempts',
            account_lock_duration: 'Account Lock Duration',
            session_timeout_seconds: 'Session Timeout'
        });
        if (missing.length > 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Missing Required Fields',
                html: `Please fill in the following required fields:<br><strong>${missing.join(', ')}</strong>`,
                confirmButtonText: 'OK'
            });
            return;
        }
        if (!this.hasChanges(settings, this.savedSecuritySettings)) {
            await this.showNoChangesAlert();
            return;
        }

        try {
            const response = await this.postSettingsUpdate(settings, { loadingTitle: 'Saving security settings...' });
            if (response?.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({ icon: 'success', title: 'Success', text: 'Security settings saved successfully', confirmButtonText: 'OK' });
                await this.loadSettings();
            } else {
                throw new Error(response?.message || 'Failed to save security settings');
            }
        } catch (error) {
            this.showSettingsError(error, 'Failed to save security settings. Please try again.');
        }
    }

    async saveDocumentSettings() {
        if (!this.ensureSettingsEditPermission()) return;
        const settings = this.collectDocumentSettings();
        const missing = this.getMissingRequiredFields(settings, {
            document_max_size: 'Document Max Size',
            allowed_document_types: 'Allowed Document Types'
        });
        if (missing.length > 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Missing Required Fields',
                html: `Please fill in the following required fields:<br><strong>${missing.join(', ')}</strong>`,
                confirmButtonText: 'OK'
            });
            return;
        }
        if (!this.hasChanges(settings, this.savedDocumentSettings)) {
            await this.showNoChangesAlert();
            return;
        }

        try {
            const response = await this.postSettingsUpdate(settings, { loadingTitle: 'Saving document settings...' });
            if (response?.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({ icon: 'success', title: 'Success', text: 'Document settings saved successfully', confirmButtonText: 'OK' });
                await this.loadSettings();
            } else {
                throw new Error(response?.message || 'Failed to save document settings');
            }
        } catch (error) {
            this.showSettingsError(error, 'Failed to save document settings. Please try again.');
        }
    }

    async saveSystemSettings() {
        if (!this.ensureSettingsEditPermission()) return;
        const settings = this.collectSystemSettings();
        const missing = this.getMissingRequiredFields(settings, {
            system_name: 'System Name',
            school_name: 'School Name'
        });
        if (missing.length > 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Missing Required Fields',
                html: `Please fill in the following required fields:<br><strong>${missing.join(', ')}</strong>`,
                confirmButtonText: 'OK'
            });
            return;
        }

        const logoFile = document.getElementById('systemLogo')?.files[0] || null;
        if (!logoFile && !this.hasChanges(settings, this.savedSystemSettings)) {
            await this.showNoChangesAlert();
            return;
        }
        try {
            const response = await this.postSettingsUpdate(settings, {
                logoFile,
                loadingTitle: 'Saving system settings...'
            });
            if (response?.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({ icon: 'success', title: 'Success', text: 'System settings saved successfully', confirmButtonText: 'OK' });
                await this.loadSettings();
                const logoInput = document.getElementById('systemLogo');
                if (logoInput) logoInput.value = '';
            } else {
                throw new Error(response?.message || 'Failed to save system settings');
            }
        } catch (error) {
            this.showSettingsError(error, 'Failed to save system settings. Please try again.');
        }
    }

    async saveFormDescriptionSettings() {
        if (!this.ensureSettingsEditPermission()) return;
        const settings = this.collectFormDescriptionSettings();
        const missing = this.getMissingRequiredFields(settings, {
            form_title: 'Form Title',
            form_description: 'Form Description',
            form_instructions: 'Form Instructions'
        });
        if (missing.length > 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Missing Required Fields',
                html: `Please fill in the following required fields:<br><strong>${missing.join(', ')}</strong>`,
                confirmButtonText: 'OK'
            });
            return;
        }
        if (!this.hasChanges(settings, this.savedFormDescriptionSettings)) {
            await this.showNoChangesAlert();
            return;
        }

        try {
            const response = await this.postSettingsUpdate(settings, { loadingTitle: 'Saving form description...' });
            if (response?.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({ icon: 'success', title: 'Success', text: 'Form description saved successfully', confirmButtonText: 'OK' });
                await this.loadSettings();
            } else {
                throw new Error(response?.message || 'Failed to save form description');
            }
        } catch (error) {
            this.showSettingsError(error, 'Failed to save form description. Please try again.');
        }
    }

    async savePaymentLimitationSettings() {
        if (!this.ensureSettingsEditPermission()) return;

        const settings = this.collectPaymentLimitationSettings();
        const minimumAmount = Number(settings.minimum_amount_can_pay);
        if (!Number.isFinite(minimumAmount) || minimumAmount <= 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'Invalid minimum amount',
                text: 'Enter a minimum amount greater than ₱0.00.',
                confirmButtonText: 'OK'
            });
            return;
        }

        settings.minimum_amount_can_pay = minimumAmount.toFixed(2);
        if (!this.hasChanges(settings, this.savedPaymentLimitationSettings)) {
            await this.showNoChangesAlert();
            return;
        }

        try {
            const response = await this.postSettingsUpdate(settings, { loadingTitle: 'Saving payment limitation...' });
            if (!response?.success) {
                throw new Error(response?.message || 'Failed to save payment limitation');
            }
            // eslint-disable-next-line no-undef
            Swal.fire({ icon: 'success', title: 'Saved', text: 'Payment limitation saved successfully.', confirmButtonText: 'OK' });
            await this.loadSettings();
        } catch (error) {
            this.showSettingsError(error, 'Failed to save payment limitation. Please try again.');
        }
    }

    async saveApplicationPeriods() {
        if (!this.ensureSettingsEditPermission()) return;
        const periods = this.collectApplicationPeriods();
        if (periods.length === 0) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'warning',
                title: 'No Periods',
                text: 'No application periods are available to save.',
                confirmButtonText: 'OK'
            });
            return;
        }
        if (!this.hasChanges(periods, this.savedApplicationPeriods)) {
            await this.showNoChangesAlert();
            return;
        }

        try {
            this.showSettingsLoading('Saving application periods...');
            const response = await ApiService.post('/csdl/csdl-settings.php', {
                action: 'update-application-periods',
                periods
            });
            // eslint-disable-next-line no-undef
            Swal.close();
            if (response?.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({ icon: 'success', title: 'Success', text: 'Application periods saved successfully', confirmButtonText: 'OK' });
                await this.loadApplicationPeriods();
            } else {
                throw new Error(response?.message || 'Failed to save application periods');
            }
        } catch (error) {
            // eslint-disable-next-line no-undef
            Swal.close();
            this.showSettingsError(error, 'Failed to save application periods. Please try again.');
        }
    }

    async saveExamSchedules() {
        if (!this.ensureSettingsEditPermission()) return;
        try {
            const examSchedules = this.collectExamSchedulesFromTable();
            if (!this.hasChanges(examSchedules, this.savedExamSchedules) && this.deletedExamScheduleIds.length === 0) {
                await this.showNoChangesAlert();
                return;
            }
            this.showSettingsLoading('Saving exam schedules...');
            const csrfToken = await ApiService.refreshCSRFToken();
            if (!csrfToken) {
                throw new Error('Unable to refresh the security token. Please sign in again.');
            }
            const response = await ApiService.post('/csdl/csdl-settings.php', {
                action: 'save-exam-schedules',
                schedules: examSchedules,
                deleted_ids: this.deletedExamScheduleIds
            });
            // eslint-disable-next-line no-undef
            Swal.close();
            if (response?.success) {
                // eslint-disable-next-line no-undef
                Swal.fire({ icon: 'success', title: 'Success', text: 'Exam schedules saved successfully', confirmButtonText: 'OK' });
                await this.loadExamSchedules();
            } else {
                throw new Error(response?.message || 'Failed to save exam schedules');
            }
        } catch (error) {
            // eslint-disable-next-line no-undef
            Swal.close();
            this.showSettingsError(error, 'Failed to save exam schedules. Please try again.');
        }
    }
    
    async handleProfileUpdate() {
        const submitBtn = document.getElementById('updateProfileBtn');
        
        try {
            // Get form data
            const birthdate = this.normalizeDateForCompare(document.getElementById('profileBirthdate')?.value);
            const gender = document.getElementById('profileGender')?.value;
            const contactNumber = document.getElementById('profileContactNumber')?.value;
            const email = document.getElementById('profileEmail')?.value;
            const profileImageFile = document.getElementById('profileImageInput')?.files[0];
            
            // Validate
            if (!birthdate || !gender || !contactNumber || !email) {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'warning',
                    title: 'Missing Fields',
                    text: 'Please fill in all required fields',
                    confirmButtonText: 'OK'
                });
                return;
            }
            
            // Check if any changes were made
            const hasContactChanged = contactNumber !== this.originalContact;
            const hasEmailChanged = email !== this.originalEmail;
            const hasBirthdateChanged = birthdate !== this.originalBirthdate;
            const hasGenderChanged = gender !== this.originalGender;
            const hasImageChanged = profileImageFile !== undefined && profileImageFile !== null;
            
            if (!hasContactChanged && !hasEmailChanged && !hasBirthdateChanged && !hasGenderChanged && !hasImageChanged) {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'warning',
                    title: 'No Changes',
                    text: 'Please update your information before submitting.',
                    confirmButtonText: 'OK',
                    confirmButtonColor: '#198754'
                });
                return;
            }
            
            // Show loading state
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending OTP...';
            }
            
            // Create FormData for file upload
            const formData = new FormData();
            formData.append('action', 'send-otp');
            formData.append('email', email);
            formData.append('birthdate', birthdate);
            formData.append('gender', gender);
            formData.append('contact_number', contactNumber);
            if (profileImageFile) {
                formData.append('profile_image', profileImageFile);
            }
            
            const result = await this.profileTurnstile.postFormData('/csdl/csdl-settings.php', formData);
            
            if (result.success) {
                this.pendingPasswordChange = false;
                this.showOTPModal();
            } else {
                throw new Error(result.message || 'Failed to send OTP');
            }
        } catch (error) {
            console.error('Profile update error:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || error.message || 'Failed to send OTP. Please try again.',
                confirmButtonText: 'OK'
            });
        } finally {
            // Reset button state
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Save changes';
            }
        }
    }
    
    async handlePasswordChange() {
        const form = document.getElementById('passwordForm');
        const currentPasswordInput = document.getElementById('currentPassword');
        const newPasswordInput = document.getElementById('newPassword');
        const confirmPasswordInput = document.getElementById('confirmPassword');
        const submitBtn = document.getElementById('changePasswordBtn');
        
        // Check form validity first (native validation)
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        
        try {
            // Get form data
            const currentPassword = currentPasswordInput?.value;
            const newPassword = newPasswordInput?.value;
            const confirmPassword = confirmPasswordInput?.value;
            
            // Validate password match
            if (newPassword !== confirmPassword) {
                confirmPasswordInput.setCustomValidity('Passwords do not match');
                confirmPasswordInput.reportValidity();
                confirmPasswordInput.setCustomValidity('');
                return;
            }
            
            // Validate password length
            if (newPassword.length < 8) {
                newPasswordInput.setCustomValidity('Password must be at least 8 characters long');
                newPasswordInput.reportValidity();
                newPasswordInput.setCustomValidity('');
                return;
            }
            
            // Show loading state
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending OTP...';
            }
            
            // Verify old password and send OTP
            const response = await this.passwordTurnstile.post('/auth/auth-change-password.php', {
                action: 'send_otp',
                old_password: currentPassword,
                new_password: newPassword,
                confirm_password: confirmPassword
            });
            
            if (response.success) {
                this.pendingPasswordChange = true;
                this.showOTPModal();
            } else {
                throw new Error(response.message || 'Failed to send OTP');
            }
        } catch (error) {
            console.error('Password change error:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || error.message || 'Failed to send OTP. Please try again.',
                confirmButtonText: 'OK'
            });
        } finally {
            // Reset button state
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Change password';
            }
        }
    }
    
    showOTPModal() {
        // eslint-disable-next-line no-undef
        const modal = new bootstrap.Modal(document.getElementById('otpModal'));
        modal.show();
        this.otpTimeLeft = 300;
        this.startOTPTimer();
        document.getElementById('otpInput').value = '';
        document.getElementById('otpError').classList.add('d-none');
    }
    
    closeOTPModal() {
        // eslint-disable-next-line no-undef
        const modal = bootstrap.Modal.getInstance(document.getElementById('otpModal'));
        if (modal) modal.hide();
        if (this.otpTimer) clearInterval(this.otpTimer);
        this.pendingPasswordChange = false;
    }
    
    startOTPTimer() {
        if (this.otpTimer) clearInterval(this.otpTimer);
        
        this.otpTimeLeft = 60;
        const timerElement = document.getElementById('otpTimer');
        const timerText = document.getElementById('otpTimerText');
        const resendBtn = document.getElementById('resendOtpBtn');
        
        // Show timer, hide resend button
        if (timerText) timerText.classList.remove('d-none');
        if (resendBtn) resendBtn.classList.add('d-none');
        
        if (timerElement) {
            timerElement.textContent = this.otpTimeLeft;
        }
        
        this.otpTimer = setInterval(() => {
            this.otpTimeLeft--;
            if (timerElement) {
                timerElement.textContent = this.otpTimeLeft;
            }
            
            if (this.otpTimeLeft <= 0) {
                clearInterval(this.otpTimer);
                // Hide timer, show resend button
                if (timerText) timerText.classList.add('d-none');
                if (resendBtn) resendBtn.classList.remove('d-none');
            }
        }, 1000);
    }
    
    async verifyOTP() {
        try {
            const otpCode = document.getElementById('otpInput')?.value;
            
            if (!otpCode || otpCode.length !== 6) {
                document.getElementById('otpError').textContent = 'Please enter a valid 6-digit OTP code';
                document.getElementById('otpError').classList.remove('d-none');
                return;
            }
            
            if (this.pendingPasswordChange) {
                // Verify OTP for password change
                const currentPassword = document.getElementById('currentPassword')?.value;
                const newPassword = document.getElementById('newPassword')?.value;
                const confirmPassword = document.getElementById('confirmPassword')?.value;
                
                const response = await ApiService.post('/auth/auth-change-password.php', {
                    action: 'change_password',
                    otp: otpCode,
                    old_password: currentPassword,
                    new_password: newPassword,
                    confirm_password: confirmPassword
                });
                
                if (response.success) {
                    this.closeOTPModal();
                    
                    // Clear form
                    document.getElementById('currentPassword').value = '';
                    document.getElementById('newPassword').value = '';
                    document.getElementById('confirmPassword').value = '';
                    this.passwordTurnstile.reset();
                    
                    // eslint-disable-next-line no-undef
                    Swal.fire({
                        icon: 'success',
                        title: 'Password Changed',
                        text: 'Your password has been changed successfully',
                        confirmButtonText: 'OK'
                    });
                } else {
                    throw new Error(response.message || 'Invalid OTP code');
                }
            } else {
                // Verify OTP for profile update
                const birthdate = document.getElementById('profileBirthdate')?.value;
                const gender = document.getElementById('profileGender')?.value;
                const contactNumber = document.getElementById('profileContactNumber')?.value;
                const email = document.getElementById('profileEmail')?.value;
                
                const response = await ApiService.post('/csdl/csdl-settings.php', {
                    action: 'verify-otp',
                    otp_code: otpCode,
                    birthdate: birthdate,
                    gender: gender,
                    contact_number: contactNumber,
                    email: email
                });
                
                if (response.success) {
                    this.closeOTPModal();
                    this.profileTurnstile.reset();
                    await this.loadEmployeeProfile();
                    
                    // eslint-disable-next-line no-undef
                    Swal.fire({
                        icon: 'success',
                        title: 'Profile Updated',
                        text: 'Your contact information has been updated successfully',
                        confirmButtonText: 'OK'
                    });
                } else {
                    throw new Error(response.message || 'Invalid OTP code');
                }
            }
        } catch (error) {
            console.error('OTP verification error:', error);
            document.getElementById('otpError').textContent = error.message || 'Invalid OTP code. Please try again.';
            document.getElementById('otpError').classList.remove('d-none');
        }
    }
}

export default CsdlSettingsModule;
