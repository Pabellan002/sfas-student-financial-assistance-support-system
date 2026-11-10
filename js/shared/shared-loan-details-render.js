/**
 * Shared module for rendering loan details in a modern, card-based design
 * Used across all loan management modules (CSDL, Branch Admin, COO, Finance, Assessment)
 */

import { escapeHtml } from './shared-escape.js';

/**
 * Renders the complete loan details in a modern card-based layout
 * @param {Object} loan - The loan object with all details
 * @param {Function} getStatusBadgeClass - Function to get badge class for status
 * @param {Function} getDisplayStatusName - Function to get display name for status
 * @param {Object} options - Additional options for rendering
 * @returns {string} HTML string for loan details
 */
export function renderModernLoanDetails(loan, getStatusBadgeClass, getDisplayStatusName, options = {}) {
    const {
        showVerifyButton = false,
        verifyFunctionName = 'verifyDocument',
        moduleName = 'loansManagementModule',
        paymentStatusBadgeClass = '',
        pnStatusBadgeClass = ''
    } = options;

    const paymentBadge = renderPaymentStatusBadge(loan.payment_status || loan.paymentStatus, paymentStatusBadgeClass);
    const pnBadge = renderPNStatusBadge(loan.pnStatus || loan.pn_status, pnStatusBadgeClass);
    
    return `
        <div class="loan-details-modern">
            <!-- Main Information Sections -->
            <div class="row">
                <!-- Left Column -->
                <div class="col-md-6">
                    ${renderApplicationSection(loan, getStatusBadgeClass, getDisplayStatusName, paymentBadge, pnBadge)}
                    ${renderFinancialSection(loan)}
                </div>
                
                <!-- Right Column -->
                <div class="col-md-6">
                    ${renderStudentSection(loan)}
                    ${loan.guardian_name ? renderGuardianSection(loan) : ''}
                </div>
            </div>

            <!-- Documents Section -->
            ${loan.documents && loan.documents.length > 0 ? renderDocumentsSection(loan, showVerifyButton, verifyFunctionName, moduleName) : ''}
        </div>

        <style>
            .loan-details-modern {
                font-size: 0.9375rem;
            }
            
            .loan-section-title {
                font-size: 1rem;
                font-weight: 700;
                color: #0c4a24;
                margin-bottom: 1rem;
                padding-bottom: 0.5rem;
                border-bottom: 2px solid #0c4a24;
            }
            
            .loan-info-row {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                padding: 0.75rem 0;
                border-bottom: 1px solid rgba(0, 0, 0, 0.1);
                gap: 1rem;
            }
            
            .loan-info-row:last-child {
                border-bottom: none;
            }
            
            .loan-info-row__label {
                color: #6c757d;
                font-size: 0.875rem;
                font-weight: 500;
                flex-shrink: 0;
                min-width: 140px;
            }
            
            .loan-info-row__value {
                font-weight: 600;
                color: #212529;
                text-align: right;
                word-break: break-word;
            }
            
            .loan-document-card {
                background: #f8f9fa;
                border: 1px solid rgba(0, 0, 0, 0.1);
                border-radius: 6px;
                padding: 1rem;
                margin-bottom: 0.75rem;
            }
            
            .loan-document-card__header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0.75rem;
                flex-wrap: wrap;
                gap: 0.5rem;
            }
            
            .loan-document-card__title {
                font-weight: 600;
                font-size: 0.9375rem;
                color: #212529;
                margin: 0;
            }
            
            .loan-document-card__filename {
                font-size: 0.8125rem;
                color: #6c757d;
                margin-bottom: 0.5rem;
            }
            
            .loan-document-preview {
                text-align: center;
                margin-top: 0.75rem;
            }
            
            .loan-document-preview img {
                max-width: 100%;
                max-height: 400px;
                width: auto;
                height: auto;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                cursor: pointer;
                transition: transform 0.2s ease;
            }
            
            .loan-document-preview img:hover {
                transform: scale(1.02);
            }
            
            .loan-timeline {
                margin-top: 1.5rem;
            }
            
            .loan-timeline__title {
                font-size: 1rem;
                font-weight: 700;
                color: #0c4a24;
                margin-bottom: 1rem;
                padding-bottom: 0.5rem;
                border-bottom: 2px solid #0c4a24;
            }
            
            .loan-timeline__item {
                position: relative;
                padding-left: 2.5rem;
                padding-bottom: 1.5rem;
            }
            
            .loan-timeline__item:last-child {
                padding-bottom: 0;
            }
            
            .loan-timeline__item::before {
                content: '';
                position: absolute;
                left: 0.6875rem;
                top: 2rem;
                bottom: 0;
                width: 2px;
                background: linear-gradient(180deg, #0c4a24 0%, rgba(12, 74, 36, 0.2) 100%);
            }
            
            .loan-timeline__item:last-child::before {
                display: none;
            }
            
            .loan-timeline__icon {
                position: absolute;
                left: 0;
                top: 0;
                width: 2rem;
                height: 2rem;
                background: #0c4a24;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 0.875rem;
                box-shadow: 0 0 0 4px white, 0 0 0 6px rgba(12, 74, 36, 0.1);
            }
            
            .loan-timeline__content {
                background: #f8f9fa;
                padding: 1rem;
                border-radius: 8px;
                border-left: 3px solid #0c4a24;
            }
            
            .loan-timeline__status {
                font-weight: 700;
                color: #0c4a24;
                margin-bottom: 0.25rem;
            }
            
            .loan-timeline__date {
                font-size: 0.8125rem;
                color: #6c757d;
                margin-bottom: 0.5rem;
            }
            
            .loan-timeline__remarks {
                font-size: 0.875rem;
                color: #495057;
                margin: 0;
            }
            
            @media (max-width: 767.98px) {
                .loan-summary-card__value {
                    font-size: 1.25rem;
                }
                
                .loan-info-row {
                    flex-direction: column;
                    gap: 0.25rem;
                }
                
                .loan-info-row__label {
                    min-width: auto;
                }
                
                .loan-info-row__value {
                    text-align: left;
                }
            }
        </style>
    `;
}

function renderApplicationSection(loan, getStatusBadgeClass, getDisplayStatusName, paymentBadge, pnBadge) {
    // Format dates
    const formatDate = (dateStr) => {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch {
            return dateStr;
        }
    };
    
    return `
        <div class="mb-4">
            <h6 class="loan-section-title">
                <i class="bi bi-file-earmark-text me-2"></i>Application Information
            </h6>
            <div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Application No.</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.loan_application_no || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Application Date</span>
                    <span class="loan-info-row__value">${formatDate(loan.loan_application_date)}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Status</span>
                    <span class="loan-info-row__value">
                        <span class="badge ${getStatusBadgeClass(loan.loan_status_id)}">${escapeHtml(getDisplayStatusName(loan))}</span>
                    </span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Payment Status</span>
                    <span class="loan-info-row__value">${paymentBadge}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">PN Status</span>
                    <span class="loan-info-row__value">${pnBadge}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Current Step</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.current_step_name || '-')}</span>
                </div>
                ${loan.loan_reason ? `
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Reason</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.loan_reason)}</span>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

function renderFinancialSection(loan) {
    const totalBalance = parseFloat(loan.balance_total_balance || 0);
    const currentBalance = parseFloat(loan.balance_current_balance || 0);
    const advisedToPay = parseFloat(loan.balance_advice_to_pay ?? loan.balance_advised_to_pay ?? 0);
    const amountCanPay = parseFloat(loan.loan_amount_can_pay || 0);
    const recordedPaymentAmount = parseFloat(loan.loan_recorded_payment_amount || 0);
    const partialPaymentAmount = parseFloat(loan.loan_partial_payment_amount || 0);
    const isPartialPayment = Number(loan.loan_status_id) === 11 || Number(loan.loan_payment_status_id) === 2;
    
    // Format dates
    const formatDate = (dateStr) => {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch {
            return dateStr;
        }
    };
    
    return `
        <div class="mb-4">
            <h6 class="loan-section-title">
                <i class="bi bi-calculator me-2"></i>Financial Information
            </h6>
            <div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Total Balance</span>
                    <span class="loan-info-row__value">₱${totalBalance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Current Balance</span>
                    <span class="loan-info-row__value">₱${currentBalance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Advised to Pay</span>
                    <span class="loan-info-row__value">₱${advisedToPay.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Amount Can Pay</span>
                    <span class="loan-info-row__value">₱${amountCanPay.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                ${recordedPaymentAmount > 0 ? `
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Amount Paid</span>
                    <span class="loan-info-row__value text-primary fw-bold">₱${recordedPaymentAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                ` : ''}
                ${isPartialPayment && partialPaymentAmount > 0 ? `
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Partial Payment Amount</span>
                    <span class="loan-info-row__value text-warning fw-bold">₱${partialPaymentAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                ` : ''}
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Promised Date</span>
                    <span class="loan-info-row__value">${formatDate(loan.loan_promised_payment_date)}</span>
                </div>
            </div>
        </div>
    `;
}

function renderStudentSection(loan) {
    return `
        <div class="mb-4">
            <h6 class="loan-section-title">
                <i class="bi bi-person me-2"></i>Student Information
            </h6>
            <div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Student ID</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.student_school_id || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Name</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.student_name || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Program</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.program_name || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Year Level</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.year_level_name || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Campus</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.campus_name || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Scholarship</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.scholarship_name || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Email</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.student_email || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Contact</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.student_contact_number || '-')}</span>
                </div>
            </div>
        </div>
    `;
}

function renderGuardianSection(loan) {
    return `
        <div class="mb-4">
            <h6 class="loan-section-title">
                <i class="bi bi-people me-2"></i>Guardian Information
            </h6>
            <div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Name</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.guardian_name || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Relationship</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.guardian_relationship || '-')}</span>
                </div>
                <div class="loan-info-row">
                    <span class="loan-info-row__label">Contact</span>
                    <span class="loan-info-row__value">${escapeHtml(loan.guardian_contact || '-')}</span>
                </div>
            </div>
        </div>
    `;
}

function renderDocumentsSection(loan, showVerifyButton, verifyFunctionName, moduleName) {
    return `
        <div class="row mt-4">
            <div class="col-12">
                <h6 class="loan-section-title">
                    <i class="bi bi-paperclip me-2"></i>Uploaded Documents
                </h6>
                <div>
                    ${loan.documents.map(doc => renderDocumentCard(doc, loan.loan_id, showVerifyButton, verifyFunctionName, moduleName)).join('')}
                </div>
            </div>
        </div>
    `;
}

function renderDocumentCard(doc, loanId, showVerifyButton, verifyFunctionName, moduleName) {
    const isImage = /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(doc.loan_document_file_path || '');
    const fileUrl = `../../${encodeURI(String(doc.loan_document_file_path || ''))}`;
    const reviewStatus = doc.guardian_review_status || '';
    let reviewEvidence = null;
    try { reviewEvidence = doc.guardian_review_evidence ? JSON.parse(doc.guardian_review_evidence) : null; } catch (_) { /* Malformed evidence is not trusted. */ }
    
    return `
        <div class="loan-document-card">
            <div class="loan-document-card__header">
                <div class="d-flex align-items-center gap-2">
                    <h6 class="loan-document-card__title">${escapeHtml(doc.doc_type_name || 'Document')}</h6>
                    <span class="badge ${reviewStatus === 'pending' ? 'bg-warning text-dark' : reviewStatus === 'reviewed' ? 'bg-success' : 'bg-secondary'}">
                        ${reviewStatus === 'pending' ? 'CSDL Review Required' : reviewStatus === 'reviewed' ? 'Reviewed by CSDL' : 'Submitted'}
                    </span>
                </div>
                ${reviewStatus === 'pending' && showVerifyButton ? `
                    <button type="button" class="btn btn-sm btn-success" 
                            onclick="window.${moduleName}.${verifyFunctionName}(${loanId}, ${doc.loan_document_id})">
                        <i class="bi bi-check-circle me-1"></i>Record Review
                    </button>
                ` : ''}
            </div>
            ${reviewStatus === 'pending' && reviewEvidence && showVerifyButton ? `
                <div class="small text-muted mb-2">OCR evidence: ${escapeHtml(reviewEvidence.visible_holder_name || 'name unreadable')} · ${escapeHtml(reviewEvidence.visible_document_label || 'type unreadable')}. Check the uploaded image before recording review.</div>
            ` : ''}
            <div class="loan-document-card__filename">
                <i class="bi bi-file-earmark me-1"></i>${escapeHtml(doc.loan_document_file_name || '-')}
            </div>
            ${isImage ? `
                <div class="loan-document-preview">
                    <img src="${escapeHtml(fileUrl)}" 
                         alt="${escapeHtml(doc.doc_type_name || 'Document')}" 
                         onclick="window.open('${escapeHtml(fileUrl)}', '_blank')"
                         loading="lazy">
                </div>
            ` : `
                <a href="${escapeHtml(fileUrl)}" target="_blank" class="btn btn-outline-primary btn-sm">
                    <i class="bi bi-download me-1"></i>Download Document
                </a>
            `}
        </div>
    `;
}

function renderPaymentStatusBadge(paymentStatus, badgeClass = '') {
    const s = String(paymentStatus || '').trim() || 'Not Paid';
    const cls = badgeClass || (s === 'Paid' ? 'bg-success' : (s === 'Paid Pending' ? 'bg-info text-dark' : ((s === 'Partial Payment' || s === 'Paid Partial') ? 'bg-warning text-dark' : 'bg-secondary')));
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}

function renderPNStatusBadge(pnStatus, badgeClass = '') {
    const s = String(pnStatus || '').trim();
    const label = s || 'Not Tagged';
    const cls = badgeClass || (label === 'Tagged' ? 'bg-success' : 'bg-secondary');
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

export default {
    renderModernLoanDetails,
    renderPaymentStatusBadge,
    renderPNStatusBadge
};
