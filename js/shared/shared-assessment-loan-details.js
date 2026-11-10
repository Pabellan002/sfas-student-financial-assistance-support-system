/**
 * Shared loan details modal layout for Assessment portal pages.
 */

export function getAssessmentLoanStatusBadgeClass(statusId) {
    const id = parseInt(statusId, 10);
    const classes = {
        1: 'bg-warning text-dark',
        2: 'bg-success',
        3: 'bg-danger',
        4: 'bg-primary',
        5: 'bg-secondary',
        6: 'bg-warning text-dark',
        7: 'bg-info text-white',
        8: 'bg-secondary',
        9: 'bg-secondary'
    };
    return classes[id] || 'bg-secondary';
}

export function renderAssessmentLoanDetails(loan, escapeHtml, getStatusBadgeClass = getAssessmentLoanStatusBadgeClass) {
    const pnBadge = (() => {
        const s = (loan.pnStatus || loan.approval_pn_tagging || '').trim();
        if (!s) return '<span class="badge bg-secondary">Not Set</span>';
        const cls = s === 'Paid' ? 'bg-success' : (s === 'Partial Payment' ? 'bg-warning text-dark' : 'bg-info');
        return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
    })();

    return `
            <div class="row">
                <div class="col-md-6">
                    <h6 class="text-success fw-bold mb-3">Application Information</h6>
                    <div class="mb-3">
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Application No:</span>
                            <span class="fw-semibold">${escapeHtml(loan.loan_application_no || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Application Date:</span>
                            <span class="fw-semibold">${escapeHtml(loan.loan_application_date || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Status:</span>
                            <span class="badge ${getStatusBadgeClass(loan.loan_status_id)}">${escapeHtml(loan.loan_status_name || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">PN Status:</span>
                            ${pnBadge}
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Current Step:</span>
                            <span class="fw-semibold">${escapeHtml(loan.current_step_name || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Application Period:</span>
                            <span class="fw-semibold">${escapeHtml(loan.app_period_name || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Amount Can Pay:</span>
                            <span class="fw-semibold">₱${parseFloat(loan.loan_promised_amount ?? loan.loan_amount_can_pay ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${(parseFloat(loan.loan_partial_payment_total || 0) > 0 && parseFloat(loan.loan_amount_remaining || 0) === 0) ? ' <span class="badge bg-success ms-1">Partial paid</span>' : ''}</span>
                        </div>
                        ${parseFloat(loan.loan_partial_payment_total || 0) > 0 ? `
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Partial Paid / Remaining:</span>
                            <span class="fw-semibold">₱${parseFloat(loan.loan_partial_payment_total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ₱${parseFloat(loan.loan_amount_remaining || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>` : ''}
                        <div class="d-flex justify-content-between py-2">
                            <span class="text-muted small">Reason:</span>
                            <span class="fw-semibold text-end">${escapeHtml(loan.loan_reason || '-')}</span>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <h6 class="text-success fw-bold mb-3">Student Information</h6>
                    <div class="mb-3">
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Student ID:</span>
                            <span class="fw-semibold">${escapeHtml(loan.student_school_id || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Name:</span>
                            <span class="fw-semibold">${escapeHtml(loan.student_name || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Program:</span>
                            <span class="fw-semibold">${escapeHtml(loan.program_name || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Year Level:</span>
                            <span class="fw-semibold">${escapeHtml(loan.year_level_name || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Email:</span>
                            <span class="fw-semibold">${escapeHtml(loan.student_email || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Contact:</span>
                            <span class="fw-semibold">${escapeHtml(loan.student_contact_number || '-')}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2 border-bottom">
                            <span class="text-muted small">Total Balance:</span>
                            <span class="fw-semibold">₱${parseFloat(loan.balance_total_balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div class="d-flex justify-content-between py-2">
                            <span class="text-muted small">Current Balance:</span>
                            <span class="fw-semibold">₱${parseFloat(loan.balance_current_balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                    </div>
                </div>
            </div>
            ${loan.guardian_name ? `
                <div class="row mt-4">
                    <div class="col-12">
                        <h6 class="text-success fw-bold mb-3">Guardian Information</h6>
                        <div class="mb-3">
                            <div class="d-flex justify-content-between py-2 border-bottom">
                                <span class="text-muted small">Guardian Name:</span>
                                <span class="fw-semibold">${escapeHtml(loan.guardian_name || '-')}</span>
                            </div>
                            <div class="d-flex justify-content-between py-2 border-bottom">
                                <span class="text-muted small">Relationship:</span>
                                <span class="fw-semibold">${escapeHtml(loan.guardian_relationship || '-')}</span>
                            </div>
                            <div class="d-flex justify-content-between py-2">
                                <span class="text-muted small">Contact:</span>
                                <span class="fw-semibold">${escapeHtml(loan.guardian_contact || '-')}</span>
                            </div>
                        </div>
                    </div>
                </div>
            ` : ''}
            ${loan.documents && loan.documents.length > 0 ? `
                <div class="row mt-4">
                    <div class="col-12">
                        <h6 class="text-success fw-bold mb-3">Documents</h6>
                        ${loan.documents.map((doc) => {
                            const isImage = /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(doc.loan_document_file_path || '');
                            const fileUrl = `../../${encodeURI(String(doc.loan_document_file_path || ''))}`;
                            return `
                                <div class="mb-3 p-3 border rounded">
                                    <div class="d-flex justify-content-between align-items-center mb-2">
                                        <div>
                                            <span class="fw-semibold">${escapeHtml(doc.doc_type_name || 'Document')}</span>
                                            <span class="badge bg-secondary ms-2">Submitted</span>
                                        </div>
                                    </div>
                                    <div class="text-muted small mb-2">${escapeHtml(doc.loan_document_file_name || '-')}</div>
                                    ${isImage ? `
                                        <div class="mt-2 text-center">
                                            <a href="${escapeHtml(fileUrl)}" target="_blank" class="d-inline-block">
                                                <img src="${escapeHtml(fileUrl)}" alt="${escapeHtml(doc.doc_type_name || 'Document')}"
                                                     class="img-thumbnail"
                                                     style="max-width: 300px; max-height: 300px; width: auto; height: auto; cursor: pointer;"
                                                     onclick="window.open('${escapeHtml(fileUrl)}', '_blank')">
                                            </a>
                                        </div>
                                    ` : `
                                        <div class="mt-2">
                                            <a href="${escapeHtml(fileUrl)}" target="_blank" class="btn btn-sm btn-outline-primary">
                                                <i class="bi bi-eye me-1"></i>View
                                            </a>
                                        </div>
                                    `}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            ` : ''}
            ${loan.tracking && loan.tracking.length > 0 ? `
                <div class="mt-4">
                    <h6 class="text-success fw-bold mb-3">Tracking History</h6>
                    <div class="table-responsive">
                        <table class="table table-sm">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Step</th>
                                    <th>Action</th>
                                    <th>Remarks</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${loan.tracking.map((t) => `
                                    <tr>
                                        <td>${escapeHtml(new Date(t.loan_tracking_created_at).toLocaleString())}</td>
                                        <td>${escapeHtml(t.step_name || '-')}</td>
                                        <td>${escapeHtml(t.loan_tracking_action || '-')}</td>
                                        <td>${escapeHtml(t.loan_tracking_remarks || '-')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : ''}
        `;
}
