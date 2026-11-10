/**
 * Visible inline row action buttons for masterfiles and loans tables.
 */

const PRESETS = {
    approve: { variant: 'approve', icon: 'bi-check-lg' },
    reject: { variant: 'reject', icon: 'bi-x-lg' },
    decline: { variant: 'decline', icon: 'bi-x-lg' },
    return: { variant: 'return', icon: 'bi-arrow-return-left' },
    edit: { variant: 'edit', icon: 'bi-pencil' },
    delete: { variant: 'delete', icon: 'bi-trash' },
    toggleOn: { variant: 'toggle', icon: 'bi-toggle-on' },
    toggleOff: { variant: 'toggle-off', icon: 'bi-toggle-off' },
    permissions: { variant: 'permissions', icon: 'bi-shield-lock' },
    periods: { variant: 'periods', icon: 'bi-calendar-range' },
    add: { variant: 'add', icon: 'bi-plus-lg' },
    tagPn: { variant: 'tag', icon: 'bi-tag-fill' },
    paid: { variant: 'approve', icon: 'bi-check-lg' },
    partial: { variant: 'return', icon: 'bi-cash-coin' },
    chat: { variant: 'info', icon: 'bi-chat-dots' },
};

function escAttr(value) {
    return String(value ?? '').replace(/"/g, '&quot;');
}

export function inlineActionButton({
    type,
    title,
    actionClass = '',
    dataAttrs = {},
    active = false,
} = {}) {
    const preset = PRESETS[type] || { variant: type, icon: 'bi-circle' };
    const dataStr = Object.entries(dataAttrs)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => ` data-${k}="${escAttr(v)}"`)
        .join('');
    const activeClass = active ? ' is-active' : '';
    const classes = [
        'inline-action-btn',
        `inline-action-btn--${preset.variant}`,
        actionClass,
        activeClass,
    ].filter(Boolean).join(' ');
    return `<button type="button" class="${classes}" title="${escAttr(title)}" aria-label="${escAttr(title)}"${dataStr}><i class="bi ${preset.icon}"></i></button>`;
}

export function inlineActionsRow(buttonsHtml) {
    if (!buttonsHtml) return '<span class="text-muted">—</span>';
    return `<div class="inline-row-actions" role="group">${buttonsHtml}</div>`;
}

/** Same centering wrapper used on masterfiles action columns. */
export function wrapLoanActionsCell(buttonsHtml) {
    if (!buttonsHtml || String(buttonsHtml).includes('text-muted')) {
        return buttonsHtml || '<span class="text-muted">—</span>';
    }
    return `<span class="d-inline-flex justify-content-center w-100 loan-actions-cell">${buttonsHtml}</span>`;
}

export function masterfileEditToggleDelete({ isActive, editClass = 'action-edit', toggleClass = 'action-toggle', deleteClass = 'action-delete' } = {}) {
    const active = String(isActive) === '1' || isActive === true;
    return inlineActionsRow(
        inlineActionButton({ type: 'edit', title: 'Edit', actionClass: editClass })
        + inlineActionButton({
            type: active ? 'toggleOn' : 'toggleOff',
            title: active ? 'Deactivate' : 'Activate',
            actionClass: toggleClass,
            active,
        })
        + inlineActionButton({ type: 'delete', title: 'Delete', actionClass: deleteClass })
    );
}

export function masterfileEditDelete({ editClass = 'action-edit', deleteClass = 'action-delete' } = {}) {
    return inlineActionsRow(
        inlineActionButton({ type: 'edit', title: 'Edit', actionClass: editClass })
        + inlineActionButton({ type: 'delete', title: 'Delete', actionClass: deleteClass })
    );
}

export function masterfileStudentActions(isActive) {
    const active = String(isActive) === '1';
    return inlineActionsRow(
        inlineActionButton({ type: 'edit', title: 'Edit', actionClass: 'action-edit' })
        + inlineActionButton({ type: 'periods', title: 'Manage Periods', actionClass: 'action-manage-periods' })
        + inlineActionButton({
            type: active ? 'toggleOn' : 'toggleOff',
            title: active ? 'Deactivate' : 'Activate',
            actionClass: 'action-toggle',
            active,
        })
        + inlineActionButton({ type: 'delete', title: 'Delete', actionClass: 'action-delete' })
    );
}

export function masterfileEmployeeActions(isActive) {
    const active = String(isActive) === '1';
    return inlineActionsRow(
        inlineActionButton({ type: 'edit', title: 'Edit', actionClass: 'action-edit' })
        + inlineActionButton({ type: 'permissions', title: 'Manage Permissions', actionClass: 'action-permissions' })
        + inlineActionButton({
            type: active ? 'toggleOn' : 'toggleOff',
            title: active ? 'Deactivate' : 'Activate',
            actionClass: 'action-toggle',
            active,
        })
        + inlineActionButton({ type: 'delete', title: 'Delete', actionClass: 'action-delete' })
    );
}

export function pendingRegistrationActions(studentId) {
    return inlineActionsRow(
        inlineActionButton({
            type: 'approve',
            title: 'Approve',
            actionClass: 'action-approve-registration',
            dataAttrs: { 'approve-registration': studentId },
        })
        + inlineActionButton({
            type: 'reject',
            title: 'Reject',
            actionClass: 'action-reject-registration',
            dataAttrs: { 'reject-registration': studentId },
        })
    );
}

export function loanProcessActions({ loanId, canProcess, permissions = {} }) {
    if (!canProcess && !permissions.chat) return '<span class="text-muted">—</span>';
    const id = loanId;
    const parts = [];
    if (canProcess && permissions.approve) {
        parts.push(inlineActionButton({
            type: 'approve',
            title: 'Approve',
            actionClass: 'action-approve',
            dataAttrs: { 'loan-id': id },
        }));
    }
    if (canProcess && permissions.decline) {
        parts.push(inlineActionButton({
            type: 'decline',
            title: 'Decline',
            actionClass: 'action-decline',
            dataAttrs: { 'loan-id': id },
        }));
    }
    if (canProcess && permissions.return) {
        parts.push(inlineActionButton({
            type: 'return',
            title: 'Return',
            actionClass: 'action-return',
            dataAttrs: { 'loan-id': id },
        }));
    }
    if (canProcess && permissions.partial) {
        parts.push(inlineActionButton({
            type: 'partial',
            title: 'Partial payment',
            actionClass: 'action-partial-payment',
            dataAttrs: { 'loan-id': id },
        }));
    }
    if (permissions.chat) {
        parts.push(inlineActionButton({
            type: 'chat',
            title: 'Chat with student',
            actionClass: 'action-loan-chat',
            dataAttrs: { 'loan-id': id },
        }));
    }
    return wrapLoanActionsCell(inlineActionsRow(parts.join('')));
}

export function balanceRowActions({ canEdit, canDelete }) {
    const parts = [];
    if (canEdit) {
        parts.push(inlineActionButton({ type: 'edit', title: 'Edit', actionClass: 'action-edit' }));
    }
    if (canDelete) {
        parts.push(inlineActionButton({ type: 'delete', title: 'Delete', actionClass: 'action-delete' }));
    }
    if (!parts.length) return '<span class="text-muted">—</span>';
    return inlineActionsRow(parts.join(''));
}

export function assessmentPnActions({ loanId, dueDate } = {}) {
    return wrapLoanActionsCell(inlineActionsRow(
        inlineActionButton({
            type: 'paid',
            title: 'Paid',
            actionClass: 'action-pn-paid',
            dataAttrs: { 'loan-id': loanId },
        })
        + inlineActionButton({
            type: 'partial',
            title: 'Partial',
            actionClass: 'action-pn-partial',
            dataAttrs: { 'loan-id': loanId, 'due-date': dueDate },
        })
    ));
}

/** Assessment queue: PN tagging actions. */
export function assessmentQueueActions({ loanId, dueDate, permissions = {} } = {}) {
    const parts = [];

    if (permissions.tagPn) {
        parts.push(inlineActionButton({
            type: 'paid',
            title: 'Paid',
            actionClass: 'action-pn-paid',
            dataAttrs: { 'loan-id': loanId },
        }));
        parts.push(inlineActionButton({
            type: 'partial',
            title: 'Partial',
            actionClass: 'action-pn-partial',
            dataAttrs: { 'loan-id': loanId, 'due-date': dueDate },
        }));
    }
    if (!parts.length) {
        return '<span class="text-muted">—</span>';
    }

    return `<span class="assessment-intake-actions">${inlineActionsRow(parts.join(''))}</span>`;
}

/** Selector for click handlers to ignore when opening row details */
export const INLINE_ACTION_IGNORE = '.loan-actions-cell, .inline-row-actions, .inline-action-btn, .assessment-intake-actions';
