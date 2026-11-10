import AppPaths from '../../services/services-appPaths.js';
import ApiService from '../../services/services-apiService.js';
import { escapeHtml } from '../../shared/shared-escape.js';
import { renderStudentLoanDetails } from '../../shared/shared-student-loan-details.js?v=20260913-paid-partial-status';

class StudentsLoansModule {
    constructor() {
        this.currentLoan = null;
        this.allLoans = [];
        this.filters = {
            semesterId: '',
            periodId: '',
            search: ''
        };
        this.pagination = {
            page: 1,
            perPage: 10,
            total: 0,
            totalPages: 1
        };
        this.loansRequestId = 0;
    }

    async init() {
        await this.loadProfile();
        await this.loadFilters();
        await this.loadCurrentLoan();
        await this.loadAllLoans();
        this.setupEventListeners();
        this.setupMobileFilterClose();
        this.handleOpenLoanFromUrl();
    }

    handleOpenLoanFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const openLoan = params.get('openLoan');
        if (!openLoan) return;

        const loanId = parseInt(openLoan, 10);
        if (!loanId) return;

        this.viewLoan(loanId);

        params.delete('openLoan');
        const query = params.toString();
        const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
        window.history.replaceState({}, '', cleanUrl);
    }

    async loadProfile() {
        try {
            const response = await ApiService.get('/students/students-dashboard.php', { action: 'profile' });
            if (response.success && response.profile) {
                const p = response.profile;
                const fullName = [p.student_first_name, p.student_middle_name, p.student_last_name].filter(Boolean).join(' ');
                
                // Update sidebar profile
                const sidebarName = document.getElementById('sidebarProfileName');
                if (sidebarName) sidebarName.textContent = fullName;
                
                const sidebarRole = document.getElementById('sidebarProfileRole');
                if (sidebarRole) sidebarRole.textContent = p.student_type || 'Student';
                
                // Update avatars with profile image if available
                const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                const headerAvatar = document.getElementById('headerUserAvatarImg');
                
                if (p.student_profile_image) {
                    // Use actual profile image
                    const imagePath = '../../' + p.student_profile_image;
                    if (sidebarAvatar) sidebarAvatar.src = imagePath;
                    if (headerAvatar) headerAvatar.src = imagePath;
                } else {
                    // Use default avatar
                    const avatarUrl64 = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=03600f&color=fff&size=64`;
                    const avatarUrl28 = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=03600f&color=fff&size=28`;
                    if (sidebarAvatar) sidebarAvatar.src = avatarUrl64;
                    if (headerAvatar) headerAvatar.src = avatarUrl28;
                }
            }
        } catch (error) {
            console.error('Error loading profile:', error);
        }
    }

    async loadCurrentLoan() {
        const contentEl = document.getElementById('latestLoanContent');
        const iconBtn = document.getElementById('viewLatestLoanIconBtn');
        
        if (!contentEl) return;
        
        try {
            const response = await ApiService.get('/students/students-loans.php', { action: 'current' });
            
            if (response.success && response.loan) {
                this.currentLoan = response.loan;
                contentEl.innerHTML = this.renderCurrentLoan(response.loan);
                
                // Show and wire up the icon button on desktop
                if (iconBtn) {
                    iconBtn.classList.remove('d-none');
                    iconBtn.classList.add('d-none', 'd-md-inline-block');
                    iconBtn.onclick = () => this.viewLoan(response.loan.loan_id);
                }
            } else {
                contentEl.innerHTML = `
                    <div class="text-center py-4">
                        <i class="bi bi-inbox text-muted fs-1 d-block mb-3"></i>
                        <p class="text-muted mb-1">No application to show yet</p>
                        <small class="text-muted">When you submit a loan request, a summary will appear here.</small>
                    </div>
                `;
                // Hide icon button if no loan
                if (iconBtn) {
                    iconBtn.classList.add('d-none');
                }
            }
        } catch (error) {
            console.error('Error loading current loan:', error);
            contentEl.innerHTML = `
                <div class="text-center py-4">
                    <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                    <p class="text-danger">Failed to load loan information</p>
                </div>
            `;
            // Hide icon button on error
            if (iconBtn) {
                iconBtn.classList.add('d-none');
            }
        }
    }

    async loadAllLoans() {
        const requestId = ++this.loansRequestId;
        const tbody = document.getElementById('allLoansTableBody');
        
        if (!tbody) return;
        
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">Loading your applications…</td></tr>';
        
        try {
            const response = await ApiService.get('/students/students-loans.php', {
                action: 'list',
                page: this.pagination.page,
                perPage: this.pagination.perPage,
                semesterId: this.filters.semesterId,
                periodId: this.filters.periodId,
                search: this.filters.search
            });
            
            if (requestId !== this.loansRequestId) return;
            if (response.success) {
                this.allLoans = response.loans || [];
                this.pagination = response.pagination || this.pagination;
                if (this.pagination.page > this.pagination.totalPages) {
                    this.pagination.page = Math.max(1, this.pagination.totalPages);
                    return this.loadAllLoans();
                }
                this.renderAllLoans();
                this.updatePagination();
                this.updateTotalCount();
            } else {
                this.renderError(response.message || 'Failed to load loans.');
            }
        } catch (error) {
            if (requestId !== this.loansRequestId) return;
            console.error('Error loading all loans:', error);
            this.renderError('An unexpected error occurred while loading loans.');
        }
    }

    renderCurrentLoan(loan) {
        const fmt = (val) => `₱${parseFloat(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const fmtBalance = (val) => (val === null || val === undefined || val === '' ? '-' : fmt(val));
        
        return `
            <div class="row">
                <div class="col-md-6">
                    <h6 class="fw-semibold text-dark mb-3">Overview</h6>
                    <div class="mb-3">
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Reference no.</span>
                            <span class="fw-semibold">${loan.loan_application_no || '-'}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Amount to Pay</span>
                            <span class="fw-semibold">${fmt(loan.loan_amount_can_pay ?? '0.00')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Balance</span>
                            <span class="fw-semibold">${fmtBalance(loan.balance_total_balance)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <h6 class="fw-semibold text-dark mb-3">Period &amp; dates</h6>
                    <div class="mb-3">
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Application period</span>
                            <span class="fw-semibold text-end ms-2">${loan.app_period_name || '-'}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Application date</span>
                            <span class="fw-semibold">${this.formatDisplayDate(loan.loan_application_date)}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2">
                            <span class="text-muted small">Last updated</span>
                            <span class="fw-semibold">${this.formatDisplayDate(loan.loan_updated_at)}</span>
                        </div>
                    </div>
                    <div class="mt-3 d-md-none">
                        <button class="btn btn-outline-secondary btn-sm view-full-details-btn" onclick="window.studentsLoansModule.viewLoan(${loan.loan_id})">
                            <i class="bi bi-eye me-1"></i>View full details
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    renderAllLoans() {
        const tbody = document.getElementById('allLoansTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';

        if (this.allLoans.length === 0) {
            const total = this.pagination.total || 0;
            const hasFilters = !!(this.filters.semesterId || this.filters.periodId || (this.filters.search && this.filters.search.trim()));
            const noApplicationsYet = total === 0 && !hasFilters;
            const title = noApplicationsYet
                ? 'No applications yet'
                : 'No applications match your search or filters';
            const sub = noApplicationsYet
                ? 'When you submit a loan request from your Dashboard, it will appear in this list.'
                : 'Try clearing the search box or setting semester and period to “All”.';
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" class="text-center text-muted py-5">
                        <h6 class="text-muted small mb-1">${title}</h6>
                        <p class="text-muted small mb-0">${sub}</p>
                    </td>
                </tr>
            `;
            return;
        }

        const fmt = (val) => `₱${parseFloat(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const fmtOptional = (val) => (val === null || val === undefined || val === '' ? '—' : fmt(val));

        this.allLoans.forEach(loan => {
            const statusBadge = this.getStatusBadge(loan.loan_status_id, loan.loan_status_name);
            const paymentBadge = this.getPaymentStatusBadge(loan.payment_status);
            const pnBadge = this.getPnStatusBadge(loan.pn_status);
            const hasTotalBalance = loan.balance_total_balance !== null
                && loan.balance_total_balance !== undefined
                && loan.balance_total_balance !== '';
            const totalBalance = parseFloat(loan.balance_total_balance || 0);
            const amountCanPay = parseFloat(loan.loan_amount_can_pay || 0);
            const remainingBalance = hasTotalBalance ? Math.max(0, totalBalance - amountCanPay) : null;
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.classList.add('table-row-clickable');
            row.addEventListener('click', () => {
                this.viewLoan(loan.loan_id);
            });
            row.innerHTML = `
                <td class="text-center" data-label="Application No.">${escapeHtml(loan.loan_application_no || '-')}</td>
                <td class="text-center" data-label="Period">${escapeHtml(loan.app_period_name || '-')}</td>
                <td class="text-center" data-label="Balance">${fmtOptional(loan.balance_total_balance)}</td>
                <td class="text-center" data-label="Amount Can Pay">${fmtOptional(loan.loan_amount_can_pay)}</td>
                <td class="text-center" data-label="Loan Amount">${fmtOptional(remainingBalance)}</td>
                <td class="text-center" data-label="Status">${statusBadge}</td>
                <td class="text-center" data-label="Payment Status">${paymentBadge}</td>
                <td class="text-center" data-label="PN Status">${pnBadge}</td>
                <td class="text-center" data-label="Date Applied">${escapeHtml(this.formatDisplayDate(loan.loan_application_date))}</td>
            `;
            tbody.appendChild(row);
        });
    }

    renderError(message) {
        const tbody = document.getElementById('allLoansTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" class="text-center text-danger py-5">
                        <h6 class="text-danger small mb-1">Couldn’t load applications</h6>
                        <p class="text-muted small mb-0">${message}</p>
                    </td>
                </tr>
            `;
        }
    }
    
    updatePagination() {
        const pageInfo = document.getElementById('pageInfo');
        if (!pageInfo) return;
        
        const page = this.pagination.page || 1;
        const perPage = this.pagination.perPage || 10;
        const total = this.pagination.total || 0;
        const start = total === 0 ? 0 : (page - 1) * perPage + 1;
        const end = Math.min(page * perPage, total);
        
        pageInfo.textContent = `Showing ${start} to ${end} of ${total} entries`;

        const nav = document.getElementById('studentLoansPagination');
        if (!nav) return;
        const pages = Math.max(1, Number(this.pagination.totalPages) || 1);
        if (pages <= 1) {
            nav.innerHTML = '';
            return;
        }
        const numbers = pages <= 7
            ? Array.from({ length: pages }, (_, index) => index + 1)
            : [...new Set([1, page - 1, page, page + 1, pages])]
                .filter((number) => number >= 1 && number <= pages)
                .sort((a, b) => a - b);
        const buttons = [];
        let previous = 0;
        for (const number of numbers) {
            if (previous && number > previous + 1) buttons.push('<span class="px-1 text-muted" aria-hidden="true">…</span>');
            buttons.push(`<button type="button" class="btn btn-sm ${number === page ? 'btn-success' : 'btn-outline-secondary'}" data-page="${number}" ${number === page ? 'aria-current="page"' : ''}>${number}</button>`);
            previous = number;
        }
        nav.innerHTML = `<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>${buttons.join('')}<button type="button" class="btn btn-sm btn-outline-secondary" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
    }
    
    updateTotalCount() {
        const totalCountEl = document.getElementById('totalLoansCount');
        if (totalCountEl) {
            const count = this.pagination.total || 0;
            totalCountEl.textContent = `${count} ${count === 1 ? 'loan' : 'loans'}`;
        }
    }

    getStatusBadge(statusId, statusName) {
        const badges = {
            1: '<span class="badge bg-warning text-dark">Pending</span>',
            2: '<span class="badge bg-success">Approved</span>',
            5: '<span class="badge bg-success">Completed</span>',
            6: '<span class="badge bg-warning text-dark">Returned</span>',
            9: '<span class="badge bg-secondary">Cancelled</span>',
            11: '<span class="badge bg-warning text-dark">Partial Payment</span>',
            12: '<span class="badge bg-success">Endorsed</span>'
        };
        return badges[statusId] || `<span class="badge bg-secondary">${statusName || 'Unknown'}</span>`;
    }

    getPaymentStatusBadge(statusName) {
        const status = String(statusName || 'Not Paid').trim();
        const classes = {
            'Paid': 'bg-success',
            'Paid Pending': 'bg-info text-dark',
            'Paid Partial': 'bg-warning text-dark',
            'Partial Payment': 'bg-warning text-dark',
            'Not Paid': 'bg-secondary'
        };
        return `<span class="badge ${classes[status] || 'bg-secondary'}">${escapeHtml(status)}</span>`;
    }

    getPnStatusBadge(statusName) {
        const status = String(statusName || 'Not Tagged').trim();
        return `<span class="badge ${status === 'Tagged' ? 'bg-success' : 'bg-secondary'}">${escapeHtml(status)}</span>`;
    }

    formatDate(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    /** Month name, day, year (e.g. June 5, 2026). */
    formatDisplayDate(value) {
        if (!value) return '-';
        const raw = String(value).trim();
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            const dt = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
            if (!Number.isNaN(dt.getTime())) {
                return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            }
        }
        const ts = Date.parse(raw);
        if (!Number.isNaN(ts)) {
            return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        }
        return raw;
    }

    async viewLoan(loanId) {
        try {
            const response = await ApiService.get('/students/students-loans.php', { action: 'details', loanId });
            
            if (response.success && response.loan) {
                const modal = new bootstrap.Modal(document.getElementById('viewLoanModal'));
                const contentEl = document.getElementById('loanDetailsContent');
                const footerEl = document.getElementById('loanDetailsFooter');
                
                if (contentEl) {
                    contentEl.innerHTML = renderStudentLoanDetails(response.loan, escapeHtml);
                    
                    // Add event listeners for view document buttons
                    setTimeout(() => {
                        const viewDocBtns = contentEl.querySelectorAll('.view-document-btn');
                        viewDocBtns.forEach(btn => {
                            btn.addEventListener('click', () => {
                                const docPath = btn.getAttribute('data-doc-path');
                                const docName = btn.getAttribute('data-doc-name');
                                this.viewDocument(docPath, docName);
                            });
                        });
                    }, 0);
                }
                
                if (footerEl) {
                    const actions = [];
                    if (Number(response.loan.loan_status_id) === 1) {
                        actions.push(`<button type="button" class="btn btn-danger" onclick="window.studentsLoansModule.cancelLoan(${loanId})">
                            <i class=""></i>Cancel Application
                        </button>`);
                    }
                    if (Number(response.loan.loan_status_id) === 6) {
                        actions.push(`<button type="button" class="btn btn-success" onclick="window.studentsLoansModule.reapplyLoan(${loanId})">
                            <i class=""></i>Reapply Loan
                        </button>`);
                    }
                    actions.push('<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>');
                    footerEl.innerHTML = actions.join(' ');
                }
                
                modal.show();
            } else {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to load loan details',
                    timer: 2000,
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false
                });
            }
        } catch (error) {
            console.error('Error loading loan details:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'An unexpected error occurred',
                timer: 2000,
                toast: true,
                position: 'top-end',
                showConfirmButton: false
            });
        }
    }
    
    viewDocument(docPath, docName) {
        // Hide the loan details modal first
        const loanModalEl = document.getElementById('viewLoanModal');
        if (loanModalEl) {
            const loanModal = bootstrap.Modal.getInstance(loanModalEl);
            if (loanModal) {
                loanModal.hide();
            }
        }
        
        const modalEl = document.getElementById('viewDocumentModal');
        if (!modalEl) return;
        
        const modal = new bootstrap.Modal(modalEl);
        const titleEl = document.getElementById('viewDocumentModalLabel');
        const contentEl = document.getElementById('documentViewerContent');
        const downloadBtn = document.getElementById('downloadDocumentBtn');
        
        if (titleEl) {
            titleEl.textContent = docName || 'Document';
        }
        
        if (contentEl) {
            const fileExt = docPath.split('.').pop().toLowerCase();
            
            if (fileExt === 'pdf') {
                contentEl.innerHTML = `
                    <iframe src="${docPath}" class="w-100 h-100 border-0"></iframe>
                `;
            } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt)) {
                contentEl.innerHTML = `
                    <div class="d-flex align-items-center justify-content-center p-3 bg-light" style="min-height: 60vh;">
                        <img src="${docPath}" class="img-fluid rounded shadow-sm" alt="${docName}" style="max-width: 100%; height: auto;">
                    </div>
                `;
            } else {
                contentEl.innerHTML = `
                    <div class="d-flex align-items-center justify-content-center" style="min-height: 60vh;">
                        <div class="alert alert-info text-center">
                            <i class="bi bi-file-earmark fs-1 d-block mb-3"></i>
                            <p class="mb-2">Preview not available for this file type.</p>
                            <p class="small text-muted mb-0">Please use the download button to view the file.</p>
                        </div>
                    </div>
                `;
            }
        }
        
        if (downloadBtn) {
            downloadBtn.onclick = () => {
                // Create a temporary anchor element to trigger download
                const link = document.createElement('a');
                link.href = docPath;
                link.download = docName || 'document';
                link.target = '_blank';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            };
        }
        
        // When document modal is closed, show the loan details modal again
        modalEl.addEventListener('hidden.bs.modal', function showLoanModalAgain() {
            if (loanModalEl) {
                const loanModal = new bootstrap.Modal(loanModalEl);
                loanModal.show();
            }
            // Remove this event listener after it fires once
            modalEl.removeEventListener('hidden.bs.modal', showLoanModalAgain);
        });
        
        modal.show();
    }
    
    async reapplyLoan(loanId) {
        try {
            // Close the loan details modal first
            const viewLoanModalEl = document.getElementById('viewLoanModal');
            if (viewLoanModalEl) {
                const viewLoanModal = bootstrap.Modal.getInstance(viewLoanModalEl);
                if (viewLoanModal) viewLoanModal.hide();
            }
            
            // Check if we can access the dashboard module's loadLoanApplicationForm
            if (window.studentsDashboardModule && typeof window.studentsDashboardModule.loadLoanApplicationForm === 'function') {
                // Use dashboard module's function
                await window.studentsDashboardModule.reapplyLoan(loanId);
                // Reload loans after reapplication
                await this.loadCurrentLoan();
                await this.loadAllLoans();
                return;
            }
            
            // Fallback: redirect to dashboard or show message
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'info',
                title: 'Redirect Required',
                text: 'Please use the dashboard to reapply your loan application.',
                confirmButtonColor: '#03600f',
                confirmButtonText: 'Go to Dashboard'
            }).then((result) => {
                if (result.isConfirmed) {
                    window.location.href = AppPaths.page(`views/students/students-dashboard.html?reapplyLoan=${encodeURIComponent(loanId)}`);
                }
            });
        } catch (error) {
            console.error('Error reapplying loan:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message || 'Failed to load loan application form. Please try again.',
                timer: 3000,
                toast: true,
                position: 'top-end',
                showConfirmButton: false
            });
        }
    }

    async cancelLoan(loanId) {
        try {
            // eslint-disable-next-line no-undef
            const result = await Swal.fire({
                icon: 'warning',
                title: 'Cancel application?',
                text: 'This will cancel your pending loan application.',
                showCancelButton: true,
                confirmButtonColor: '#d33',
                cancelButtonColor: '#6c757d',
                confirmButtonText: 'Yes, cancel it',
                cancelButtonText: 'Keep it'
            });

            if (!result.isConfirmed) return;

            const response = await ApiService.post('/students/students-loans.php', { action: 'cancel', loanId });

            if (response.success) {
                // Close modal if open
                const viewLoanModalEl = document.getElementById('viewLoanModal');
                if (viewLoanModalEl) {
                    const viewLoanModal = bootstrap.Modal.getInstance(viewLoanModalEl);
                    if (viewLoanModal) viewLoanModal.hide();
                }

                await this.loadCurrentLoan();
                await this.loadAllLoans();

                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'success',
                    title: 'Cancelled',
                    text: 'Your loan application has been cancelled.',
                    timer: 2000,
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false
                });
            } else {
                // eslint-disable-next-line no-undef
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: response.message || 'Failed to cancel application.',
                    timer: 2500,
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false
                });
            }
        } catch (error) {
            console.error('Error cancelling loan:', error);
            // eslint-disable-next-line no-undef
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'An unexpected error occurred.',
                timer: 2500,
                toast: true,
                position: 'top-end',
                showConfirmButton: false
            });
        }
    }

    renderLoanDetails(loan) {
        return renderStudentLoanDetails(loan, escapeHtml);
    }

    setupEventListeners() {
        // Make viewLoan accessible globally
        window.studentsLoansModule = this;
        
        // Pagination
        const perPageSelect = document.getElementById('perPageSelect');
        const semesterSelect = document.getElementById('filterSemester');
        const periodSelect = document.getElementById('filterPeriod');
        const searchInput = document.getElementById('searchLoans');
        const searchInputMobile = document.getElementById('searchLoansMobile');
        const applyMobileFiltersBtn = document.getElementById('applyMobileFiltersBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        
        if (perPageSelect) {
            perPageSelect.addEventListener('change', (e) => {
                this.pagination.perPage = parseInt(e.target.value, 10);
                this.pagination.page = 1;
                this.loadAllLoans();
            });
        }
        document.getElementById('studentLoansPagination')?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            const page = Number(button.dataset.page);
            if (page < 1 || page > this.pagination.totalPages || page === this.pagination.page) return;
            this.pagination.page = page;
            this.loadAllLoans();
        });
        
        if (semesterSelect) {
            semesterSelect.addEventListener('change', (e) => {
                this.filters.semesterId = e.target.value;
                this.pagination.page = 1;
                this.loadAllLoans();
            });
        }
        
        if (periodSelect) {
            periodSelect.addEventListener('change', (e) => {
                this.filters.periodId = e.target.value;
                this.pagination.page = 1;
                this.loadAllLoans();
            });
        }
        
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const searchValue = e.target.value.trim();
                searchTimeout = setTimeout(() => {
                    this.filters.search = searchValue;
                    this.pagination.page = 1;
                    if (searchInputMobile) searchInputMobile.value = searchValue;
                    this.loadAllLoans();
                }, 300);
            });
        }
        
        if (searchInputMobile) {
            let searchTimeout;
            searchInputMobile.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const searchValue = e.target.value.trim();
                searchTimeout = setTimeout(() => {
                    this.filters.search = searchValue;
                    this.pagination.page = 1;
                    if (searchInput) searchInput.value = searchValue;
                    this.loadAllLoans();
                }, 300);
            });
        }
        
        if (applyMobileFiltersBtn) {
            applyMobileFiltersBtn.addEventListener('click', () => {
                const semesterMobile = document.getElementById('filterSemesterMobile');
                const periodMobile = document.getElementById('filterPeriodMobile');
                
                this.filters.semesterId = semesterMobile ? semesterMobile.value : '';
                this.filters.periodId = periodMobile ? periodMobile.value : '';
                
                if (semesterSelect) semesterSelect.value = this.filters.semesterId;
                if (periodSelect) periodSelect.value = this.filters.periodId;
                
                const mobileDropdown = document.getElementById('mobileFilterBtn');
                if (mobileDropdown) {
                    const dropdownInstance = bootstrap.Dropdown.getInstance(mobileDropdown);
                    if (dropdownInstance) dropdownInstance.hide();
                }
                
                this.pagination.page = 1;
                this.loadAllLoans();
            });
        }
        
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                this.filters.semesterId = '';
                this.filters.periodId = '';
                this.filters.search = '';
                this.pagination.page = 1;
                
                if (semesterSelect) semesterSelect.value = '';
                if (periodSelect) periodSelect.value = '';
                if (searchInput) searchInput.value = '';
                if (searchInputMobile) searchInputMobile.value = '';
                
                const semesterMobile = document.getElementById('filterSemesterMobile');
                const periodMobile = document.getElementById('filterPeriodMobile');
                if (semesterMobile) semesterMobile.value = '';
                if (periodMobile) periodMobile.value = '';
                
                await this.loadAllLoans();
            });
        }
    }

    async loadFilters() {
        try {
            const response = await ApiService.get('/students/students-loans.php', { action: 'filters' });
            if (!response.success) return;
            
            const semesters = response.semesters || [];
            const periods = response.applicationPeriods || [];
            
            const semesterDesktop = document.getElementById('filterSemester');
            const semesterMobile = document.getElementById('filterSemesterMobile');
            const periodDesktop = document.getElementById('filterPeriod');
            const periodMobile = document.getElementById('filterPeriodMobile');
            
            [semesterDesktop, semesterMobile].forEach(select => {
                if (!select) return;
                select.innerHTML = '<option value="">All Semesters</option>';
                semesters.forEach(semester => {
                    const option = document.createElement('option');
                    option.value = semester.semester_id;
                    option.textContent = semester.semester_name;
                    select.appendChild(option);
                });
            });
            
            [periodDesktop, periodMobile].forEach(select => {
                if (!select) return;
                select.innerHTML = '<option value="">All Periods</option>';
                periods.forEach(period => {
                    const option = document.createElement('option');
                    option.value = period.app_period_id;
                    option.textContent = period.app_period_name;
                    select.appendChild(option);
                });
            });
        } catch (error) {
            console.error('Error loading loan filters:', error);
        }
    }
    
    setupMobileFilterClose() {
        const navbarToggler = document.querySelector('.navbar-toggler');
        const mobileFilterBtn = document.getElementById('mobileFilterBtn');
        
        if (navbarToggler && mobileFilterBtn) {
            navbarToggler.addEventListener('click', () => {
                const dropdown = bootstrap.Dropdown.getInstance(mobileFilterBtn);
                if (dropdown) dropdown.hide();
            });
        }
    }
}

export default StudentsLoansModule;
