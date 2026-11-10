import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import rbacUtil from '../../shared/shared-rbac.js?v=20261008-server-rbac';
import {
    INLINE_ACTION_IGNORE,
    masterfileStudentActions,
    pendingRegistrationActions,
} from '../../shared/shared-inline-actions.js';

const STUDENTS_IMPORT_MAX_FILE_BYTES = 250 * 1024 * 1024;
const STUDENTS_IMPORT_BROWSER_PREVIEW_BYTES = 10 * 1024 * 1024;

const PHINMAED_SUFFIX = '@phinmaed.com';
const FAMILY_NAME_PATTERN = /^[\p{L}\p{M} .,'\u2019-]+$/u;

const STUDENTS_IMPORT_EXPORT_HEADERS = [
    'School ID', 'First Name', 'Middle Name', 'Last Name', 'Program', 'Year Level',
    'School Email', 'Personal Email', 'Campus', 'Contact Number', 'Date of Birth',
    'Gender', 'Internal Scholarship', 'External Scholarships', 'Modality', 'Student Status', 'Facebook Account',
    'Father Name', 'Father Contact', 'Mother Name', 'Mother Contact',
    'Guardian Name', 'Guardian Contact'
];

class MasterfilesStudentsModule {
    renderStudentActions(row) {
        const actions = masterfileStudentActions(row.is_active);
        if (!rbacUtil.canEditMasterfile('students')) return actions;
        const reset = '<button type="button" class="inline-action-btn inline-action-btn--edit action-reset-password" title="Reset Password" aria-label="Reset Password"><i class="bi bi-key"></i></button>';
        return actions.replace('</div>', reset + '</div>');
    }

    async resetPassword(row) {
        if (this._passwordResetPending || !rbacUtil.requireMasterfilePermission('students', 'edit', 'reset student passwords')) return;
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
                        const response = await ApiService.post('/masterfiles/masterfiles-students.php?action=reset_password', { student_id: row.id || row.student_id });
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
        this.programs = [];
        this.yearLevels = [];
        this.scholarships = [];
        this.campuses = [];
        this.studentStatuses = [];
        this.pendingRows = [];
        this.pendingSearchTerm = '';
        this.pendingPage = 1;
        this.pendingPerPage = 10;
        this.selectedStudentIds = new Set();
        this.currentStudentRows = [];
        this.studentsPage = 1;
        this.studentsPerPage = 10;
        this.studentsTotal = 0;
        this.studentsTotalPages = 1;
        this._studentsRequestId = 0;
        this._studentSearchTimer = null;
        this._pendingBodyBound = false;
    }

    extractPhinmaEdLocalPart(email) {
        const value = String(email || '').trim().toLowerCase();
        if (!value) return '';
        if (value.endsWith(PHINMAED_SUFFIX)) {
            return value.slice(0, -PHINMAED_SUFFIX.length);
        }
        return '';
    }

    validatePhinmaEdLocalPart(local) {
        const value = String(local || '').trim().toLowerCase();
        if (!value || value.includes('@')) return false;
        if (value.length > 64) return false;
        // e.g. romeo.joi.coc, kesa.lumayog.coc (must end with .coc, at least 3 dot-separated parts)
        return /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+\.coc$/.test(value);
    }

    phinmaEdLocalPartHint() {
        return 'Use your full school email prefix ending in .coc (e.g. romeo.joi.coc or kesa.lumayog.coc).';
    }

    /** Accept local and PH country-code mobile formats, then store them as 09XXXXXXXXX. */
    normalizePhilippineMobile(raw) {
        const digits = String(raw || '').replace(/\D/g, '');
        if (!digits) return '';
        if (/^9\d{9}$/.test(digits)) return `0${digits}`;
        if (/^09\d{9}$/.test(digits)) return digits;
        if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
        return digits;
    }

    isValidPhilippineMobile(raw) {
        return /^09\d{9}$/.test(this.normalizePhilippineMobile(raw));
    }

    /** Excel serial numbers, M/D/YYYY without leading zeros, etc. → YYYY-MM-DD */
    parseFlexibleDate(value) {
        const raw = String(value ?? '').trim();
        if (!raw) return null;

        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            const [y, m, d] = raw.split('-').map(Number);
            const dt = new Date(y, m - 1, d);
            if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return raw;
            return false;
        }

        if (/^\d+(\.\d+)?$/.test(raw)) {
            const serial = Math.floor(Number(raw));
            if (serial >= 1 && serial <= 2958465) {
                const utc = Date.UTC(1899, 11, 30) + serial * 86400000;
                const dt = new Date(utc);
                const y = dt.getUTCFullYear();
                const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
                const day = String(dt.getUTCDate()).padStart(2, '0');
                return `${y}-${mo}-${day}`;
            }
        }

        const parts = raw.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
        if (parts) {
            let y;
            let m;
            let d;
            if (parts[1].length === 4) {
                y = parseInt(parts[1], 10);
                m = parseInt(parts[2], 10);
                d = parseInt(parts[3], 10);
            } else if (parts[3].length === 4) {
                m = parseInt(parts[1], 10);
                d = parseInt(parts[2], 10);
                y = parseInt(parts[3], 10);
            } else {
                return false;
            }
            if (y < 100) y += y >= 50 ? 1900 : 2000;
            const dt = new Date(y, m - 1, d);
            if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
                return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            }
            return false;
        }

        const ts = Date.parse(raw);
        if (!Number.isNaN(ts)) {
            const dt = new Date(ts);
            return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        }
        return false;
    }

    formatDateOfBirthDisplay(value) {
        const normalized = this.parseFlexibleDate(value);
        if (!normalized) return value ? String(value) : '-';
        const [y, m, d] = normalized.split('-');
        return `${m}/${d}/${y}`;
    }

    formatSubmittedDate(value) {
        if (!value) return '-';
        const date = new Date(String(value).replace(' ', 'T'));
        if (Number.isNaN(date.getTime())) return String(value);

        const datePart = new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
        }).format(date);
        const timePart = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(date);
        return `${datePart} • ${timePart}`;
    }

    getImportExportHeaderAliases() {
        return {
            school_id: ['school id', 'student id', 'student number', 'student no', 'id number'],
            first_name: ['first name', 'firstname', 'given name'],
            middle_name: ['middle name', 'middlename'],
            last_name: ['last name', 'lastname', 'surname', 'family name'],
            program: ['program', 'program code', 'course'],
            year_level: ['year level', 'yearlevel', 'year', 'level'],
            school_email: ['school email', 'email', 'phinmaed email', 'phinma email', 'institutional email'],
            personal_email: ['personal email', 'alternate email', 'backup email'],
            campus: ['campus'],
            contact_number: ['contact number', 'contact', 'mobile', 'phone'],
            date_of_birth: ['date of birth', 'birthdate', 'dob'],
            gender: ['gender'],
            internal_scholarship: ['internal scholarship', 'scholarship'],
            external_scholarships: ['external scholarships', 'external scholarship'],
            modality: ['modality'],
            student_status: ['student status', 'status'],
            facebook_account: ['facebook account', 'facebook', 'fb account'],
            father_name: ['father name'],
            father_contact: ['father contact'],
            mother_name: ['mother name'],
            mother_contact: ['mother contact'],
            guardian_name: ['guardian name'],
            guardian_contact: ['guardian contact'],
        };
    }

    buildImportHeaderMap(headers) {
        const normalized = {};
        headers.forEach((h, i) => {
            const label = String(h)
                .replace(/^\uFEFF/, '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            normalized[label] = i;
        });
        const map = {};
        const aliases = this.getImportExportHeaderAliases();
        Object.keys(aliases).forEach((key) => {
            for (const label of aliases[key]) {
                if (normalized[label] !== undefined) {
                    map[key] = normalized[label];
                    break;
                }
            }
        });
        return map;
    }

    parseCsvText(text) {
        const lines = [];
        let row = [];
        let cell = '';
        let inQuotes = false;
        const pushCell = () => {
            row.push(cell.trim());
            cell = '';
        };
        const pushRow = () => {
            if (row.length > 0 || cell !== '') {
                pushCell();
                if (row.some((c) => c !== '')) lines.push(row);
            }
            row = [];
        };
        const src = String(text || '').replace(/^\uFEFF/, '');
        const delimiter = this.detectCsvDelimiter(src);
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (ch === '"') {
                if (inQuotes && src[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === delimiter && !inQuotes) {
                pushCell();
            } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
                if (ch === '\r' && src[i + 1] === '\n') i++;
                pushRow();
            } else {
                cell += ch;
            }
        }
        pushRow();
        return lines;
    }

    detectCsvDelimiter(text) {
        const counts = { ',': 0, ';': 0, '\t': 0 };
        let inQuotes = false;
        const src = String(text || '').replace(/^\uFEFF/, '');
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (ch === '"') {
                if (inQuotes && src[i + 1] === '"') {
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }
            if (!inQuotes && (ch === '\n' || ch === '\r')) break;
            if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch]++;
        }
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ',';
    }

    mapCsvRowToImportRecord(values, headerMap) {
        const row = {};
        Object.keys(headerMap).forEach((key) => {
            const idx = headerMap[key];
            row[key] = (values[idx] ?? '').trim();
        });
        for (const key of ['school_email', 'personal_email']) {
            if (/^[-–—]+$|^n\/a$/i.test(row[key] || '')) row[key] = '';
        }
        for (const key of ['contact_number', 'father_contact', 'mother_contact', 'guardian_contact']) {
            row[key] = this.normalizeImportMobileCell(row[key]);
        }
        return row;
    }

    normalizeImportMobileCell(raw) {
        const value = String(raw || '').trim();
        if (/^[-–—]+$|^n\/a$/i.test(value)) return '';
        const spreadsheetNumber = value.match(/^(\+?(?:9\d{9}|09\d{9}|639\d{9}))\.0+$/);
        return spreadsheetNumber ? spreadsheetNumber[1] : value;
    }

    mapFamilyToImportExportFields(r) {
        const family = Array.isArray(r.family_details) ? r.family_details : [];
        const fixed = (relationship) => family.find((member) => Number(member.relationship_id) === relationship) || {};
        return {
            'Father Name': fixed(1).name || '',
            'Father Contact': fixed(1).contact || '',
            'Mother Name': fixed(2).name || '',
            'Mother Contact': fixed(2).contact || '',
            'Guardian Name': fixed(3).name || '',
            'Guardian Contact': fixed(3).contact || '',
        };
    }

    mapStudentToImportExportRow(r) {
        return {
            'School ID': r.school_id || '',
            'First Name': r.first_name || '',
            'Middle Name': r.middle_name || '',
            'Last Name': r.last_name || '',
            'Program': r.program_name || '',
            'Year Level': r.year_level_name || '',
            'School Email': this.extractPhinmaEdLocalPart(r.email || '') || (r.email || ''),
            'Personal Email': r.personal_email || '',
            'Campus': r.campus_name || '',
            'Contact Number': r.contact_number || '',
            'Date of Birth': r.date_of_birth || '',
            'Gender': r.gender || '',
            'Internal Scholarship': r.internal_scholarship_name || r.scholarship_name || '',
            'External Scholarships': r.external_scholarship_names || '',
            'Modality': r.modality_name || r.modality || '',
            'Student Status': r.status_name || '',
            'Facebook Account': r.fb_account || '',
            ...this.mapFamilyToImportExportFields(r)
        };
    }

    validateImportRow(row, rowNum) {
        const errors = [];
        if (!row.school_id) errors.push(`Row ${rowNum}: School ID is required.`);
        if (!row.first_name) errors.push(`Row ${rowNum}: First Name is required.`);
        if (!row.last_name) errors.push(`Row ${rowNum}: Last Name is required.`);
        if (!row.program) errors.push(`Row ${rowNum}: Program is required.`);
        if (!row.year_level) errors.push(`Row ${rowNum}: Year Level is required.`);

        const schoolRaw = String(row.school_email || row.email || '').trim().toLowerCase();
        const personal = String(row.personal_email || '').trim();
        let schoolLocal = schoolRaw;
        if (schoolRaw.includes('@')) {
            const full = schoolRaw.endsWith(PHINMAED_SUFFIX) ? schoolRaw : `${schoolRaw}${PHINMAED_SUFFIX}`;
            schoolLocal = this.extractPhinmaEdLocalPart(full);
        }

        if (schoolRaw && !this.validatePhinmaEdLocalPart(schoolLocal)) {
            errors.push(`Row ${rowNum}: School Email must end with .coc (e.g. romeo.joi.coc). Got: ${schoolRaw}`);
        }
        if (personal) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personal)) {
                errors.push(`Row ${rowNum}: Invalid Personal Email.`);
            }
        }
        const contactRaw = String(row.contact_number || '').trim();
        if (contactRaw && !this.isValidPhilippineMobile(contactRaw)) {
            row.contact_number = '';
            row._omittedContactNumber = true;
        } else if (contactRaw) {
            row.contact_number = this.normalizePhilippineMobile(contactRaw);
        }
        const dobRaw = String(row.date_of_birth || '').trim();
        if (dobRaw) {
            const parsedDob = this.parseFlexibleDate(dobRaw);
            if (parsedDob === false) {
                errors.push(`Row ${rowNum}: Invalid Date of Birth (use YYYY-MM-DD or M/D/YYYY; Excel serial dates are OK).`);
            } else {
                row.date_of_birth = parsedDob;
            }
        }
        return errors;
    }

    getImportScholarshipWarnings(row, rowNum, lookup) {
        const warnings = [];
        const internal = String(row.internal_scholarship || '').trim();
        if (internal && !lookup.internal.has(internal.toLowerCase())) {
            warnings.push(`Row ${rowNum}: Internal Scholarship "${internal}" will be ignored.`);
        }
        for (const value of String(row.external_scholarships || '').split(/[;|]+/)) {
            const external = value.trim();
            if (external && !lookup.external.has(external.toLowerCase())) {
                warnings.push(`Row ${rowNum}: External Scholarship "${external}" will be ignored.`);
            }
        }
        return warnings;
    }

    getImportableFamilyMembers(row) {
        const accepted = [];
        const skipped = [];
        for (const [key, label] of [['father', 'Father'], ['mother', 'Mother'], ['guardian', 'Guardian']]) {
            const name = String(row[`${key}_name`] || '').trim();
            const contact = String(row[`${key}_contact`] || '').trim();
            if (!name && !contact) continue;
            if (!this.isValidImportedFamilyName(name)) {
                skipped.push(`${label} (enter a name with letters, up to 200 characters)`);
            } else if (!this.isValidPhilippineMobile(contact)) {
                skipped.push(`${label} (invalid mobile number: ${contact.slice(0, 30) || 'blank'})`);
            } else {
                accepted.push([label, name, contact]);
            }
        }
        return { accepted, skipped };
    }

    isValidImportedFamilyName(value) {
        const name = String(value || '').trim();
        return name.length > 0 && Array.from(name).length <= 200 && /\p{L}/u.test(name);
    }

    isValidFamilyFullName(value) {
        const name = String(value || '').trim();
        const words = name.split(/\s+/);
        return name.length <= 200 && words.length >= 2 && words.every((word) => /\p{L}/u.test(word))
            && FAMILY_NAME_PATTERN.test(name) && (name.match(/\p{L}/gu) || []).length >= 4;
    }

    rowsToCsv(rows, headers) {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        return [headers.join(',')].concat(
            rows.map((r) => headers.map((h) => esc(r[h])).join(','))
        ).join('\n');
    }

    buildPhinmaEdEmail(local) {
        if (!this.validatePhinmaEdLocalPart(local)) return null;
        return `${String(local).trim().toLowerCase()}${PHINMAED_SUFFIX}`;
    }

    sanitizePhinmaEdLocalInput(raw) {
        let value = String(raw || '').trim().toLowerCase();
        if (!value) return '';
        if (value.includes('@')) {
            value = this.extractPhinmaEdLocalPart(value.includes(PHINMAED_SUFFIX) ? value : `${value}${PHINMAED_SUFFIX}`);
        }
        return value.replace(/[^a-z0-9.\-]/g, '');
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
        
        await Promise.all([
            this.loadPrograms(),
            this.loadYearLevels(),
            this.loadScholarships(),
            this.loadCampuses(),
            this.loadStudentStatuses(),
            this.loadModalities(),
            this.loadCounts(),
            this.loadPendingRegistrations(),
        ]);
        await this.buildTable();
        this.bindToolbar();
        this.bindRegistrationTabs();
        this.bindStatCards();
        this.bindPendingStatCards();
        this.bindPasswordTracking();
        this.applyInitialTabFromUrl();
        
        this.bindOutsideActionMenuClose();
        this.setupMobileFilterClose();
        this.bindInputValidations();
        
        // Apply RBAC permissions AFTER table is built
        rbacUtil.applyActionPermissions('csdl');
    }

    appendFilterOptions(selectId, items, valueKey, labelKeys) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const labels = Array.isArray(labelKeys) ? labelKeys : [labelKeys];
                const frag = document.createDocumentFragment();
        (items || []).forEach((item) => {
                    const opt = document.createElement('option');
            opt.value = item[valueKey];
            opt.textContent = labels.map((k) => item[k]).find(Boolean) || '';
                    frag.appendChild(opt);
                });
                sel.appendChild(frag);
            }

    async loadPrograms() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'get_programs' });
            this.programs = data?.programs || [];
            this.appendFilterOptions('program_id', this.programs, 'program_id', ['program_name', 'program_code']);
            ['filterProgram', 'filterProgramMobile', 'filterPendingProgram', 'filterPendingProgramMobile'].forEach((id) => {
                this.appendFilterOptions(id, this.programs, 'program_id', ['program_name', 'program_code']);
            });
        } catch (_) {
            this.programs = [];
        }
    }

    async loadYearLevels() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'get_year_levels' });
            this.yearLevels = data?.year_levels || [];
            this.appendFilterOptions('year_level_id', this.yearLevels, 'year_level_id', ['year_level_name', 'year_level_code']);
            ['filterYearLevel', 'filterYearLevelMobile', 'filterPendingYearLevel', 'filterPendingYearLevelMobile'].forEach((id) => {
                this.appendFilterOptions(id, this.yearLevels, 'year_level_id', ['year_level_name', 'year_level_code']);
            });
        } catch (_) {
            this.yearLevels = [];
        }
    }

    async loadScholarships() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'get_scholarships' });
            this.scholarships = data?.scholarships || [];
            const sel = document.getElementById('internal_scholarship_id');
            if (sel) {
                sel.querySelectorAll('option:not(:first-child)').forEach((option) => option.remove());
                const frag = document.createDocumentFragment();
                this.scholarships.filter((s) => String(s.scholarship_type || 'Internal').toLowerCase() === 'internal').forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.scholarship_id;
                    opt.textContent = s.scholarship_name;
                    frag.appendChild(opt);
                });
                sel.appendChild(frag);
            }
            const externalOptions = document.getElementById('externalScholarshipOptions');
            if (externalOptions) {
                const external = this.scholarships.filter((s) => String(s.scholarship_type || '').toLowerCase() === 'external');
                externalOptions.innerHTML = external.length
                    ? external.map((s) => `<label class="scholarship-multi-option">
                        <input class="form-check-input external-scholarship-checkbox" type="checkbox" value="${escapeHtml(String(s.scholarship_id))}">
                        <span><strong>${escapeHtml(s.scholarship_name || '')}</strong>${s.scholarship_code ? `<small class="d-block text-muted">${escapeHtml(s.scholarship_code)}</small>` : ''}</span>
                    </label>`).join('')
                    : '<div class="small text-muted px-2 py-1">No external scholarships available</div>';
                externalOptions.querySelectorAll('.external-scholarship-checkbox').forEach((checkbox) => {
                    checkbox.addEventListener('change', () => this.updateExternalScholarshipSummary());
                });
            }
            this.updateExternalScholarshipSummary();
        } catch (_) {
            this.scholarships = [];
        }
    }

    getSelectedExternalScholarshipIds() {
        return Array.from(document.querySelectorAll('#externalScholarshipOptions .external-scholarship-checkbox:checked'))
            .map((checkbox) => Number(checkbox.value))
            .filter((id) => Number.isInteger(id) && id > 0);
    }

    setSelectedExternalScholarshipIds(value) {
        const selected = new Set((Array.isArray(value) ? value : String(value || '').split(','))
            .map((id) => Number(String(id).trim()))
            .filter((id) => Number.isInteger(id) && id > 0));
        document.querySelectorAll('#externalScholarshipOptions .external-scholarship-checkbox').forEach((checkbox) => {
            checkbox.checked = selected.has(Number(checkbox.value));
        });
        this.updateExternalScholarshipSummary();
    }

    updateExternalScholarshipSummary() {
        const selected = Array.from(document.querySelectorAll('#externalScholarshipOptions .external-scholarship-checkbox:checked'));
        const names = selected.map((checkbox) => checkbox.closest('label')?.querySelector('strong')?.textContent?.trim()).filter(Boolean);
        const button = document.getElementById('externalScholarshipsDropdown');
        const summary = document.getElementById('externalScholarshipsSummary');
        if (button) button.textContent = names.length === 0 ? 'No external scholarships selected' : (names.length <= 2 ? names.join(', ') : `${names.length} scholarships selected`);
        if (summary) summary.textContent = names.length === 0 ? 'You can select more than one.' : `${names.length} selected: ${names.join(', ')}`;
    }

    async loadCampuses() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'get_campuses' });
            this.campuses = data?.campuses || [];
            const sel = document.getElementById('campus_id');
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
        } catch (_) {
            this.campuses = [];
        }
    }

    async loadModalities() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'get_modalities' });
            const modalities = data?.modalities || [];
            for (const id of ['modality', 'filterModality', 'filterModalityMobile']) {
                const select = document.getElementById(id);
                if (!select) continue;
                const value = select.value;
                select.innerHTML = '';
                if (id !== 'modality') select.add(new Option('All Modalities', ''));
                for (const item of modalities) select.add(new Option(item.modality_name, item.modality_code));
                if (value) select.value = value;
            }
        } catch (error) {
            console.error('Unable to load modalities:', error);
        }
    }

    async loadStudentStatuses() {
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'get_student_statuses' });
            this.studentStatuses = data?.statuses || [];
            const sel = document.getElementById('status_id');
            const filterSel = document.getElementById('filterStudentStatus');
            if (sel) {
                const frag = document.createDocumentFragment();
                this.studentStatuses.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.student_status_id;
                    opt.textContent = s.student_status_name;
                    frag.appendChild(opt);
                });
                sel.appendChild(frag);
            }
            if (filterSel) {
                const frag = document.createDocumentFragment();
                this.studentStatuses.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.student_status_id;
                    opt.textContent = s.student_status_name;
                    frag.appendChild(opt);
                });
                filterSel.appendChild(frag);
            }
            // Populate mobile filter
            const filterSelMobile = document.getElementById('filterStudentStatusMobile');
            if (filterSelMobile) {
                const frag = document.createDocumentFragment();
                this.studentStatuses.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.student_status_id;
                    opt.textContent = s.student_status_name;
                    frag.appendChild(opt);
                });
                filterSelMobile.appendChild(frag);
            }
        } catch (_) {
            this.studentStatuses = [];
        }
    }

    bindInputValidations() {
        // Name fields - only letters, spaces, hyphens, and apostrophes
        const nameFields = ['first_name', 'middle_name', 'last_name'];
        nameFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.addEventListener('input', (e) => {
                    e.target.value = e.target.value.replace(/[^a-zA-Z\s\-']/g, '');
                });
                field.addEventListener('keypress', (e) => {
                    const char = String.fromCharCode(e.which);
                    if (!/[a-zA-Z\s\-']/.test(char)) {
                        e.preventDefault();
                    }
                });
            }
        });

        // Contact number — accept 9XXXXXXXXX and normalize it to 09XXXXXXXXX.
        const contactField = document.getElementById('contact_number');
        if (contactField) {
            contactField.addEventListener('input', (e) => {
                let value = e.target.value.replace(/\D/g, '');
                if (value.length > 11) {
                    value = value.substring(0, 11);
                }
                e.target.value = value;
                if (value.length > 0) {
                    this.validateContactNumber(contactField, { quiet: value.length < 11 });
                } else {
                    contactField.setCustomValidity('');
                    contactField.classList.remove('border-danger', 'is-invalid');
                }
            });
            
            contactField.addEventListener('keypress', (e) => {
                const char = String.fromCharCode(e.which);
                if (!/[0-9]/.test(char)) {
                    e.preventDefault();
                }
            });

            contactField.addEventListener('blur', () => {
                this.validateContactNumber(contactField);
            });
        }

        const emailLocalField = document.getElementById('email_local');
        if (emailLocalField) {
            emailLocalField.addEventListener('input', (e) => {
                e.target.value = this.sanitizePhinmaEdLocalInput(e.target.value);
            });
            emailLocalField.addEventListener('blur', () => {
                this.validatePhinmaEdLocalField(emailLocalField);
            });
        }

        const personalEmailField = document.getElementById('personal_email');
        if (personalEmailField) {
            personalEmailField.addEventListener('blur', () => {
                const val = personalEmailField.value.trim();
                if (!val) {
                    personalEmailField.setCustomValidity('');
                    return;
                }
                personalEmailField.setCustomValidity(
                    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) ? '' : 'Enter a valid personal email address.'
                );
            });
        }
    }

    validatePhinmaEdLocalField(field) {
        if (!field) return true;
        const val = field.value.trim();
        if (!val) {
            field.setCustomValidity('');
            return true;
        }
        const ok = this.validatePhinmaEdLocalPart(val);
        field.setCustomValidity(ok ? '' : this.phinmaEdLocalPartHint());
        return ok;
    }

    validateStudentEmailsBeforeSave() {
        const emailLocal = document.getElementById('email_local');
        const personalEmail = document.getElementById('personal_email');
        const localVal = emailLocal?.value.trim() || '';
        const personalVal = personalEmail?.value.trim() || '';

        if (localVal && !this.validatePhinmaEdLocalField(emailLocal)) {
            emailLocal?.reportValidity();
            return false;
        }
        if (personalVal && personalEmail) {
            personalEmail.setCustomValidity(
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personalVal) ? '' : 'Enter a valid personal email address.'
            );
            if (!personalEmail.checkValidity()) {
                personalEmail.reportValidity();
                return false;
            }
        }
        if (!localVal && !personalVal) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire({
                icon: 'error',
                title: 'Email required',
                text: 'Enter a PHINMAEd school email and/or a personal email.',
                confirmButtonColor: '#0a8f1b'
            });
            return false;
        }
        return true;
    }

    validateContactNumber(inputElement, options = {}) {
        if (!inputElement) return false;
        const quiet = options.quiet === true;
        const normalized = this.normalizePhilippineMobile(inputElement.value);
        inputElement.classList.remove('border-success', 'border-danger', 'is-valid', 'is-invalid');
        
        if (!normalized) {
            inputElement.setCustomValidity('');
            return true;
        }

        if (/^09\d{9}$/.test(normalized)) {
            if (inputElement.value.replace(/\D/g, '') !== normalized) {
                inputElement.value = normalized;
            }
            inputElement.setCustomValidity('');
            return true;
        }

        let message = 'Enter a valid PH mobile number (9XXXXXXXXX or 09XXXXXXXXX).';
        const digits = inputElement.value.replace(/\D/g, '');
        if (digits.startsWith('06') || digits.startsWith('08')) {
            message = 'Philippine mobile numbers start with 09, not 06 or 08.';
        }

        inputElement.setCustomValidity(message);
        if (!quiet) {
            inputElement.classList.add('border-danger', 'is-invalid');
        }
            return false;
    }

    getStudentsRequestParams() {
        const params = {
            action: 'list',
            paginated: 1,
            page: this.studentsPage,
            per_page: this.studentsPerPage,
        };
        const values = {
            program_id: document.getElementById('filterProgram')?.value || '',
            year_level_id: document.getElementById('filterYearLevel')?.value || '',
            modality: document.getElementById('filterModality')?.value || '',
            status_id: document.getElementById('filterStudentStatus')?.value || '',
            search: document.getElementById('searchStudents')?.value.trim() || '',
        };
        Object.entries(values).forEach(([key, value]) => {
            if (value !== '') params[key] = value;
        });
        return params;
    }

    async fetchStudents() {
        const requestId = ++this._studentsRequestId;
        try {
            const data = await ApiService.get('/masterfiles/masterfiles-students.php', this.getStudentsRequestParams());
            if (requestId !== this._studentsRequestId) return null;
            if (data?.success === false) {
                console.error('Students list:', data.message || 'Request failed');
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', data.message || 'Could not load students.', 'error');
                return [];
            }
            if (data && Array.isArray(data.rows)) {
                this.cachedRows = data.rows;
                const pagination = data.pagination || {};
                this.studentsPage = Number(pagination.page || this.studentsPage || 1);
                this.studentsPerPage = Number(pagination.perPage || this.studentsPerPage || 10);
                this.studentsTotal = Number(pagination.total || 0);
                this.studentsTotalPages = Math.max(1, Number(pagination.totalPages || 1));
                return data.rows;
            }
            console.error('Students list: unexpected response', data);
            return [];
        } catch (err) {
            console.error('Students list error:', err);
            const msg = err?.response?.data?.message || err?.message || 'Could not load students.';
            // eslint-disable-next-line no-undef
            Swal && Swal.fire('Error', msg, 'error');
            return [];
        }
    }

    getStudentsTableResponsive() {
        return document.querySelector('#studentsTablePanel .table-responsive')
            || document.querySelector('#studentsTable')?.closest('.table-responsive');
    }

    destroyStudentsTable() {
        if (this.tableObserver) {
            this.tableObserver.disconnect();
            this.tableObserver = null;
        }
        if (this.table && typeof this.table.destroy === 'function') {
            try {
                this.table.destroy();
            } catch (_) {
                /* ignore */
            }
        }
        this.table = null;

        const tableResponsive = this.getStudentsTableResponsive();
        const cardBody = tableResponsive?.closest('.card-body');
        cardBody?.querySelectorAll('.datatable-wrapper').forEach((node) => node.remove());
        cardBody?.querySelectorAll('.datatable-pagination').forEach((node) => node.remove());
        cardBody?.querySelectorAll('.datatable-top, .datatable-bottom').forEach((node) => node.remove());

        if (tableResponsive) {
            tableResponsive.innerHTML = `
                <table id="studentsTable" class="table table-hover table-sm align-middle" style="width:100%">
                    <tbody></tbody>
                </table>`;
        }
    }

    buildStudentsDataset(rows, includeBulkSelection = false) {
        const toCenter = (val) => `<span class="d-block text-center">${val ?? ''}</span>`;
        return (rows || []).map((r) => {
            const studentId = Number(r.id || r.student_id || 0);
            const name = `${r.first_name || ''} ${r.middle_name || ''} ${r.last_name || ''}`.trim();
            let status;
            if (String(r.registration_status || '') === 'pending_finance') {
                status = String(r.is_active) === '1'
                    ? '<span class="badge bg-warning text-dark">Active - Awaiting Balance</span>'
                    : '<span class="badge bg-secondary">Inactive - Awaiting Balance</span>';
            } else {
                status = String(r.is_active) === '1'
                    ? '<span class="badge bg-success">Active</span>'
                    : '<span class="badge bg-secondary">Inactive</span>';
            }
            const modalityText = r.modality_name || r.modality || '';
            const studentStatusText = r.status_name || '';
            const hiddenParts = [modalityText, studentStatusText].filter(Boolean);
            const hiddenSearchText = hiddenParts.length > 0
                ? `<span style="visibility:hidden;position:absolute;width:0;height:0;overflow:hidden;">${hiddenParts.join(' ')}</span>`
                : '';
            const cells = [
                toCenter((r.school_id || '') + hiddenSearchText),
                toCenter(name + hiddenSearchText),
                toCenter((r.program_name || '') + hiddenSearchText),
                toCenter((r.department_name || '-') + hiddenSearchText),
                toCenter(escapeHtml(r.internal_scholarship_code || 'None') + hiddenSearchText),
                toCenter(escapeHtml(r.external_scholarship_codes || 'None') + hiddenSearchText),
                toCenter((r.campus_name || '-') + hiddenSearchText),
                toCenter(status + hiddenSearchText),
                `<span class="d-inline-flex justify-content-center w-100">${this.renderStudentActions(r)}</span>`
            ];
            if (includeBulkSelection) {
                cells.unshift(`<span class="d-flex justify-content-center student-select-col"><input class="form-check-input student-select-checkbox" type="checkbox" data-student-id="${studentId}" aria-label="Select ${escapeHtml(name || r.school_id || 'student')}"${studentId > 0 ? '' : ' disabled'}></span>`);
            }
            return cells;
        });
    }

    bindStatCards() {
        const modalEl = document.getElementById('studentsListModal');
        const show = () => {
            if (!modalEl) return;
            // eslint-disable-next-line no-undef
            const m = bootstrap.Modal.getOrCreateInstance(modalEl);
            m.show();
        };
        const setTitle = (t) => { const el = document.getElementById('studentsModalTitle'); if (el) el.textContent = t; };
        const tbody = document.getElementById('studentsModalTableBody');
        const thead = document.querySelector('#studentsListModal thead');

        const renderStudents = (rows) => {
            if (!tbody) return;
            tbody.innerHTML = (rows || []).map(r => {
                const name = `${r.first_name || ''} ${r.middle_name || ''} ${r.last_name || ''}`.trim();
                const studentStatus = r.status_name || 'N/A';
                const statusBadge = studentStatus.toLowerCase() === 'new' 
                    ? '<span class="badge bg-primary">New</span>' 
                    : studentStatus.toLowerCase() === 'continuing'
                    ? '<span class="badge bg-success">Continuing</span>'
                    : `<span class="badge bg-secondary">${escapeHtml(studentStatus)}</span>`;
                return `<tr>
                    <td class="text-center">${escapeHtml(r.school_id || '')}</td>
                    <td class="text-center">${escapeHtml(name)}</td>
                    <td class="text-center">${escapeHtml(r.program_name || '')}</td>
                    <td class="text-center">${statusBadge}</td>
                </tr>`;
            }).join('');
        };

        const cards = document.querySelectorAll('#studentsPanel [data-view]');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const view = card.getAttribute('data-view');
                const rows = Array.isArray(this.cachedRows) ? this.cachedRows : [];
                if (thead) thead.innerHTML = '<tr><th class="text-center">School ID</th><th class="text-center">Name</th><th class="text-center">Program</th><th class="text-center">Status</th></tr>';
                if (view === 'allStudents') {
                    setTitle('All Students');
                    renderStudents(rows);
                } else if (view === 'studentStatus') {
                    setTitle('Student Status (New & Continuing)');
                    const statusStudents = rows.filter(r => {
                        const status = String(r.status_name || '').toLowerCase();
                        return status === 'new' || status === 'continuing';
                    });
                    renderStudents(statusStudents);
                } else if (view === 'newStudents') {
                    setTitle('New Students');
                    renderStudents(rows.filter(r => String(r.status_name || '').toLowerCase() === 'new'));
                } else if (view === 'continuingStudents') {
                    setTitle('Continuing Students');
                    renderStudents(rows.filter(r => String(r.status_name || '').toLowerCase() === 'continuing'));
                } else if (view === 'studentsByProgram') {
                    setTitle('Students by Program');
                    if (thead) thead.innerHTML = '<tr><th class="text-center">Program</th><th class="text-center">Students</th></tr>';
                    if (tbody) {
                        const programCounts = new Map();
                        rows.forEach(r => {
                            const progName = r.program_name || 'Unknown';
                            programCounts.set(progName, (programCounts.get(progName) || 0) + 1);
                        });
                        const list = Array.from(programCounts.entries())
                            .map(([program, count]) => ({ program, count }))
                            .sort((a, b) => String(a.program).localeCompare(String(b.program)));
                        tbody.innerHTML = (list || []).map(r => `
                            <tr>
                                <td class="text-center">${escapeHtml(r.program || '')}</td>
                                <td class="text-center">${escapeHtml(r.count || 0)}</td>
                            </tr>
                        `).join('');
                        if (!list || list.length === 0) {
                            tbody.innerHTML = '<tr><td class="text-center" colspan="2">No data</td></tr>';
                        }
                    }
                    show();
                } else if (view === 'activeStudents') {
                    setTitle('Active Students');
                    renderStudents(rows.filter(r => String(r.is_active) === '1'));
                } else if (view === 'inactiveStudents') {
                    setTitle('Inactive Students');
                    renderStudents(rows.filter(r => String(r.is_active) === '0'));
                } else {
                    setTitle('Students');
                    renderStudents(rows);
                }
                if (view !== 'studentsByProgram') {
                    show();
                }
            });
        });
    }

    async loadCounts() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'counts' });
            if (res?.success !== false) {
                this.hydrateCounts(res);
            }
        } catch (_) {
            // graceful fallback
        }
    }

    hydrateCounts(src) {
        const { totalStudents, newStudents, continuingStudents, pendingRegistrations, activeStudents } = src || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val ?? 0);
        };
        set('statTotalStudents', totalStudents ?? 0);
        set('statNewStudents', newStudents ?? 0);
        set('statContinuingStudents', continuingStudents ?? 0);
        set('statActiveStudents', activeStudents ?? 0);
        this.updatePendingBadge(pendingRegistrations ?? this.pendingRows?.length ?? 0);
    }

    hydratePendingCounts() {
        const rows = Array.isArray(this.pendingRows) ? this.pendingRows : [];
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val ?? 0);
        };
        set('statPendingTotal', rows.length);
        const yearLevelIds = new Set(rows.map((r) => r.year_level_id).filter(Boolean));
        const campusIds = new Set(rows.map((r) => r.campus_id).filter(Boolean));
        const programIds = new Set(rows.map((r) => r.program_id).filter(Boolean));
        set('statPendingYearLevels', yearLevelIds.size);
        set('statPendingCampuses', campusIds.size);
        set('statPendingPrograms', programIds.size);
        this.updatePendingBadge(rows.length);
    }

    bindPendingStatCards() {
        const modalEl = document.getElementById('pendingRegistrationStatsModal');
        const titleEl = document.getElementById('pendingRegistrationStatsModalTitle');
        const iconEl = document.getElementById('pendingRegistrationStatsModalIcon');
        const headEl = document.getElementById('pendingRegistrationStatsModalHead');
        const bodyEl = document.getElementById('pendingRegistrationStatsModalBody');
        if (!modalEl || !titleEl || !iconEl || !headEl || !bodyEl) return;

        const render = (title, icon, headers, rows) => {
            titleEl.textContent = title;
            iconEl.className = `bi ${icon} me-2`;
            headEl.innerHTML = `<tr>${headers.map((header) => `<th class="text-center">${header}</th>`).join('')}</tr>`;
            bodyEl.innerHTML = rows.length
                ? rows.map((cells) => `<tr>${cells.map((cell) => `<td class="text-center">${cell}</td>`).join('')}</tr>`).join('')
                : `<tr><td colspan="${headers.length}" class="text-center text-muted">No records</td></tr>`;
            // eslint-disable-next-line no-undef
            bootstrap.Modal.getOrCreateInstance(modalEl).show();
        };

        const summarize = (rows, field) => {
            const groups = new Map();
            rows.forEach((row) => {
                const key = String(row[field] || 'Not set');
                groups.set(key, (groups.get(key) || 0) + 1);
            });
            return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        };

        document.querySelectorAll('#pendingPanel [data-pending-view]').forEach((card) => {
            if (card.dataset.bound) return;
            card.dataset.bound = '1';
            card.addEventListener('click', () => {
                const rows = Array.isArray(this.pendingRows) ? this.pendingRows : [];
                const view = card.dataset.pendingView;
                if (view === 'uniqueYearLevels') {
                    render('Year Levels', 'bi-mortarboard-fill', ['Year Level', 'Pending Registrations'], summarize(rows, 'year_level_name').map(([name, count]) => [escapeHtml(name), count]));
                } else if (view === 'uniqueCampuses') {
                    render('Campuses', 'bi-geo-alt-fill', ['Campus', 'Pending Registrations'], summarize(rows, 'campus_name').map(([name, count]) => [escapeHtml(name), count]));
                } else if (view === 'uniquePrograms') {
                    render('Programs', 'bi-journal-bookmark-fill', ['Program', 'Pending Registrations'], summarize(rows, 'program_name').map(([name, count]) => [escapeHtml(name), count]));
                } else {
                    render('All Pending', 'bi-hourglass-split', ['School ID', 'Name', 'Program', 'Year Level'], rows.map((row) => [
                        escapeHtml(row.school_id || '-'),
                        escapeHtml([row.last_name, row.first_name].filter(Boolean).join(', ') || '-'),
                        escapeHtml(row.program_name || '-'),
                        escapeHtml(row.year_level_name || '-'),
                    ]));
                }
            });
        });
    }

    updatePendingBadge(count) {
        const badge = document.getElementById('pendingRegistrationsBadge');
        const n = Number(count) || 0;
        if (badge) {
            badge.textContent = String(n);
            badge.classList.toggle('d-none', n <= 0);
        }
        document.querySelectorAll('.sidebar-live-count[data-live-count-path="pendingRegistrations"]').forEach((sidebarBadge) => {
            sidebarBadge.textContent = n > 99 ? '99+' : String(n);
            sidebarBadge.setAttribute('title', `${n} pending registrations`);
            sidebarBadge.setAttribute('aria-label', `${n} pending registrations`);
        });
    }

    bindRegistrationTabs() {
        document.getElementById('pendingPerPage')?.addEventListener('change', (event) => {
            this.pendingPerPage = parseInt(event.target.value, 10) || 10;
            this.pendingPage = 1;
            this.renderPendingRegistrations();
        });
        document.getElementById('pendingPagination')?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            this.pendingPage = Number(button.dataset.page);
            this.renderPendingRegistrations();
        });
        const pendingTab = document.getElementById('pending-tab');
        if (pendingTab) {
            pendingTab.addEventListener('shown.bs.tab', () => this.loadPendingRegistrations());
        }
        const refreshPendingBtn = document.getElementById('refreshPendingBtn');
        if (refreshPendingBtn) {
            refreshPendingBtn.addEventListener('click', () => this.refreshStudentsPage());
        }
        const exportPendingBtn = document.getElementById('exportPendingBtn');
        if (exportPendingBtn) {
            exportPendingBtn.addEventListener('click', () => this.exportPendingRegistrations());
        }
        const searchPending = document.getElementById('searchPending');
        if (searchPending) {
            searchPending.addEventListener('input', (e) => {
                this.pendingSearchTerm = e.target.value || '';
                const mobile = document.getElementById('searchPendingMobile');
                if (mobile) mobile.value = this.pendingSearchTerm;
                this.pendingPage = 1;
                this.renderPendingRegistrations();
            });
        }
        const searchPendingMobile = document.getElementById('searchPendingMobile');
        if (searchPendingMobile) {
            searchPendingMobile.addEventListener('input', (e) => {
                this.pendingSearchTerm = e.target.value || '';
                if (searchPending) searchPending.value = this.pendingSearchTerm;
                this.pendingPage = 1;
                this.renderPendingRegistrations();
            });
        }

        const applyPendingFilters = () => {
            this.pendingPage = 1;
            this.renderPendingRegistrations();
        };
        const filterPendingProgram = document.getElementById('filterPendingProgram');
        const filterPendingYearLevel = document.getElementById('filterPendingYearLevel');
        if (filterPendingProgram) filterPendingProgram.addEventListener('change', applyPendingFilters);
        if (filterPendingYearLevel) filterPendingYearLevel.addEventListener('change', applyPendingFilters);

        const applyPendingMobileFiltersBtn = document.getElementById('applyPendingMobileFiltersBtn');
        if (applyPendingMobileFiltersBtn) {
            applyPendingMobileFiltersBtn.addEventListener('click', () => {
                const programMobile = document.getElementById('filterPendingProgramMobile');
                const yearLevelMobile = document.getElementById('filterPendingYearLevelMobile');
                const programDesktop = document.getElementById('filterPendingProgram');
                const yearLevelDesktop = document.getElementById('filterPendingYearLevel');
                if (programMobile && programDesktop) programDesktop.value = programMobile.value;
                if (yearLevelMobile && yearLevelDesktop) yearLevelDesktop.value = yearLevelMobile.value;
                applyPendingFilters();
                const mobileDropdown = document.getElementById('mobileFilterPendingBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }

        const pendingBody = document.getElementById('pendingRegistrationsBody');
        if (pendingBody && !this._pendingBodyBound) {
            this._pendingBodyBound = true;
            pendingBody.addEventListener('click', (e) => {
                const target = e.target;
                if (!(target instanceof Element)) return;

                const approveLink = target.closest('[data-approve-registration]');
                if (approveLink) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.approveRegistration(parseInt(approveLink.getAttribute('data-approve-registration'), 10));
                    return;
                }
                const rejectLink = target.closest('[data-reject-registration]');
                if (rejectLink) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.rejectRegistration(parseInt(rejectLink.getAttribute('data-reject-registration'), 10));
                    return;
                }

                if (target.closest(INLINE_ACTION_IGNORE)) return;
                const tr = target.closest('tr[data-pending-id]');
                if (!tr) return;
                const row = this.getPendingRowById(tr.getAttribute('data-pending-id'));
                if (!row) return;
                this.openViewModal(row, { isPending: true });
            });
        }
    }

    applyInitialTabFromUrl() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('tab') !== 'pending') return;

        const pendingTab = document.getElementById('pending-tab');
        if (!pendingTab || !window.bootstrap?.Tab) return;

        window.bootstrap.Tab.getOrCreateInstance(pendingTab).show();
    }

    getFilteredPendingRows() {
        const q = String(this.pendingSearchTerm || '').toLowerCase().trim();
        const programSel = document.getElementById('filterPendingProgram');
        const yearLevelSel = document.getElementById('filterPendingYearLevel');
        let rows = Array.isArray(this.pendingRows) ? [...this.pendingRows] : [];

        if (programSel && programSel.value) {
            const programId = String(programSel.value);
            rows = rows.filter((r) => String(r.program_id) === programId);
        }
        if (yearLevelSel && yearLevelSel.value) {
            const yearLevelId = String(yearLevelSel.value);
            rows = rows.filter((r) => String(r.year_level_id) === yearLevelId);
        }

        if (!q) return rows;
        return rows.filter((r) => {
            const name = `${r.first_name || ''} ${r.middle_name || ''} ${r.last_name || ''}`.trim().toLowerCase();
            const haystack = [
                r.school_id,
                name,
                r.program_name,
                r.year_level_name,
                r.email,
                r.personal_email,
                r.created_at
            ].map((v) => String(v || '').toLowerCase());
            return haystack.some((v) => v.includes(q));
        });
    }

    getPendingRowById(id) {
        const key = String(id || '');
        if (!key) return null;
        return this.pendingRows.find((r) => String(r.id) === key) || null;
    }

    async loadPendingRegistrations() {
        try {
            const res = await ApiService.get('/masterfiles/masterfiles-students.php', { action: 'list_pending' });
            this.pendingRows = Array.isArray(res?.rows) ? res.rows : [];
            this.hydratePendingCounts();
            this.renderPendingRegistrations();
        } catch (_) {
            this.pendingRows = [];
            this.hydratePendingCounts();
            this.renderPendingRegistrations();
        }
    }

    renderPendingRegistrations() {
        const tbody = document.getElementById('pendingRegistrationsBody');
        if (!tbody) return;
        const filteredRows = this.getFilteredPendingRows();
        const total = filteredRows.length;
        const pages = Math.max(1, Math.ceil(total / this.pendingPerPage));
        this.pendingPage = Math.min(Math.max(1, this.pendingPage), pages);
        const start = total ? (this.pendingPage - 1) * this.pendingPerPage : 0;
        const end = Math.min(start + this.pendingPerPage, total);
        const info = document.getElementById('pendingPageInfo');
        if (info) info.textContent = `Showing ${total ? start + 1 : 0} to ${end} of ${total} entries`;
        const nav = document.getElementById('pendingPagination');
        if (nav) {
            const numbers = pages <= 7 ? Array.from({ length: pages }, (_, index) => index + 1)
                : [...new Set([1, this.pendingPage - 1, this.pendingPage, this.pendingPage + 1, pages]
                    .filter((number) => number >= 1 && number <= pages))].sort((a, b) => a - b);
            const buttons = [];
            let previous = 0;
            for (const number of numbers) {
                if (previous && number > previous + 1) buttons.push('<span class="px-1 text-muted">…</span>');
                buttons.push(`<button type="button" class="btn btn-sm ${number === this.pendingPage ? 'btn-success' : 'btn-outline-secondary'}" data-page="${number}" ${number === this.pendingPage ? 'aria-current="page"' : ''}>${number}</button>`);
                previous = number;
            }
            nav.innerHTML = pages <= 1 ? '' : `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.pendingPage - 1}" ${this.pendingPage === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.pendingPage + 1}" ${this.pendingPage === pages ? 'disabled' : ''}>Next</button>`;
        }
        if (!this.pendingRows.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No pending registrations</td></tr>';
            return;
        }
        if (!filteredRows.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No matching pending registrations</td></tr>';
            return;
        }
        tbody.innerHTML = filteredRows.slice(start, end).map((row) => {
            const name = escapeHtml([row.last_name, row.first_name].filter(Boolean).join(', '));
            const email = escapeHtml(row.email || row.personal_email || '-');
            const submitted = escapeHtml(this.formatSubmittedDate(row.created_at));
            
            // Fraud detection warning badge
            let warningBadge = '';
            if (row.is_suspicious == 1 && row.suspicious_details) {
                const details = row.suspicious_details || {};
                const confidence = details.confidence || 'medium';
                const riskScore = details.risk_score || 0;
                const reasons = details.reasons || [];
                
                // Color code by confidence level
                let badgeClass = 'bg-warning text-dark';
                let icon = 'exclamation-triangle-fill';
                if (confidence === 'high' || riskScore >= 70) {
                    badgeClass = 'bg-danger text-white';
                    icon = 'shield-fill-exclamation';
                } else if (confidence === 'low' || riskScore < 40) {
                    badgeClass = 'bg-info text-white';
                    icon = 'info-circle-fill';
                }
                
                const reasonsPreview = reasons.slice(0, 2).join('; ');
                const tooltipText = reasonsPreview || 'AI flagged as suspicious';
                
                warningBadge = `
                    <span class="badge ${badgeClass} d-inline-flex align-items-center gap-1 fraud-warning-badge" 
                          data-student-id="${row.id}"
                          data-bs-toggle="tooltip" 
                          data-bs-placement="top" 
                          title="${escapeHtml(tooltipText)}"
                          style="cursor: pointer; font-size: 0.75rem;">
                        <i class="bi bi-${icon}"></i>
                        AI FLAGGED
                    </span>
                `;
            }
            
            return `<tr data-pending-id="${row.id}" class="masterfiles-row-clickable">
                <td class="text-center">${escapeHtml(row.school_id || '')} ${warningBadge}</td>
                <td class="text-center">${name}</td>
                <td class="text-center">${escapeHtml(row.program_name || '')}</td>
                <td class="text-center">${escapeHtml(row.year_level_name || '')}</td>
                <td class="text-center">${email}</td>
                <td class="text-center">${submitted}</td>
                <td class="text-center">
                    ${pendingRegistrationActions(row.id)}
                </td>
            </tr>`;
        }).join('');
        
        // Initialize Bootstrap tooltips for fraud badges
        const tooltipTriggerList = tbody.querySelectorAll('[data-bs-toggle="tooltip"]');
        // eslint-disable-next-line no-undef
        if (typeof bootstrap !== 'undefined') {
            // eslint-disable-next-line no-undef
            [...tooltipTriggerList].forEach(el => new bootstrap.Tooltip(el));
        }
        
        // Bind click events to fraud badges to show detailed modal
        tbody.querySelectorAll('.fraud-warning-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent row click
                const studentId = badge.dataset.studentId;
                this.showFraudDetailsModal(studentId);
            });
        });
    }

    showFraudDetailsModal(studentId) {
        const row = this.pendingRows.find(r => String(r.id) === String(studentId));
        if (!row || !row.is_suspicious || !row.suspicious_details) {
            return;
        }
        
        const details = row.suspicious_details;
        const name = `${row.first_name || ''} ${row.middle_name || ''} ${row.last_name || ''}`.trim();
        const confidence = details.confidence || 'unknown';
        const riskScore = details.risk_score || 0;
        const reasons = details.reasons || [];
        const recommendation = details.recommendation || 'review';
        const checkedAt = details.checked_at || '';
        const provider = details.provider || 'Gemini AI';
        const duplicateChecks = details.duplicate_checks || {};
        
        // Build confidence badge
        let confidenceBadge = '';
        if (confidence === 'high' || riskScore >= 70) {
            confidenceBadge = '<span class="badge bg-danger">High Risk</span>';
        } else if (confidence === 'medium' || riskScore >= 40) {
            confidenceBadge = '<span class="badge bg-warning text-dark">Medium Risk</span>';
        } else {
            confidenceBadge = '<span class="badge bg-info">Low Risk</span>';
        }
        
        // Build recommendation badge
        let recommendationBadge = '';
        if (recommendation === 'reject') {
            recommendationBadge = '<span class="badge bg-danger">AI Recommends: Reject</span>';
        } else if (recommendation === 'review') {
            recommendationBadge = '<span class="badge bg-warning text-dark">AI Recommends: Manual Review</span>';
        } else {
            recommendationBadge = '<span class="badge bg-success">AI Recommends: Approve</span>';
        }
        
        // Build reasons list
        const reasonsList = reasons.length > 0 
            ? reasons.map(r => `<li class="mb-2"><i class="bi bi-exclamation-circle text-warning me-2"></i>${escapeHtml(r)}</li>`).join('')
            : '<li class="text-muted">No specific reasons provided</li>';
        
        // Build duplicate checks section
        let duplicateSection = '';
        if (Object.keys(duplicateChecks).length > 0) {
            const dupItems = [];
            if (duplicateChecks.recent_registrations_count !== undefined) {
                const count = duplicateChecks.recent_registrations_count;
                const icon = count > 5 ? 'exclamation-triangle text-danger' : 'info-circle text-muted';
                dupItems.push(`<li><i class="bi bi-${icon} me-2"></i><strong>Recent registrations (24h):</strong> ${count}</li>`);
            }
            if (duplicateChecks.duplicate_contact_number !== undefined) {
                const isDup = duplicateChecks.duplicate_contact_number;
                const icon = isDup ? 'exclamation-triangle text-danger' : 'check-circle text-success';
                dupItems.push(`<li><i class="bi bi-${icon} me-2"></i><strong>Duplicate contact number:</strong> ${isDup ? 'YES' : 'No'}</li>`);
            }
            if (duplicateChecks.duplicate_personal_email !== undefined) {
                const isDup = duplicateChecks.duplicate_personal_email;
                const icon = isDup ? 'exclamation-triangle text-danger' : 'check-circle text-success';
                dupItems.push(`<li><i class="bi bi-${icon} me-2"></i><strong>Duplicate personal email:</strong> ${isDup ? 'YES' : 'No'}</li>`);
            }
            
            if (dupItems.length > 0) {
                duplicateSection = `
                    <div class="mb-3">
                        <h6 class="mb-2"><i class="bi bi-clipboard-data me-2"></i>Duplicate Detection</h6>
                        <ul class="list-unstyled mb-0">${dupItems.join('')}</ul>
                    </div>
                `;
            }
        }
        
        // Build modal content
        const modalContent = `
            <div class="modal fade" id="fraudDetailsModal" tabindex="-1" aria-labelledby="fraudDetailsModalLabel" aria-hidden="true">
                <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
                    <div class="modal-content">
                        <div class="modal-header bg-success text-white">
                            <h5 class="modal-title" id="fraudDetailsModalLabel">
                                AI Fraud Detection Analysis
                            </h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body">
                            <div class="alert alert-warning d-flex align-items-start gap-2 mb-3">
                                <i class="bi bi-info-circle-fill"></i>
                                <div>
                                    <strong>Important:</strong> This analysis is AI-generated and should be used as a guide only. 
                                    Human judgment is required for final approval/rejection decisions.
                                </div>
                            </div>
                            
                            <div class="mb-3">
                                <h6 class="text-success fw-bold mb-2">Student Information</h6>
                                <ul class="list-unstyled mb-0">
                                    <li><strong>Name:</strong> ${escapeHtml(name)}</li>
                                    <li><strong>School ID:</strong> ${escapeHtml(row.school_id || '-')}</li>
                                    <li><strong>Email:</strong> ${escapeHtml(row.email || row.personal_email || '-')}</li>
                                    <li><strong>Program:</strong> ${escapeHtml(row.program_name || '-')}</li>
                                    <li><strong>Year Level:</strong> ${escapeHtml(row.year_level_name || '-')}</li>
                                </ul>
                            </div>
                            
                            <div class="mb-3">
                                <h6 class="text-success fw-bold mb-2">Risk Assessment</h6>
                                <div class="d-flex align-items-center gap-3 mb-2">
                                    <div>
                                        <strong>Risk Score:</strong> 
                                        <span class="fs-4 fw-bold text-${riskScore >= 70 ? 'danger' : riskScore >= 40 ? 'warning' : 'info'}">${riskScore}/100</span>
                                    </div>
                                    <div>${confidenceBadge}</div>
                                </div>
                                <div class="progress mb-2" style="height: 20px;">
                                    <div class="progress-bar bg-${riskScore >= 70 ? 'danger' : riskScore >= 40 ? 'warning' : 'info'}" 
                                         role="progressbar" 
                                         style="width: ${riskScore}%;" 
                                         aria-valuenow="${riskScore}" 
                                         aria-valuemin="0" 
                                         aria-valuemax="100">${riskScore}%</div>
                                </div>
                                <div>${recommendationBadge}</div>
                            </div>
                            
                            <div class="mb-3">
                                <h6 class="text-success fw-bold mb-2">Detected Issues</h6>
                                <ul class="list-unstyled mb-0">${reasonsList}</ul>
                            </div>
                            
                            ${duplicateSection}
                            
                            <div class="mb-0">
                                <small class="text-muted">
                                    <i class="bi bi-clock me-1"></i>
                                    Analysis performed: ${checkedAt ? new Date(checkedAt).toLocaleString() : 'Unknown'}
                                    <br>
                                    <i class="bi bi-robot me-1"></i>
                                    Provider: ${escapeHtml(provider)}
                                </small>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            <button type="button" class="btn btn-danger" data-bs-dismiss="modal" onclick="masterfilesStudentsModule.rejectPendingRegistration(${studentId})">
                                Reject Registration
                            </button>
                            <button type="button" class="btn btn-success" data-bs-dismiss="modal" onclick="masterfilesStudentsModule.approvePendingRegistration(${studentId})">
                                Approve Anyway
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Remove existing modal if any
        const existing = document.getElementById('fraudDetailsModal');
        if (existing) {
            existing.remove();
        }
        
        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalContent);
        
        // Show modal
        // eslint-disable-next-line no-undef
        const modalEl = document.getElementById('fraudDetailsModal');
        // eslint-disable-next-line no-undef
        const modal = new bootstrap.Modal(modalEl);
        modal.show();
        
        // Clean up when modal is hidden
        modalEl.addEventListener('hidden.bs.modal', () => {
            modalEl.remove();
        });
    }

    mapPendingRowToExport(row) {
        const fmtDate = (val) => {
            if (!val) return '';
            const date = new Date(val);
            if (Number.isNaN(date.getTime())) {
                return String(val).replace('T', ' ').slice(0, 16);
            }
            return date.toLocaleString();
        };
        const name = [row.last_name, row.first_name].filter(Boolean).join(', ');
        const middle = row.middle_name ? ` ${row.middle_name}` : '';
        return {
            'School ID': row.school_id || '',
            'Name': `${name}${middle}`.trim(),
            'Program': row.program_name || '',
            'Year Level': row.year_level_name || '',
            'School Email': row.email || '',
            'Personal Email': row.personal_email || '',
            'Contact': row.contact_number || '',
            'Campus': row.campus_name || '',
            'Internal Scholarship': row.internal_scholarship_name || row.scholarship_name || '',
            'External Scholarships': row.external_scholarship_names || '',
            ...this.mapFamilyToImportExportFields(row),
            'Submitted': fmtDate(row.created_at),
            'Status': 'Pending Registration',
        };
    }

    async exportPendingRegistrations() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;

        const rows = this.getFilteredPendingRows();
        if (!rows.length) {
            await swal.fire({
                icon: 'warning',
                title: 'No Data',
                text: 'No pending registrations found to export.',
                confirmButtonColor: '#03600f',
            });
            return;
        }

        const result = await swal.fire({
            title: 'Export Pending Registrations',
            input: 'select',
            inputOptions: { csv: 'CSV', xls: 'Excel (.xls)', doc: 'Word (.doc)', pdf: 'PDF (.pdf)' },
            inputValue: 'csv',
            showCancelButton: true,
            confirmButtonText: 'Export',
            cancelButtonText: 'Cancel',
            buttonsStyling: false,
            customClass: {
                confirmButton: 'btn btn-success px-4 me-2',
                cancelButton: 'btn btn-secondary px-4',
            },
        });

        if (!result.isConfirmed) return;

        const exportRows = rows.map((row) => this.mapPendingRowToExport(row));
        const headers = Object.keys(exportRows[0] || {});
        const choice = result.value;
        const stamp = new Date().toISOString().split('T')[0];

        if (choice === 'csv') {
            const csv = '\uFEFF' + this.rowsToCsv(exportRows, headers);
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `pending_registrations_${stamp}.csv`);
            return;
        }

        if (choice === 'xls') {
            const th = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
            const trs = exportRows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), `pending_registrations_${stamp}.xls`);
            return;
        }

        if (choice === 'doc') {
            const th = headers.map((h) => `<th style="border:1px solid #000;padding:5px;">${escapeHtml(h)}</th>`).join('');
            const trs = exportRows.map((r) => `<tr>${headers.map((h) => `<td style="border:1px solid #000;padding:5px;">${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><h2>Pending Registrations</h2><table style="border-collapse:collapse;width:100%;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), `pending_registrations_${stamp}.doc`);
            return;
        }

        if (choice === 'pdf') {
            const pdfHeaders = ['School ID', 'Name', 'Program', 'School Email', 'Contact', 'Submitted', 'Status', 'Family Details'];
            const pdfRows = rows.map((row) => ({
                ...this.mapPendingRowToExport(row),
                'Family Details': (Array.isArray(row.family_details) ? row.family_details : [])
                    .filter((member) => [1, 2, 3].includes(Number(member.relationship_id)))
                    .map((member) => `${({ 1: 'Father', 2: 'Mother', 3: 'Guardian' })[member.relationship_id]}: ${member.name || '-'}, Contact ${member.contact || '-'}`)
                    .join('; '),
            }));
            const th = pdfHeaders.map((h) => `<th style="border:1px solid #333;padding:6px;background:#03600f;color:#fff;">${escapeHtml(h)}</th>`).join('');
            const trs = pdfRows.map((r) => `<tr>${pdfHeaders.map((h) => `<td style="border:1px solid #ccc;padding:6px;overflow-wrap:anywhere;">${escapeHtml(String(r[h] ?? ''))}</td>`).join('')}</tr>`).join('');
            const html = `<html><head><title>Pending Registrations</title><style>@page{size:landscape;margin:12mm}table{table-layout:fixed}</style></head><body><h2>Pending Registrations</h2><table style="border-collapse:collapse;width:100%;font-size:11px;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            const printWin = window.open('', '_blank');
            if (!printWin) {
                await swal.fire({
                    icon: 'error',
                    title: 'Export Failed',
                    text: 'Unable to open print window. Please allow pop-ups for this site.',
                    confirmButtonColor: '#03600f',
                });
                return;
            }
            printWin.document.write(html);
            printWin.document.close();
            printWin.focus();
            printWin.print();
        }
    }

    switchToRegisteredStudentsTab() {
        const registeredTab = document.getElementById('students-tab');
        if (!registeredTab || !window.bootstrap?.Tab) return;
        window.bootstrap.Tab.getOrCreateInstance(registeredTab).show();
    }

    getPendingStudentLabel(studentId) {
        const row = this.getPendingRowById(studentId);
        if (!row) return 'this student';
        const name = [row.last_name, row.first_name].filter(Boolean).join(', ');
        return row.school_id ? `${row.school_id}${name ? ` (${name})` : ''}` : name || 'this student';
    }

    async showPendingAlert(message, icon = 'success') {
        if (typeof Swal === 'undefined') return;
        await Swal.fire({
            icon,
            title: icon === 'success' ? 'Success' : 'Registration Updated',
            text: message,
            confirmButtonText: 'OK',
            confirmButtonColor: '#198754',
        });
    }

    async approveRegistration(studentId) {
        if (!studentId) return;
        const label = this.getPendingStudentLabel(studentId);
        const confirm = await Swal.fire({
            title: 'Approve registration?',
            text: `${label} will be able to sign in immediately. Loan applications will remain unavailable until Assessment sets up their balance.`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#198754',
            cancelButtonColor: '#6c757d',
            confirmButtonText: 'Approve',
            cancelButtonText: 'Cancel',
            reverseButtons: true,
        });
        if (!confirm.isConfirmed) return;
        try {
            const res = await ApiService.post('/masterfiles/masterfiles-students.php', {
                action: 'approve_registration',
                student_id: studentId,
            });
            this.hideModal('viewStudentModal');
            await this.showPendingAlert(res?.message || 'CSDL approved the registration. The student can sign in while awaiting Assessment balance setup.');
            await this.loadPendingRegistrations();
            await this.reloadStudentsTable();
            this.switchToRegisteredStudentsTab();
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Failed',
                text: error?.message || 'Unable to approve registration.',
                confirmButtonColor: '#198754',
            });
        }
    }

    async rejectRegistration(studentId) {
        if (!studentId) return;
        const label = this.getPendingStudentLabel(studentId);
        const confirm = await Swal.fire({
            title: 'Reject registration?',
            text: `${label} will not be able to sign in, but can submit a new registration.`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#dc3545',
            cancelButtonColor: '#6c757d',
            confirmButtonText: 'Reject',
            cancelButtonText: 'Cancel',
            reverseButtons: true,
        });
        if (!confirm.isConfirmed) return;
        try {
            const res = await ApiService.post('/masterfiles/masterfiles-students.php', {
                action: 'reject_registration',
                student_id: studentId,
            });
            this.hideModal('viewStudentModal');
            await this.showPendingAlert(res?.message || 'Registration rejected.', 'info');
            await this.loadPendingRegistrations();
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Failed',
                text: error?.message || 'Unable to reject registration.',
                confirmButtonColor: '#198754',
            });
        }
    }

    bindToolbar() {
        const addStudentBtn = document.getElementById('addStudentBtn');
        if (addStudentBtn) addStudentBtn.addEventListener('click', () => this.openAddModal());
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => this.refreshStudentsPage());
        const importExportBtn = document.getElementById('importExportBtn');
        if (importExportBtn) importExportBtn.addEventListener('click', () => this.showImportExportDialog());
        this.bindBulkDeleteControls();
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
                const programMobile = document.getElementById('filterProgramMobile');
                const yearLevelMobile = document.getElementById('filterYearLevelMobile');
                const modalityMobile = document.getElementById('filterModalityMobile');
                const studentStatusMobile = document.getElementById('filterStudentStatusMobile');
                
                // Sync mobile filters to desktop filters
                const programDesktop = document.getElementById('filterProgram');
                const yearLevelDesktop = document.getElementById('filterYearLevel');
                const modalityDesktop = document.getElementById('filterModality');
                const studentStatusDesktop = document.getElementById('filterStudentStatus');
                
                if (programMobile && programDesktop) programDesktop.value = programMobile.value;
                if (yearLevelMobile && yearLevelDesktop) yearLevelDesktop.value = yearLevelMobile.value;
                if (modalityMobile && modalityDesktop) modalityDesktop.value = modalityMobile.value;
                if (studentStatusMobile && studentStatusDesktop) studentStatusDesktop.value = studentStatusMobile.value;
                
                // Apply all mobile filter changes with one server request.
                this.applyStudentsTableFilters();
                
                // Close mobile dropdown
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
            });
        }
        
        // Sync mobile search with desktop search
        const searchMobile = document.getElementById('searchStudentsMobile');
        const searchDesktop = document.getElementById('searchStudents');
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

    getFilteredRows() {
        if (!this.cachedRows) return [];
        const programSel = document.getElementById('filterProgram');
        const yearLevelSel = document.getElementById('filterYearLevel');
        const modalitySel = document.getElementById('filterModality');
        const studentStatusSel = document.getElementById('filterStudentStatus');
        const searchEl = document.getElementById('searchStudents');
        
        let filtered = [...this.cachedRows];
        
        // Filter by program
        if (programSel && programSel.value) {
            const programId = String(programSel.value);
            filtered = filtered.filter(r => String(r.program_id) === programId);
        }
        
        // Filter by year level
        if (yearLevelSel && yearLevelSel.value) {
            const yearLevelId = String(yearLevelSel.value);
            filtered = filtered.filter(r => String(r.year_level_id) === yearLevelId);
        }
        
        // Filter by modality
        if (modalitySel && modalitySel.value) {
            const modality = modalitySel.value;
            filtered = filtered.filter(r => r.modality === modality);
        }
        
        // Filter by student status
        if (studentStatusSel && studentStatusSel.value) {
            const statusId = String(studentStatusSel.value);
            filtered = filtered.filter(r => String(r.status_id) === statusId);
        }
        
        // Filter by search text
        if (searchEl && searchEl.value) {
            const searchTerm = searchEl.value.toLowerCase().trim();
            filtered = filtered.filter(r => {
                const schoolId = (r.school_id || '').toLowerCase();
                const firstName = (r.first_name || '').toLowerCase();
                const middleName = (r.middle_name || '').toLowerCase();
                const lastName = (r.last_name || '').toLowerCase();
                const name = `${firstName} ${middleName} ${lastName}`.trim();
                const email = (r.email || '').toLowerCase();
                const personalEmail = (r.personal_email || '').toLowerCase();
                const program = (r.program_name || '').toLowerCase();
                const yearLevel = (r.year_level_name || '').toLowerCase();
                const campus = (r.campus_name || '').toLowerCase();
                return schoolId.includes(searchTerm) ||
                       name.includes(searchTerm) ||
                       email.includes(searchTerm) ||
                       personalEmail.includes(searchTerm) ||
                       program.includes(searchTerm) ||
                       yearLevel.includes(searchTerm) ||
                       campus.includes(searchTerm);
            });
        }
        
        return filtered;
    }

    async reloadStudentsTable() {
        const rows = await this.fetchStudents();
        if (rows === null) return;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await this.buildTable({ skipFetch: true });
    }

    async refreshStudentsPage() {
        if (this.isRefreshingStudentsPage) return;
        this.isRefreshingStudentsPage = true;

        // Refresh should return the user to the latest complete lists, not
        // leave old search terms or filters hiding the refreshed records.
        this.resetStudentsFilters();
        this.resetPendingFilters();

        const refreshButtons = [
            document.getElementById('refreshBtn'),
            document.getElementById('refreshPendingBtn'),
        ].filter(Boolean);
        refreshButtons.forEach((button) => {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.querySelector('.bi-arrow-repeat')?.classList.add('spin');
        });

        try {
            await this.reloadStudentsTable();
            await this.loadPendingRegistrations();
        } finally {
            refreshButtons.forEach((button) => {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                button.querySelector('.bi-arrow-repeat')?.classList.remove('spin');
            });
            this.isRefreshingStudentsPage = false;
        }
    }

    resetStudentsFilters() {
        [
            'filterProgram',
            'filterYearLevel',
            'filterModality',
            'filterStudentStatus',
            'filterProgramMobile',
            'filterYearLevelMobile',
            'filterModalityMobile',
            'filterStudentStatusMobile',
            'searchStudents',
            'searchStudentsMobile',
        ].forEach((id) => {
            const element = document.getElementById(id);
            if (element) element.value = '';
        });
    }

    resetPendingFilters() {
        [
            'filterPendingProgram',
            'filterPendingYearLevel',
            'filterPendingProgramMobile',
            'filterPendingYearLevelMobile',
            'searchPending',
            'searchPendingMobile',
        ].forEach((id) => {
            const element = document.getElementById(id);
            if (element) element.value = '';
        });
        this.pendingSearchTerm = '';
    }

    async buildTable(options = {}) {
        if (!options.skipFetch && !Array.isArray(this.cachedRows)) {
            await this.fetchStudents();
        }

        this.destroyStudentsTable();

        const el = document.getElementById('studentsTable');
        if (!el) return;

        const rows = Array.isArray(options.rows)
            ? options.rows
            : (this.cachedRows || []);
        this.selectedStudentIds.clear();
        this.currentStudentRows = rows;
        const canBulkDelete = rbacUtil.canDeleteMasterfile('students');
        const dataset = this.buildStudentsDataset(rows, canBulkDelete);
        const headings = ['School ID', 'Name', 'Program', 'Department', 'Internal Scholarship', 'External Scholarships', 'Campus', 'Status', 'Actions'];
        if (canBulkDelete) {
            headings.unshift('<span class="d-flex justify-content-center student-select-col"><input class="form-check-input" type="checkbox" id="selectAllStudents" aria-label="Select all students on this page"></span>');
        }

        // eslint-disable-next-line no-undef
        this.table = new simpleDatatables.DataTable(el, {
            data: {
                headings,
                data: dataset
            },
            searchable: false,
            sortable: false,
            paging: false,
            fixedHeight: false,
            perPage: Math.max(1, rows.length),
            perPageSelect: false,
            info: false,
            columns: canBulkDelete
                ? [{ select: 0, sortable: false }, { select: headings.length - 1, sortable: false }]
                : [{ select: headings.length - 1, sortable: false }]
        });

        if (!this._studentsTableUiBound) {
            this._studentsTableUiBound = true;
            this.bindFilters();
            this.bindPaginationFooter();
        }
        this.movePaginationOutside();
        this.updatePageInfo();
        this.updateBulkDeleteControls();

        const updateRowIndices = () => {
            const tbody = el.querySelector('tbody');
            if (!tbody || !this.table) return;
            Array.from(tbody.rows).forEach((tr, localIdx) => {
                tr.setAttribute('data-row-index', String(localIdx));
            });
        };

        const getRowData = (tr) => {
            if (!tr || !this.cachedRows) return null;
            const checkboxStudentId = Number(tr.querySelector('.student-select-checkbox')?.dataset.studentId || 0);
            if (checkboxStudentId > 0) {
                const byId = this.cachedRows.find((r) => Number(r.id || r.student_id || 0) === checkboxStudentId);
                if (byId) return byId;
            }
                const cells = Array.from(tr.cells);
                if (cells.length > 0) {
                const schoolIdCellIndex = canBulkDelete ? 1 : 0;
                const schoolIdText = cells[schoolIdCellIndex]?.textContent?.trim() || '';
                    const schoolIdKey = (schoolIdText.split(/\s+/)[0] || '').trim();
                if (schoolIdKey) {
                    const bySchoolId = this.cachedRows.findIndex((r) => String(r.school_id || '').trim() === schoolIdKey);
                    if (bySchoolId >= 0) {
                        tr.setAttribute('data-row-index', String(bySchoolId));
                        return this.cachedRows[bySchoolId];
                    }
                }
            }
            let i = parseInt(tr.getAttribute('data-row-index') || '-1', 10);
            if (i >= 0 && i < this.cachedRows.length) {
            return this.cachedRows[i];
            }
            return null;
        };

        const bindStudentsTableRowActions = (tbody) => {
            if (!tbody || tbody.dataset.rowActionsBound === '1') return;
            tbody.dataset.rowActionsBound = '1';

            tbody.addEventListener('click', (ev) => {
                const target = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
                if (!target) return;
                if (target.closest(`${INLINE_ACTION_IGNORE}, .student-select-checkbox, .action-edit, .action-delete, .action-toggle, .action-manage-periods`)) return;
                const tr = target.closest('tr');
                if (!tr) return;
                const row = getRowData(tr);
                if (!row) return;
                this.openViewModal(row);
            });

            tbody.addEventListener('click', (ev) => {
                const target = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
                if (!target) return;
                const tr = target.closest('tr');
                if (!tr) return;
                const row = getRowData(tr);
                if (!row) return;
                if (target.closest('.action-edit')) {
                    ev.preventDefault();
                    this.openEditModal(row);
                } else if (target.closest('.action-manage-periods')) {
                    ev.preventDefault();
                    this.openManagePeriodsModal(row);
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
        };

        const tbody = el.querySelector('tbody');
        if (tbody) {
            updateRowIndices();
            this.tableObserver = new MutationObserver(() => {
                setTimeout(updateRowIndices, 0);
                bindStudentsTableRowActions(tbody);
                this.syncRenderedStudentSelections();
            });
            this.tableObserver.observe(tbody, { childList: true, subtree: false });
            bindStudentsTableRowActions(tbody);
            this.syncRenderedStudentSelections();
        }

    }

    applyStudentsTableFilters() {
        this.studentsPage = 1;
        this.reloadStudentsTable();
    }

    bindFilters() {
        if (this._filtersBound) return;
        this._filtersBound = true;
        const programSel = document.getElementById('filterProgram');
        const yearLevelSel = document.getElementById('filterYearLevel');
        const modalitySel = document.getElementById('filterModality');
        const studentStatusSel = document.getElementById('filterStudentStatus');
        const searchEl = document.getElementById('searchStudents');
        const apply = () => this.applyStudentsTableFilters();
        const applySearch = () => {
            window.clearTimeout(this._studentSearchTimer);
            this._studentSearchTimer = window.setTimeout(apply, 300);
        };
        if (programSel) programSel.addEventListener('change', apply);
        if (yearLevelSel) yearLevelSel.addEventListener('change', apply);
        if (modalitySel) modalitySel.addEventListener('change', apply);
        if (studentStatusSel) studentStatusSel.addEventListener('change', apply);
        if (searchEl) searchEl.addEventListener('input', applySearch);
    }

    bindPaginationFooter() {
        if (this._paginationFooterBound) return;
        this._paginationFooterBound = true;
        const pagination = document.getElementById('studentsPagination');
        const perPageSel = document.getElementById('perPageSelectCustom');
        pagination?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            const page = Number(button.dataset.page);
            if (page < 1 || page > this.studentsTotalPages || page === this.studentsPage) return;
            this.studentsPage = page;
            this.reloadStudentsTable();
        });
        if (perPageSel) perPageSel.addEventListener('change', () => {
            this.studentsPerPage = parseInt(perPageSel.value, 10) || 10;
            this.studentsPage = 1;
            this.reloadStudentsTable();
        });
        this.updatePageInfo();
    }

    updatePageInfo() {
        const infoEl = document.getElementById('pageInfo');
        if (!infoEl) return;
        const total = this.studentsTotal;
        const start = total === 0 ? 0 : (this.studentsPage - 1) * this.studentsPerPage + 1;
        const end = Math.min(this.studentsPage * this.studentsPerPage, total);
        infoEl.textContent = `Showing ${start} to ${end} of ${total} entries`;
        const nav = document.getElementById('studentsPagination');
        if (!nav) return;
        const pages = this.studentsTotalPages;
        if (pages <= 1) {
            nav.innerHTML = '';
            return;
        }
        const numbers = pages <= 7
            ? Array.from({ length: pages }, (_, index) => index + 1)
            : [...new Set([1, this.studentsPage - 1, this.studentsPage, this.studentsPage + 1, pages]
                .filter((page) => page >= 1 && page <= pages))].sort((a, b) => a - b);
        const buttons = [];
        let previous = 0;
        for (const page of numbers) {
            if (previous && page > previous + 1) buttons.push('<span class="px-1 text-muted">…</span>');
            buttons.push(`<button type="button" class="btn btn-sm ${page === this.studentsPage ? 'btn-success' : 'btn-outline-secondary'}" data-page="${page}" ${page === this.studentsPage ? 'aria-current="page"' : ''}>${page}</button>`);
            previous = page;
        }
        nav.innerHTML = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.studentsPage - 1}" ${this.studentsPage === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${this.studentsPage + 1}" ${this.studentsPage === pages ? 'disabled' : ''}>Next</button>`;
    }

    movePaginationOutside() {
        // Only on mobile - move simple-datatables pagination outside table-responsive
        const checkAndMove = () => {
            const tableEl = document.getElementById('studentsTable');
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

    openAddModal() {
        if (!rbacUtil.requireMasterfilePermission('students', 'create', 'create students')) {
            return;
        }

        const title = document.getElementById('studentModalTitle');
        if (title) title.textContent = 'Add Student';
        this.fillForm({});
        this.setFieldsEditable(true);

        const passwordInput = document.getElementById('password');
        const passwordField = document.getElementById('studentPasswordField');
        const toggleIcon = document.getElementById('togglePasswordIcon');
        if (passwordInput) {
            passwordInput.type = 'password';
            passwordInput.value = '';
        }
        if (passwordField) passwordField.classList.remove('d-none');
        if (toggleIcon) {
            toggleIcon.classList.remove('bi-eye');
            toggleIcon.classList.add('bi-eye-slash');
        }

        this.showModal('studentModal');
        const saveBtn = document.getElementById('saveStudentBtn');
        if (saveBtn) saveBtn.onclick = () => this.saveStudent('create');
    }

    openEditModal(row) {
        // Check permission before opening modal
        if (!rbacUtil.requireMasterfilePermission('students', 'edit', 'edit students')) {
            return;
        }
        
        const title = document.getElementById('studentModalTitle');
        if (title) title.textContent = 'Edit Student';
        this.fillForm(row);
        
        // Disable fields that shouldn't be edited
        this.setFieldsEditable(false);

        const passwordField = document.getElementById('studentPasswordField');
        if (passwordField) passwordField.classList.add('d-none');
        
        this.showModal('studentModal');
        const saveBtn = document.getElementById('saveStudentBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.saveStudent('update');
            };
        }
    }

    setFieldsEditable(editable) {
        // Keep the student's School ID fixed when editing an existing record.
        const fieldsToDisable = ['school_id'];
        
        fieldsToDisable.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                if (editable) {
                    field.removeAttribute('readonly');
                    field.removeAttribute('disabled');
                    field.style.backgroundColor = '';
                    field.style.cursor = '';
                } else {
                    field.setAttribute('readonly', 'readonly');
                    field.removeAttribute('disabled');
                    field.style.backgroundColor = '#e9ecef';
                    field.style.cursor = 'not-allowed';
                }
            }
        });
        
        // Profile, academic, and contact details can be corrected in edit mode.
        const editableFields = ['first_name', 'middle_name', 'last_name', 'program_id', 'gender', 'date_of_birth', 'year_level_id', 'status_id', 'contact_number', 'email_local', 'personal_email', 'internal_scholarship_id', 'campus_id', 'modality', 'fb_account'];
        editableFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.removeAttribute('disabled');
                field.removeAttribute('readonly');
                field.style.backgroundColor = '';
                field.style.cursor = '';
            }
        });
    }

    openViewModal(row, options = {}) {
        const isPending = options.isPending === true;
        const name = `${row.first_name || ''} ${row.middle_name || ''} ${row.last_name || ''}`.trim();
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
        
        this.currentViewRow = row;
        
        setText('viewStudentSchoolId', row.school_id);
        setText('viewStudentNameText', name);
        setText('viewStudentStatusText', isPending ? 'Pending Registration' : row.status_name);
        
        const modalityEl = document.getElementById('viewStudentModality');
        if (modalityEl) {
            const modalityText = row.modality_name || row.modality || '-';
            modalityEl.textContent = modalityText;
            modalityEl.className = 'badge bg-success';
        }
        
        const statusEl = document.getElementById('viewStudentStatus');
        if (statusEl) {
            if (isPending) {
                statusEl.textContent = 'Pending Approval';
                statusEl.className = 'badge bg-warning text-dark';
            } else if (String(row.registration_status || '') === 'pending_finance') {
                statusEl.textContent = String(row.is_active) === '1' ? 'Active - Awaiting Balance' : 'Inactive - Awaiting Balance';
                statusEl.className = 'badge bg-warning text-dark';
            } else {
            statusEl.textContent = String(row.is_active) === '1' ? 'Active' : 'Inactive';
            statusEl.className = String(row.is_active) === '1' ? 'badge bg-success' : 'badge bg-secondary';
            }
        }
        
        setText('viewStudentProgramText', row.program_name);
        setText('viewStudentYearLevelText', row.year_level_name);
        setText('viewStudentInternalScholarshipText', row.internal_scholarship_name || row.scholarship_name);
        setText('viewStudentExternalScholarshipsText', row.external_scholarship_names);
        setText('viewStudentCampus', row.campus_name);
        
        setText('viewStudentFirstName', row.first_name);
        setText('viewStudentMiddleName', row.middle_name);
        setText('viewStudentLastName', row.last_name);
        setText('viewStudentGender', row.gender);
        
        setText('viewStudentDateOfBirth', this.formatDateOfBirthDisplay(row.date_of_birth));
        
        setText('viewStudentContact', row.contact_number);
        setText('viewStudentEmail', row.email || '-');
        setText('viewStudentPersonalEmail', row.personal_email || '-');
        setText('viewStudentFbAccount', row.fb_account);
        const familyList = document.getElementById('viewStudentFamilyDetails');
        if (familyList) {
            familyList.replaceChildren();
            const labels = { 1: 'Father', 2: 'Mother', 3: 'Guardian' };
            const members = (Array.isArray(row.family_details) ? row.family_details : [])
                .filter((member) => [1, 2, 3].includes(Number(member.relationship_id)));
            if (!members.length) familyList.textContent = 'No family details recorded';
            members.forEach((member) => {
                const line = document.createElement('div');
                line.className = 'student-family-member';
                const label = document.createElement('span');
                label.className = 'student-family-member-label';
                label.textContent = labels[member.relationship_id] || 'Family member';
                const details = document.createElement('div');
                for (const [partLabel, value] of [['Full Name', member.name || '']]) {
                    const part = document.createElement('div');
                    part.className = 'student-family-member-part';
                    const caption = document.createElement('span');
                    caption.textContent = `${partLabel}: `;
                    const name = document.createElement('strong');
                    name.textContent = value || '-';
                    part.append(caption, name);
                    details.appendChild(part);
                }
                const contact = document.createElement('span');
                contact.className = 'student-family-member-contact';
                contact.textContent = `Contact: ${member.contact || '-'}`;
                line.append(label, details, contact);
                familyList.appendChild(line);
            });
        }
        
        const editBtn = document.getElementById('editStudentFromViewBtn');
        if (editBtn) {
            editBtn.classList.toggle('d-none', isPending);
            if (!editBtn.hasAttribute('data-bound')) {
            editBtn.setAttribute('data-bound', 'true');
            editBtn.addEventListener('click', async () => {
                if (!this.currentViewRow) return;
                const student = this.currentViewRow;
                await this.hideModalAndWait('viewStudentModal');
                this.openEditModal(student);
            });
            }
        }
        
        this.showModal('viewStudentModal');
    }

    fillForm(row) {
        const byId = (id) => document.getElementById(id);
        const setVal = (id, val) => { const el = byId(id); if (el) el.value = val || ''; };
        setVal('student_id', row.id || row.student_id || '');
        setVal('school_id', row.school_id || '');
        setVal('program_id', row.program_id || '');
        setVal('year_level_id', row.year_level_id || '');
        setVal('internal_scholarship_id', row.internal_scholarship_id || row.scholarship_id || '');
        this.setSelectedExternalScholarshipIds(row.external_scholarship_ids || []);
        setVal('first_name', row.first_name || '');
        setVal('middle_name', row.middle_name || '');
        setVal('last_name', row.last_name || '');
        const dobForInput = this.parseFlexibleDate(row.date_of_birth);
        setVal('date_of_birth', (dobForInput && dobForInput !== false) ? dobForInput : (row.date_of_birth || ''));
        setVal('gender', row.gender || 'Male');
        setVal('contact_number', row.contact_number || '');
        setVal('email_local', this.extractPhinmaEdLocalPart(row.email || ''));
        setVal('personal_email', row.personal_email || '');
        setVal('campus_id', row.campus_id || '');
        setVal('modality', row.modality || 'flex');
        setVal('status_id', row.status_id || '1');
        setVal('fb_account', row.fb_account || '');
        this.fillFamilyDetails(row.family_details || []);
    }

    fillFamilyDetails(members) {
        document.querySelectorAll('#studentForm [data-family-member][data-relationship-id]').forEach((row) => {
            const member = members.find((item) => Number(item.relationship_id) === Number(row.dataset.relationshipId));
            row.dataset.familyId = member?.id || '';
            row.querySelector('[data-family-name]').value = member?.name || '';
            row.querySelector('[data-family-contact]').value = member?.contact || '';
        });
    }

    collectStudentFamilyDetails() {
        const members = [];
        let valid = true;
        document.querySelectorAll('#studentForm [data-family-member]').forEach((row) => {
            const nameInput = row.querySelector('[data-family-name]');
            const contactInput = row.querySelector('[data-family-contact]');
            const name = nameInput.value.trim();
            const contact = contactInput.value.trim();
            [nameInput, contactInput].forEach((input) => input.classList.remove('is-invalid'));
            if (!name && !contact) return;
            if (!this.isValidFamilyFullName(name)) {
                nameInput.classList.add('is-invalid');
                valid = false;
            }
            if (!this.isValidPhilippineMobile(contact)) {
                contactInput.classList.add('is-invalid');
                valid = false;
            } else {
                contactInput.value = this.normalizePhilippineMobile(contact);
            }
            members.push({ id: Number(row.dataset.familyId || 0), relationship_id: Number(row.dataset.relationshipId), name, contact: this.normalizePhilippineMobile(contact) });
        });
        return valid ? members : null;
    }

    saveStudent(mode = 'update') {
        if (mode === 'create' && !rbacUtil.requireMasterfilePermission('students', 'create', 'create students')) {
            return;
        }
        if (mode === 'update' && !rbacUtil.requireMasterfilePermission('students', 'edit', 'edit students')) {
            return;
        }
        const form = document.getElementById('studentForm');
        if (!this.validateStudentEmailsBeforeSave()) {
            return;
        }
        if (!form || !form.checkValidity()) {
            form?.reportValidity();
            return;
        }
        const familyDetails = this.collectStudentFamilyDetails();
        if (!familyDetails) {
            form.querySelector('[data-family-member] .is-invalid')?.focus();
            return;
        }

        const byId = (id) => document.getElementById(id);
        const getVal = (id) => {
            const el = byId(id);
            return el ? (el.value || '').trim() : '';
        };
        
        const contactEl = byId('contact_number');
        let contactNumber = getVal('contact_number');
        if (contactNumber) {
            contactNumber = this.normalizePhilippineMobile(contactNumber);
            if (contactEl) contactEl.value = contactNumber;
        }
        if (contactNumber && contactEl && !this.validateContactNumber(contactEl)) {
            contactEl.reportValidity();
            return;
        }

        const data = {
            school_id: getVal('school_id'),
            program_id: getVal('program_id'),
            year_level_id: getVal('year_level_id'),
            internal_scholarship_id: getVal('internal_scholarship_id') || null,
            external_scholarship_ids: this.getSelectedExternalScholarshipIds(),
            first_name: getVal('first_name'),
            middle_name: getVal('middle_name'),
            last_name: getVal('last_name'),
            date_of_birth: getVal('date_of_birth') || null,
            gender: getVal('gender') || 'Male',
            contact_number: contactNumber || null,
            email_local: getVal('email_local') || null,
            personal_email: getVal('personal_email') || null,
            campus_id: getVal('campus_id') || null,
            modality: getVal('modality') || 'flex',
            status_id: getVal('status_id') || '1',
            fb_account: getVal('fb_account') || null
        };
        data.family_details = JSON.stringify(familyDetails);

        if (mode !== 'create') {
            data.student_id = getVal('student_id');
        }

        const url = mode === 'create'
            ? '/masterfiles/masterfiles-students.php?action=create'
            : '/masterfiles/masterfiles-students.php?action=update';

        ApiService.post(url, data)
            .then(async (response) => {
                if (response?.success !== true) {
                    throw new Error(response?.message || 'Could not save student.');
                }
                this.hideModal('studentModal');
                const modalEl = document.getElementById('studentModal');
                if (modalEl) {
                    await new Promise((resolve) => {
                        const done = () => resolve();
                        modalEl.addEventListener('hidden.bs.modal', done, { once: true });
                        setTimeout(done, 400);
                    });
                }
                // eslint-disable-next-line no-undef
                if (window.Swal) {
                    await Swal.fire(
                        'Success',
                        response?.message || `Student ${mode === 'create' ? 'added' : 'updated'} successfully.`,
                        'success'
                    );
                }
                window.location.reload();
            })
            .catch((err) => {
                // eslint-disable-next-line no-undef
                Swal && Swal.fire('Error', err?.response?.data?.message || err?.message || 'Operation failed.', 'error');
            });
    }

    toggleStatus(row) {
        if (!rbacUtil.requireMasterfilePermission('students', 'edit', 'edit students')) {
            return;
        }
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Confirm Status Change',
                text: `Are you sure you want to ${String(row.is_active) === '1' ? 'deactivate' : 'activate'} this student?`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#0a8f1b'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-students.php?action=toggle', { student_id: row.id || row.student_id })
                        .then(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Success', 'Student status updated successfully.', 'success').then(() => window.location.reload());
                        })
                        .catch(() => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Error', 'Failed to update student status.', 'error');
                        });
                }
            });
        }
    }

    confirmDelete(row) {
        // Check permission before deleting
        if (!rbacUtil.requireMasterfilePermission('students', 'delete', 'delete students')) {
            return;
        }
        
        // eslint-disable-next-line no-undef
        if (window.Swal) {
            const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
            // eslint-disable-next-line no-undef
            Swal.fire({
                title: 'Confirm Delete',
                text: `Are you sure you want to delete "${name || row.school_id || 'this student'}"? This action cannot be undone.`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes, delete',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#dc3545'
            }).then((res) => {
                if (res.isConfirmed) {
                    ApiService.post('/masterfiles/masterfiles-students.php?action=delete', { student_id: row.id || row.student_id })
                        .then((response) => {
                            if (response?.success !== true) {
                                throw new Error(response?.message || 'Student could not be deleted.');
                            }
                            // eslint-disable-next-line no-undef
                            Swal.fire('Deleted', 'Student deleted.', 'success').then(() => window.location.reload());
                        })
                        .catch((error) => {
                            // eslint-disable-next-line no-undef
                            Swal.fire('Student Not Deleted', error?.response?.data?.message || error?.message || 'Failed to delete student.', 'error');
                        });
                }
            });
        }
    }

    bindBulkDeleteControls() {
        if (this._bulkDeleteBound) return;
        this._bulkDeleteBound = true;

        const button = document.getElementById('bulkDeleteStudentsBtn');
        const canDelete = rbacUtil.canDeleteMasterfile('students');
        if (button) {
            button.style.display = canDelete ? '' : 'none';
            button.addEventListener('click', () => this.bulkDeleteSelectedStudents());
        }

        const panel = document.getElementById('studentsTablePanel');
        panel?.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;

            if (target.id === 'selectAllStudents') {
                const checked = target.checked;
                this.getRenderedStudentCheckboxes().forEach((checkbox) => {
                    const studentId = Number(checkbox.dataset.studentId || 0);
                    if (!studentId || checkbox.disabled) return;
                    checkbox.checked = checked;
                    if (checked) this.selectedStudentIds.add(studentId);
                    else this.selectedStudentIds.delete(studentId);
                });
                this.updateBulkDeleteControls();
                return;
            }

            if (!target.classList.contains('student-select-checkbox')) return;
            const studentId = Number(target.dataset.studentId || 0);
            if (!studentId) return;
            if (target.checked) this.selectedStudentIds.add(studentId);
            else this.selectedStudentIds.delete(studentId);
            this.updateBulkDeleteControls();
        });

        this.updateBulkDeleteControls();
    }

    getRenderedStudentCheckboxes() {
        return Array.from(document.querySelectorAll('#studentsTable tbody .student-select-checkbox'));
    }

    syncRenderedStudentSelections() {
        this.getRenderedStudentCheckboxes().forEach((checkbox) => {
            const studentId = Number(checkbox.dataset.studentId || 0);
            checkbox.checked = studentId > 0 && this.selectedStudentIds.has(studentId);
        });
        this.updateBulkDeleteControls();
    }

    updateBulkDeleteControls() {
        const count = this.selectedStudentIds.size;
        const countElement = document.getElementById('bulkDeleteStudentsCount');
        const button = document.getElementById('bulkDeleteStudentsBtn');
        if (countElement) countElement.textContent = String(count);
        if (button) button.disabled = count === 0;

        const checkboxes = this.getRenderedStudentCheckboxes().filter((checkbox) => !checkbox.disabled);
        const selectedOnPage = checkboxes.filter((checkbox) => {
            const studentId = Number(checkbox.dataset.studentId || 0);
            return studentId > 0 && this.selectedStudentIds.has(studentId);
        }).length;
        const selectAll = document.getElementById('selectAllStudents');
        if (selectAll) {
            selectAll.disabled = checkboxes.length === 0;
            selectAll.checked = checkboxes.length > 0 && selectedOnPage === checkboxes.length;
            selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < checkboxes.length;
        }
    }

    async bulkDeleteSelectedStudents() {
        if (!rbacUtil.requireMasterfilePermission('students', 'delete', 'delete students')) return;

        const studentIds = Array.from(this.selectedStudentIds);
        if (studentIds.length === 0) return;

        const confirmation = await Swal.fire({
            title: `Delete ${studentIds.length} selected student${studentIds.length === 1 ? '' : 's'}?`,
            text: 'This action cannot be undone. Students linked to other records will be kept and reported.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete Selected',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc3545',
            reverseButtons: false,
        });
        if (!confirmation.isConfirmed) return;

        const button = document.getElementById('bulkDeleteStudentsBtn');
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
        }

        try {
            const response = await ApiService.post('/masterfiles/masterfiles-students.php', {
                action: 'bulk_delete',
                student_ids: studentIds,
            });
            const deletedCount = Number(response?.deleted_count || 0);
            const failed = Array.isArray(response?.failed) ? response.failed : [];

            this.selectedStudentIds.clear();

            if (failed.length > 0) {
                const labels = failed.slice(0, 4).map((item) => `${item.school_id || item.name || `Student ${item.student_id}`}: ${item.reason || 'Could not be deleted'}`);
                const remaining = failed.length - labels.length;
                const failedText = `${labels.join(', ')}${remaining > 0 ? ` and ${remaining} more` : ''}`;
                await Swal.fire({
                    icon: deletedCount > 0 ? 'warning' : 'error',
                    title: deletedCount > 0 ? 'Bulk delete partially completed' : 'Students could not be deleted',
                    text: `${deletedCount} deleted. Could not delete: ${failedText}.`,
                    confirmButtonColor: '#03600f',
                });
            } else {
                await Swal.fire({
                    icon: 'success',
                    title: 'Students Deleted',
                    text: `${deletedCount} student${deletedCount === 1 ? '' : 's'} deleted successfully.`,
                    confirmButtonColor: '#03600f',
                });
            }
            if (deletedCount > 0) window.location.reload();
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Bulk Delete Failed',
                text: error?.response?.data?.message || error?.message || 'Unable to delete the selected students.',
                confirmButtonColor: '#03600f',
            });
        } finally {
            if (button) button.removeAttribute('aria-busy');
            this.updateBulkDeleteControls();
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
        if (!el || !el.classList.contains('show')) return;
        // eslint-disable-next-line no-undef
        const modal = bootstrap.Modal.getInstance(el);
        if (!modal) return;

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
            this.openImportModal();
        } else if (result.isDenied) {
            this.onExportClick();
        }
    }

    openImportModal() {
        const modal = document.getElementById('importStudentsModal');
        if (!modal) return;
        // eslint-disable-next-line no-undef
        const m = bootstrap.Modal.getOrCreateInstance(modal);
        m.show();
        this.resetImportForm();
    }

    resetImportForm() {
        const fileInput = document.getElementById('importFileInput');
        const preview = document.getElementById('importPreview');
        const previewBody = document.getElementById('importPreviewBody');
        const previewCount = document.getElementById('previewCount');
        const importErrors = document.getElementById('importErrors');
        const confirmBtn = document.getElementById('confirmImportBtn');

        if (fileInput) fileInput.value = '';
        if (preview) preview.style.display = 'none';
        if (previewBody) previewBody.innerHTML = '';
        if (previewCount) previewCount.textContent = '0';
        if (importErrors) importErrors.innerHTML = '';
        if (confirmBtn) confirmBtn.disabled = true;
    }

    downloadTemplate() {
        const sample = {
            'School ID': '02-2020-00001',
            'First Name': 'Juan',
            'Middle Name': 'Santos',
            'Last Name': 'Dela Cruz',
            'Program': 'BSIT',
            'Year Level': '1st Year',
            'School Email': 'romeo.joi.coc',
            'Personal Email': 'juan.delacruz@gmail.com',
            'Campus': 'Carmen',
            'Contact Number': '09123456789',
            'Date of Birth': '2005-01-15',
            'Gender': 'Male',
            'Internal Scholarship': '',
            'External Scholarships': '',
            'Modality': 'flex',
            'Student Status': 'New',
            'Facebook Account': '',
            'Father Name': 'Pedro Dela Cruz',
            'Father Contact': '09123456789',
            'Mother Name': 'Maria Dela Cruz',
            'Mother Contact': '09987654321',
            'Guardian Name': '',
            'Guardian Contact': '',
        };
        const csv = '\uFEFF' + this.rowsToCsv([sample], STUDENTS_IMPORT_EXPORT_HEADERS);
        this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'students_import_template.csv');
    }

    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) {
            this.resetImportForm();
            return;
        }

        const preview = document.getElementById('importPreview');
        const previewBody = document.getElementById('importPreviewBody');
        const previewCount = document.getElementById('previewCount');
        const importErrors = document.getElementById('importErrors');
        const confirmBtn = document.getElementById('confirmImportBtn');

        if (!preview || !previewBody || !previewCount || !confirmBtn) return;

        if (file.size > STUDENTS_IMPORT_MAX_FILE_BYTES) {
            event.target.value = '';
            preview.style.display = 'none';
            previewBody.innerHTML = '';
            previewCount.textContent = '0';
            confirmBtn.disabled = true;
            if (importErrors) {
                importErrors.innerHTML = '<div class="alert alert-danger">The selected file exceeds the 250 MB maximum.</div>';
            }
            return;
        }

        const fileSizeMb = (file.size / (1024 * 1024)).toFixed(file.size >= 10 * 1024 * 1024 ? 1 : 2);
        if (file.size > STUDENTS_IMPORT_BROWSER_PREVIEW_BYTES) {
            preview.style.display = 'none';
            previewBody.innerHTML = '';
            previewCount.textContent = '0';
            confirmBtn.disabled = false;
            importErrors.innerHTML = `<div class="alert alert-info mb-0"><strong>Large CSV selected (${fileSizeMb} MB).</strong> Browser preview was skipped to keep the page responsive. Click Import Students to validate and process it on the server. Unknown optional scholarships will be ignored without skipping students, and the import result will report them.</div>`;
            return;
        }

        // Reset preview
        preview.style.display = 'none';
        previewBody.innerHTML = '';
        previewCount.textContent = '0';
        importErrors.innerHTML = '<div class="alert alert-info mb-0">Reading and validating the CSV preview…</div>';
        confirmBtn.disabled = true;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const parsed = this.parseCsvText(e.target.result);
                if (parsed.length < 2) {
                    preview.style.display = 'none';
                    importErrors.innerHTML = '<div class="alert alert-warning">File appears to be empty or invalid.</div>';
                    return;
                }

                const headers = parsed[0];
                const headerMap = this.buildImportHeaderMap(headers);
                const required = ['school_id', 'first_name', 'last_name', 'program', 'year_level'];
                const missing = required.filter((k) => headerMap[k] === undefined);
                if (missing.length > 0) {
                    preview.style.display = 'none';
                    const missingLabels = missing.map((key) => ({
                        school_id: 'School ID',
                        first_name: 'First Name',
                        last_name: 'Last Name',
                        program: 'Program',
                        year_level: 'Year Level',
                    }[key] || key));
                    importErrors.innerHTML = `<div class="alert alert-danger"><strong>The CSV columns do not match the template.</strong><br>Missing: ${escapeHtml(missingLabels.join(', '))}. Download the latest template and copy your data into it.</div>`;
                    return;
                }

                const allRows = [];
                const validationErrors = [];
                const scholarshipLookup = { internal: new Set(), external: new Set() };
                for (const scholarship of this.scholarships) {
                    const type = String(scholarship.scholarship_type || 'Internal').toLowerCase() === 'external' ? 'external' : 'internal';
                    for (const value of [scholarship.scholarship_name, scholarship.scholarship_code]) {
                        if (value) scholarshipLookup[type].add(String(value).trim().toLowerCase());
                    }
                }
                let scholarshipWarningCount = 0;
                const scholarshipWarningExamples = [];
                let omittedContactNumbers = 0;
                let skippedFamilyEntries = 0;
                const skippedFamilyExamples = [];
                for (let i = 1; i < parsed.length; i++) {
                    const record = this.mapCsvRowToImportRecord(parsed[i], headerMap);
                    if (!record.school_id && !record.first_name && !record.last_name) continue;
                    allRows.push(record);
                    validationErrors.push(...this.validateImportRow(record, i + 1));
                    for (const warning of this.getImportScholarshipWarnings(record, i + 1, scholarshipLookup)) {
                        scholarshipWarningCount++;
                        if (scholarshipWarningExamples.length < 5) scholarshipWarningExamples.push(warning);
                    }
                    if (record._omittedContactNumber) omittedContactNumbers++;
                    const skipped = this.getImportableFamilyMembers(record).skipped;
                    skippedFamilyEntries += skipped.length;
                    for (const reason of skipped) {
                        if (skippedFamilyExamples.length < 5) skippedFamilyExamples.push(`Row ${i + 1}: ${reason}`);
                    }
                }

                const previewRows = allRows.slice(0, 10);
                previewBody.innerHTML = previewRows.map((row) => {
                    const school = escapeHtml(row.school_email || row.email || '');
                    const personal = escapeHtml(row.personal_email || '');
                    const familyMembers = this.getImportableFamilyMembers(row);
                    const family = familyMembers.accepted
                        .map(([label, name, contact]) => `<div class="student-import-family-line"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(name || '-')} (${escapeHtml(contact || '-')})</div>`)
                        .join('') + (familyMembers.skipped.length
                            ? `<div class="small text-muted">Skipped: ${escapeHtml(familyMembers.skipped.join(', '))}</div>` : '') || '-';
                    return `<tr>
                        <td>${escapeHtml(row.school_id || '')}</td>
                        <td>${escapeHtml(row.first_name || '')}</td>
                        <td>${escapeHtml(row.middle_name || '')}</td>
                        <td>${escapeHtml(row.last_name || '')}</td>
                        <td>${escapeHtml(row.program || '')}</td>
                        <td>${escapeHtml(row.year_level || '')}</td>
                        <td>${school}</td>
                        <td>${personal}</td>
                        <td>${escapeHtml(row.campus || '')}</td>
                        <td>${escapeHtml(row.internal_scholarship || '')}</td>
                        <td>${escapeHtml(row.external_scholarships || '')}</td>
                        <td>${escapeHtml(row.student_status || '')}</td>
                        <td>${family}</td>
                    </tr>`;
                }).join('');

                previewCount.textContent = String(allRows.length);
                preview.style.display = 'block';
                const skippedFamilyNote = skippedFamilyEntries
                    ? `<div class="small mt-2">${skippedFamilyEntries} optional family entr${skippedFamilyEntries === 1 ? 'y' : 'ies'} without a usable name and mobile number will be omitted. Examples: ${escapeHtml(skippedFamilyExamples.join('; '))}</div>` : '';
                const omittedContactNote = omittedContactNumbers
                    ? `<div class="small mt-2">${omittedContactNumbers} optional student contact number${omittedContactNumbers === 1 ? '' : 's'} could not be used and will be left blank. Existing saved numbers will remain unchanged.</div>` : '';
                const scholarshipNote = scholarshipWarningCount
                    ? `<div class="small mt-2"><strong>${scholarshipWarningCount} unmatched optional scholarship value${scholarshipWarningCount === 1 ? '' : 's'} will be ignored without skipping those students.</strong><ul class="mb-0 mt-1">${scholarshipWarningExamples.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : '';

                if (validationErrors.length > 0) {
                    const list = validationErrors.slice(0, 15).map((err) => `<li>${escapeHtml(err)}</li>`).join('');
                    const more = validationErrors.length > 15
                        ? `<li>... and ${validationErrors.length - 15} more issue(s)</li>`
                        : '';
                    importErrors.innerHTML = `<div class="alert alert-warning"><strong>Some rows have issues.</strong> You may continue; valid rows will be imported and invalid rows will be skipped.<ul class="mb-0 small mt-2">${list}${more}</ul>${omittedContactNote}${skippedFamilyNote}${scholarshipNote}</div>`;
                    confirmBtn.disabled = allRows.length === 0;
                } else if (scholarshipWarningCount > 0) {
                    importErrors.innerHTML = `<div class="alert alert-warning small mb-0"><strong>Student rows can import, but some scholarship values do not match active masterfiles.</strong>${scholarshipNote}${omittedContactNote}${skippedFamilyNote}</div>`;
                    confirmBtn.disabled = allRows.length === 0;
                } else {
                    importErrors.innerHTML = `<div class="alert alert-success small mb-0">All student rows passed format checks. You can import now.${omittedContactNote}${skippedFamilyNote}</div>`;
                    confirmBtn.disabled = allRows.length === 0;
                }

            } catch (error) {
                preview.style.display = 'none';
                importErrors.innerHTML = `<div class="alert alert-danger">Error reading file: ${escapeHtml(error.message)}</div>`;
            }
        };
        reader.onerror = () => {
            preview.style.display = 'none';
            confirmBtn.disabled = true;
            importErrors.innerHTML = '<div class="alert alert-danger">The selected CSV could not be read. Please save it again as CSV UTF-8 and retry.</div>';
        };
        reader.readAsText(file);
    }

    async confirmImport() {
        const fileInput = document.getElementById('importFileInput');
        if (!fileInput || !fileInput.files[0]) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire({
                icon: 'error',
                title: 'No File Selected',
                text: 'Please select a file to import.',
                confirmButtonColor: '#03600f'
            });
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        let elapsedTimer = null;

        try {
            // eslint-disable-next-line no-undef
            const swal = window.Swal;
            if (!swal) return;

            const result = await swal.fire({
                title: 'Confirm Import',
                text: 'Are you sure you want to import these students?',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, Import',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#03600f'
            });

            if (!result.isConfirmed) return;

            // Show loading
            swal.fire({
                title: 'Importing...',
                html: `
                    <div>Validating and saving the CSV rows.</div>
                    <div class="progress mt-3" style="height: 20px;" role="progressbar" aria-label="Estimated student import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="1">
                        <div id="studentImportProgress" class="progress-bar progress-bar-striped progress-bar-animated bg-success" style="width: 1%; min-width: 2.5rem;">1%</div>
                    </div>
                    <div class="small text-muted mt-1">Estimated progress while the server processes the file</div>
                    <div id="studentImportElapsed" class="small text-muted mt-2">Elapsed time: 0 seconds</div>
                `,
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    swal.showLoading();
                    const startedAt = Date.now();
                    elapsedTimer = window.setInterval(() => {
                        const elapsedElement = document.getElementById('studentImportElapsed');
                        const elapsedMs = Date.now() - startedAt;
                        const elapsedSeconds = Math.floor(elapsedMs / 1000);
                        if (elapsedElement) elapsedElement.textContent = `Elapsed time: ${elapsedSeconds} second${elapsedSeconds === 1 ? '' : 's'}`;
                        const percent = Math.min(99, 1 + Math.floor(98 * (1 - Math.exp(-elapsedMs / 20000))));
                        const bar = document.getElementById('studentImportProgress');
                        if (bar) {
                            bar.style.width = `${percent}%`;
                            bar.textContent = `${percent}%`;
                            bar.parentElement.setAttribute('aria-valuenow', String(percent));
                        }
                    }, 200);
                }
            });

            const data = await ApiService.postFormData('/masterfiles/masterfiles-students.php?action=import', formData);
            if (elapsedTimer) {
                window.clearInterval(elapsedTimer);
                elapsedTimer = null;
            }

            if (data.success) {
                const bar = document.getElementById('studentImportProgress');
                if (bar) {
                    bar.style.width = '100%';
                    bar.textContent = '100%';
                    bar.parentElement.setAttribute('aria-valuenow', '100');
                }
                await new Promise(resolve => window.setTimeout(resolve, 300));
                const message = data.message || `Import completed. ${data.created || 0} students added, ${data.updated || 0} updated, ${data.skipped || 0} skipped.`;
                let errorMsg = '';
                if (data.errors && data.errors.length > 0) {
                    errorMsg = '<br><br><strong>Errors:</strong><ul style="text-align: left; max-height: 200px; overflow-y: auto;">';
                    data.errors.slice(0, 10).forEach(err => {
                        errorMsg += `<li>${escapeHtml(err)}</li>`;
                    });
                    if (data.errors.length > 10) {
                        errorMsg += `<li>... and ${data.errors.length - 10} more errors</li>`;
                    }
                    errorMsg += '</ul>';
                }
                const scholarshipWarnings = Array.isArray(data.scholarship_warnings) ? data.scholarship_warnings : [];
                const scholarshipNote = Number(data.ignored_scholarships || 0) > 0
                    ? `<br><br><strong>Unmatched optional scholarships ignored:</strong> ${Number(data.ignored_scholarships)}<ul style="text-align: left; max-height: 160px; overflow-y: auto;">${scholarshipWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : '';
                const hasWarnings = Number(data.skipped || 0) > 0 || Number(data.ignored_scholarships || 0) > 0;

                await swal.fire({
                    icon: hasWarnings ? 'warning' : 'success',
                    title: hasWarnings ? 'Import Completed with Warnings' : 'Import Successful',
                    html: message + errorMsg + scholarshipNote,
                    confirmButtonColor: '#03600f'
                });
                this.hideModal('importStudentsModal');
                window.location.reload();
            } else {
                await swal.fire({
                    icon: 'error',
                    title: 'Import Failed',
                    text: data.message || 'Failed to import students.',
                    confirmButtonColor: '#03600f'
                });
            }
        } catch (error) {
            // eslint-disable-next-line no-undef
            Swal && Swal.fire({
                icon: 'error',
                title: 'Import Error',
                text: error?.response?.data?.message || error?.message || 'An error occurred during import.',
                confirmButtonColor: '#03600f'
            });
        } finally {
            if (elapsedTimer) window.clearInterval(elapsedTimer);
        }
    }

    async onExportClick() {
        // eslint-disable-next-line no-undef
        const swal = window.Swal;
        if (!swal) return;
        const result = await swal.fire({
            title: 'Export Students',
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

        let exportRows = this.cachedRows || [];
        try {
            swal.fire({
                title: 'Preparing export',
                text: 'Loading the complete filtered student list...',
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => swal.showLoading(),
            });
            const params = this.getStudentsRequestParams();
            delete params.paginated;
            delete params.page;
            delete params.per_page;
            const exportData = await ApiService.get('/masterfiles/masterfiles-students.php', params);
            if (!exportData || !Array.isArray(exportData.rows)) {
                throw new Error(exportData?.message || 'Could not load students for export.');
            }
            exportRows = exportData.rows;
            swal.close();
        } catch (error) {
            await swal.fire({
                icon: 'error',
                title: 'Export failed',
                text: error?.response?.data?.message || error?.message || 'Could not prepare the student export.',
                confirmButtonColor: '#03600f',
            });
            return;
        }

        if (!exportRows.length) {
            await swal.fire({ icon: 'warning', title: 'No Data', text: 'There are no students to export for the selected filters.', confirmButtonColor: '#007319' });
            return;
        }

        const templateRows = exportRows.map((r) => this.mapStudentToImportExportRow(r));
        const summaryRows = exportRows.map((r) => ({
            'School ID': r.school_id || '',
            'Name': `${r.first_name || ''} ${r.middle_name || ''} ${r.last_name || ''}`.trim(),
            'Program': r.program_name || '',
            'Year Level': r.year_level_name || '',
            'School Email': this.extractPhinmaEdLocalPart(r.email || '') || (r.email || ''),
            'Personal Email': r.personal_email || '',
            'Campus': r.campus_name || '',
            'Contact': r.contact_number || '',
            'Family Details': (Array.isArray(r.family_details) ? r.family_details : [])
                .filter((member) => [1, 2, 3].includes(Number(member.relationship_id)))
                .map((member) => `${({ 1: 'Father', 2: 'Mother', 3: 'Guardian' })[member.relationship_id]}: ${member.name || '-'}, Contact ${member.contact || '-'}`)
                .join('; '),
            'Active': String(r.is_active) === '1' ? 'Active' : 'Inactive'
        }));

        const choice = result.value;
        if (choice === 'csv') {
            const csv = '\uFEFF' + this.rowsToCsv(templateRows, STUDENTS_IMPORT_EXPORT_HEADERS);
            this.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'students_export.csv');
            return;
        }

        if (choice === 'xls') {
            const headers = STUDENTS_IMPORT_EXPORT_HEADERS;
            const th = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
            const trs = templateRows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
            this.downloadBlob(new Blob([html], { type: 'application/vnd.ms-excel' }), 'students_export.xls');
            return;
        }

        if (choice === 'doc') {
            const headers = STUDENTS_IMPORT_EXPORT_HEADERS;
            const th = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
            const trs = templateRows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`).join('');
            const html = `<html><body><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
            this.downloadBlob(new Blob([html], { type: 'application/msword' }), 'students_export.doc');
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

            const headers = ['School ID', 'Name', 'Program', 'Year Level', 'School Email', 'Personal Email', 'Campus', 'Family Details', 'Status'];
            const th = headers.map(h => `<th style="border:1px solid #333;padding:10px;background:#198754;color:white;text-align:left;font-weight:600;font-size:11px;">${escapeHtml(h)}</th>`).join('');
            
            const trs = summaryRows.map((r, idx) => {
                const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f9fa';
                const rowData = [r['School ID'], r.Name, r.Program, r['Year Level'], r['School Email'], r['Personal Email'], r.Campus, r['Family Details'], r.Active];
                return `<tr style="background-color:${bgColor};">${rowData.map(val => `<td style="border:1px solid #dee2e6;padding:8px;font-size:10px;">${escapeHtml(String(val ?? ''))}</td>`).join('')}</tr>`;
            }).join('');

            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Students Report</title>
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
                                <h2>Students Masterfile Report</h2>
                            </div>
                            <div class="report-info">
                                <div><strong>Generated:</strong> ${new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                <div><strong>Module:</strong> Students</div>
                                <div><strong>Total Records:</strong> ${summaryRows.length}</div>
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

    async openManagePeriodsModal(row) {
        if (!rbacUtil.requireMasterfilePermission('students', 'edit', 'update period access')) {
            return;
        }
        const modal = new bootstrap.Modal(document.getElementById('managePeriodAccessModal'));
        const studentName = `${row.first_name || ''} ${row.middle_name || ''} ${row.last_name || ''}`.trim();

        document.getElementById('periodAccessStudentName').textContent = studentName;
        document.getElementById('periodAccessStudentId').textContent = row.school_id || '';

        try {
            // Fetch all periods and student's current access
            const response = await ApiService.get('/masterfiles/masterfiles-students.php', {
                action: 'get_period_access',
                student_id: row.id
            });

            if (response.success) {
                this.renderPeriodCheckboxes(response.periods, response.studentAccess);
                this.currentStudentForPeriods = row;
                modal.show();
            }
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to load period access data',
                confirmButtonColor: '#03600f'
            });
        }
    }

    renderPeriodCheckboxes(periods, studentAccess) {
        const container = document.getElementById('periodAccessCheckboxes');
        if (!container) return;

        const accessSet = new Set(studentAccess.map(a => a.period_id));

        container.innerHTML = periods.map(period => `
            <div class="form-check mb-2">
                <input class="form-check-input" type="checkbox" value="${period.app_period_id}"
                       id="period_${period.app_period_id}" ${accessSet.has(period.app_period_id) ? 'checked' : ''}>
                <label class="form-check-label" for="period_${period.app_period_id}">
                    ${period.app_period_name}
                    <small class="text-muted">(${period.app_period_status == 1 ? 'Currently Active' : 'Closed'})</small>
                </label>
            </div>
        `).join('');

        // Bind save button
        const saveBtn = document.getElementById('savePeriodAccessBtn');
        if (saveBtn) {
            saveBtn.onclick = () => this.savePeriodAccess();
        }
    }

    async savePeriodAccess() {
        if (!rbacUtil.requireMasterfilePermission('students', 'edit', 'update period access')) {
            return;
        }
        if (!this.currentStudentForPeriods) return;

        const checkboxes = document.querySelectorAll('#periodAccessCheckboxes input[type="checkbox"]');
        const selectedPeriods = Array.from(checkboxes)
            .filter(cb => cb.checked)
            .map(cb => parseInt(cb.value));

        try {
            const response = await ApiService.post('/masterfiles/masterfiles-students.php', {
                action: 'save_period_access',
                student_id: this.currentStudentForPeriods.id,
                period_ids: selectedPeriods
            });

            if (response.success) {
                bootstrap.Modal.getInstance(document.getElementById('managePeriodAccessModal')).hide();
                await Swal.fire({
                    icon: 'success',
                    title: 'Success',
                    text: 'Period access updated successfully',
                    timer: 1500,
                    showConfirmButton: false
                });
                window.location.reload();
            }
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.response?.data?.message || 'Failed to update period access',
                confirmButtonColor: '#03600f'
            });
        }
    }

    bindOutsideActionMenuClose() {
        // Inline row actions — no dropdown menus to close.
    }

    setupMobileFilterClose() {
        const navbarToggler = document.querySelector('.navbar-toggler');
        const closeDropdown = (btnId) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            const dropdown = bootstrap.Dropdown.getInstance(btn);
            if (dropdown) dropdown.hide();
        };

        if (navbarToggler) {
            navbarToggler.addEventListener('click', () => {
                closeDropdown('mobileFilterBtn');
                closeDropdown('mobileFilterPendingBtn');
            });
        }
    }
}

export default MasterfilesStudentsModule;
