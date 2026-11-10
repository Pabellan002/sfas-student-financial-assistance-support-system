/**
 * Shared loan application details layout for student portal (dashboard + loans pages).
 */

function formatStudentLoanDisplayDate(value) {
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

function getStudentLoanStatusBadge(statusId, statusName) {
    const badges = {
        1: '<span class="badge bg-warning text-dark">Pending</span>',
        2: '<span class="badge bg-success">Approved</span>',
        3: '<span class="badge bg-danger">Declined</span>',
        4: '<span class="badge bg-primary">Endorsed to Bukas</span>',
        5: '<span class="badge bg-success">Completed</span>',
        6: '<span class="badge bg-secondary">Returned</span>',
        7: '<span class="badge bg-success">Endorsed</span>',
        8: '<span class="badge bg-dark">Expired</span>',
        9: '<span class="badge bg-danger">Cancelled</span>',
        11: '<span class="badge bg-warning text-dark">Partial Payment</span>',
        12: '<span class="badge bg-success">Endorsed</span>',
    };
    return badges[statusId] || `<span class="badge bg-secondary">${statusName || 'Unknown'}</span>`;
}

function formatTrackingRemarks(tracking) {
    const remarks = String(tracking?.loan_tracking_remarks || '').trim();
    const approverName = String(tracking?.approver_name || '').trim();

    // Older history stored an employee number inside the remarks. Replace it
    // at display time so existing records also show the employee's real name.
    const processedByPattern = /Processed by\s+(?:CSDL|Cashier|COO|Assessment|Branch Admin)\s+employee\s+#\d+\.?/i;
    if (approverName && processedByPattern.test(remarks)) {
        return remarks.replace(processedByPattern, `Processed by ${approverName}.`);
    }

    return remarks || '-';
}

export function renderStudentLoanDetails(loan, escapeHtml) {
    const fmt = (val) => `₱${parseFloat(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fmtBalance = (val) => (val === null || val === undefined || val === '' ? '-' : fmt(val));
    const statusBadge = getStudentLoanStatusBadge(loan.loan_status_id, loan.loan_status_name);
    const paymentStatus = String(loan.payment_status || 'Not Paid').trim();
    const paymentBadge = `<span class="badge ${paymentStatus === 'Paid' ? 'bg-success' : (paymentStatus === 'Paid Pending' ? 'bg-info text-dark' : ((paymentStatus === 'Partial Payment' || paymentStatus === 'Paid Partial') ? 'bg-warning text-dark' : 'bg-secondary'))}">${escapeHtml(paymentStatus)}</span>`;
    const pnStatus = String(loan.pn_status || 'Not Tagged').trim();
    const pnBadge = `<span class="badge ${pnStatus === 'Tagged' ? 'bg-success' : 'bg-secondary'}">${escapeHtml(pnStatus)}</span>`;
    const isReturned = loan.loan_status_id === 6;

    const detailRow = (label, value, isLast = false) => `
        <div class="d-flex justify-content-between align-items-start py-2 gap-3${isLast ? '' : ' border-bottom'}">
            <span class="text-muted small">${label}</span>
            <span class="fw-semibold text-end">${value}</span>
        </div>
    `;

    return `
        <div class="student-loan-details">
            <!-- Header with Application No. and Status Badges -->
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4 pb-3 border-bottom">
                <div>
                    <div class="text-muted small mb-1">Application No.</div>
                    <div class="fs-5 fw-bold text-dark">${escapeHtml(loan.loan_application_no || '-')}</div>
                </div>
                <div class="d-flex flex-wrap align-items-center gap-2">
                    ${statusBadge}
                    ${paymentBadge}
                    ${pnBadge}
                </div>
            </div>

            ${isReturned ? `
                <div class="alert alert-warning d-flex align-items-center mb-4" role="alert">
                    <i class="bi bi-exclamation-triangle-fill me-2 fs-5"></i>
                    <div class="flex-grow-1">
                        <strong>Application Returned</strong>
                        <p class="mb-0 small">This loan application has been returned. Please review the feedback below and resubmit your application.</p>
                    </div>
                </div>
            ` : ''}

            <!-- Payment & Application Information in one row -->
            <div class="row g-4 mb-4">
                <div class="col-lg-6">
                    <h6 class="text-success fw-bold mb-3"><i class="bi bi-wallet2 me-2"></i>Payment Details</h6>
                    <div class="mb-0">
                        ${detailRow('Amount to Pay', fmt(loan.loan_amount_can_pay ?? '0.00'))}
                        ${Number(loan.loan_recorded_payment_amount || 0) > 0 ? detailRow('Amount Paid', fmt(loan.loan_recorded_payment_amount)) : ''}
                        ${(loan.loan_status_id === 11 || loan.loan_payment_status_id === 2) && loan.loan_required_partial_amount > 0 ? `
                            <div class="d-flex justify-content-between align-items-start py-2 gap-3 border-bottom">
                                <span class="text-muted small">Partial Payment Amount</span>
                                <span class="fw-semibold text-end">${fmt(loan.loan_required_partial_amount)}</span>
                            </div>
                        ` : ''}
                        ${detailRow('Balance', fmtBalance(loan.balance_total_balance))}
                        ${detailRow('Due Date', escapeHtml(formatStudentLoanDisplayDate(loan.loan_due_date)), true)}
                    </div>
                </div>
                <div class="col-lg-6">
                    <h6 class="text-success fw-bold mb-3"><i class="bi bi-file-earmark-text me-2"></i>Application Information</h6>
                    <div class="mb-0">
                        ${detailRow('Application Period', escapeHtml(loan.app_period_name || '-'))}
                        ${detailRow('Application Date', escapeHtml(formatStudentLoanDisplayDate(loan.loan_application_date)))}
                        ${detailRow('Current Step', escapeHtml(loan.current_step_name || '-'))}
                        ${detailRow('Approval Date', escapeHtml(formatStudentLoanDisplayDate(loan.loan_approval_date)), true)}
                    </div>
                </div>
            </div>

            <!-- Reason for Application -->
            <div class="mb-4">
                <h6 class="text-success fw-bold mb-3"><i class="bi bi-chat-left-quote me-2"></i>Reason for Application</h6>
                <div class="p-3 bg-light rounded border">
                    <p class="mb-0 small">${escapeHtml(loan.loan_reason || 'No reason provided.')}</p>
                </div>
            </div>

            ${loan.guardian_name ? `
                <div class="mb-4">
                    <h6 class="text-success fw-bold mb-3"><i class="bi bi-person-check me-2"></i>Guardian Information</h6>
                    <div class="row g-3">
                        <div class="col-md-4">
                            <div class="p-3 bg-light rounded border h-100">
                                <div class="text-muted small mb-1">Name</div>
                                <div class="fw-semibold">${escapeHtml(loan.guardian_name || '-')}</div>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="p-3 bg-light rounded border h-100">
                                <div class="text-muted small mb-1">Relationship</div>
                                <div class="fw-semibold">${escapeHtml(loan.guardian_relationship || '-')}</div>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="p-3 bg-light rounded border h-100">
                                <div class="text-muted small mb-1">Contact</div>
                                <div class="fw-semibold">${escapeHtml(loan.guardian_contact || '-')}</div>
                            </div>
                        </div>
                    </div>
                </div>
            ` : ''}

            ${loan.tracking && loan.tracking.length > 0 ? `
                <div class="mb-4 student-loan-history">
                    <h6 class="text-success fw-bold mb-3"><i class="bi bi-clock-history me-2"></i>Application History</h6>
                    <div class="student-loan-history-mobile d-md-none">
                        ${loan.tracking.map((t) => `
                            <div class="student-loan-history-card border rounded p-3 mb-2">
                                <div class="small text-muted mb-2">${escapeHtml(new Date(t.loan_tracking_created_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }))}</div>
                                <div class="d-flex justify-content-between align-items-start gap-3 mb-2">
                                    <span class="text-muted small">Step</span>
                                    <span class="fw-semibold small text-end">${escapeHtml(t.step_name || '-')}</span>
                                </div>
                                <div class="d-flex justify-content-between align-items-start gap-3 mb-2">
                                    <span class="text-muted small">Action</span>
                                    <span class="fw-semibold small text-end">${escapeHtml(t.loan_tracking_action || '-')}</span>
                                </div>
                                <div class="pt-2 border-top">
                                    <div class="text-muted small mb-1">Remarks</div>
                                    <div class="small text-break">${escapeHtml(formatTrackingRemarks(t))}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <div class="table-responsive border rounded d-none d-md-block student-loan-history-table-wrap">
                        <table class="table table-sm table-hover mb-0 align-middle student-loan-history-table">
                            <thead class="table-light">
                                <tr>
                            <th class="text-center small">Date</th>
                            <th class="text-center small">Step</th>
                            <th class="text-center small">Action</th>
                            <th class="small">Remarks</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${loan.tracking.map((t) => `
                                    <tr>
                                        <td class="text-center text-nowrap small">${escapeHtml(new Date(t.loan_tracking_created_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }))}</td>
                                        <td class="text-center small">${escapeHtml(t.step_name || '-')}</td>
                                        <td class="text-center small">${escapeHtml(t.loan_tracking_action || '-')}</td>
                                        <td class="small">${escapeHtml(formatTrackingRemarks(t))}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : ''}

            ${loan.documents && loan.documents.length > 0 ? `
                <div class="mb-4">
                    <h6 class="text-success fw-bold mb-3"><i class="bi bi-paperclip me-2"></i>Submitted Documents</h6>
                    <div class="row g-3">
                        ${loan.documents.map((doc) => {
                            let docPath = doc.loan_document_file_path || '';
                            if (docPath && !docPath.startsWith('http') && !docPath.startsWith('/') && !docPath.startsWith('..')) {
                                docPath = '../../' + docPath;
                            }
                            return `
                                <div class="col-md-6">
                                    <div class="p-3 border rounded h-100 d-flex justify-content-between align-items-center gap-3">
                                        <div class="min-w-0">
                                            <div class="fw-semibold">${escapeHtml(doc.doc_type_name || 'Document')}</div>
                                            <small class="text-muted">Uploaded: ${escapeHtml(new Date(doc.loan_document_created_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }))}</small>
                                        </div>
                                        ${docPath ? `
                                            <button type="button" class="btn btn-sm btn-outline-success flex-shrink-0 view-document-btn" data-doc-path="${escapeHtml(docPath)}" data-doc-name="${escapeHtml(doc.doc_type_name || 'Document')}">
                                                <i class="bi bi-eye me-1"></i>View
                                            </button>
                                        ` : '<span class="text-muted small">No file</span>'}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            ` : ''}

            ${loan.loan_status_id === 4 && loan.bukas_endorsement ? `
                <div class="mb-0">
                    <h6 class="text-success fw-bold mb-3"><i class="bi bi-building me-2"></i>Bukas Endorsement</h6>
                    <div class="card border-primary">
                        <div class="card-body">
                            ${loan.bukas_endorsement.bukas_image_path ? `
                                <div class="text-center mb-3">
                                    <img src="${escapeHtml(loan.bukas_endorsement.bukas_image_path)}"
                                         alt="Bukas"
                                         class="img-fluid rounded"
                                         style="max-height: 200px; width: auto;">
                                </div>
                            ` : ''}
                            ${loan.bukas_endorsement.bukas_title ? `
                                <h6 class="fw-bold text-primary mb-2">${escapeHtml(loan.bukas_endorsement.bukas_title)}</h6>
                            ` : ''}
                            ${loan.bukas_endorsement.bukas_description ? `
                                <p class="text-muted small mb-3">${escapeHtml(loan.bukas_endorsement.bukas_description)}</p>
                            ` : ''}
                            <div class="row g-3">
                                ${loan.bukas_endorsement.bukas_reference ? `
                                    <div class="col-md-6">
                                        <small class="text-muted d-block">Reference</small>
                                        <strong>${escapeHtml(loan.bukas_endorsement.bukas_reference)}</strong>
                                    </div>
                                ` : ''}
                                ${loan.bukas_endorsement.bukas_endorsement_date ? `
                                    <div class="col-md-6">
                                        <small class="text-muted d-block">Endorsement Date</small>
                                        <strong>${escapeHtml(formatStudentLoanDisplayDate(loan.bukas_endorsement.bukas_endorsement_date))}</strong>
                                    </div>
                                ` : ''}
                                ${loan.bukas_endorsement.bukas_learn_more_url ? `
                                    <div class="col-12">
                                        <a href="${escapeHtml(loan.bukas_endorsement.bukas_learn_more_url)}"
                                           target="_blank"
                                           rel="noopener noreferrer"
                                           class="btn btn-primary btn-sm">
                                            <i class="bi bi-box-arrow-up-right me-1"></i>Learn More
                                        </a>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}
