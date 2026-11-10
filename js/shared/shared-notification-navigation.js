import AppPaths from '../services/services-appPaths.js';
const REGISTRATION_TITLE_ROUTES = {
    'New student registration submitted': {
        masterfiles: 'masterfiles-students.html?tab=pending',
        csdl: '../masterfiles/masterfiles-students.html?tab=pending',
        finance: '../masterfiles/masterfiles-students.html?tab=pending',
    },
    'New registration awaiting balance setup': {
        masterfiles: '../assessment/assessment-balances-management.html#pendingRegistrationPanel',
        csdl: '../assessment/assessment-balances-management.html#pendingRegistrationPanel',
        assessment: 'assessment-balances-management.html#pendingRegistrationPanel',
    },
    'Student registration completed': {
        masterfiles: 'masterfiles-students.html',
        csdl: '../masterfiles/masterfiles-students.html',
        finance: '../masterfiles/masterfiles-students.html',
    },
    'Registration approved': {
        students: 'students-dashboard.html',
    },
};

const CHAT_NOTIFICATION_OFFICES = {
    'New CSDL Office Chat Message': 'csdl',
    'New Assessment Office Chat Message': 'assessment',
    'New COO Office Chat Message': 'coo',
    'New Branch Admin Office Chat Message': 'branch_admin',
    'New Assessment Chat Message': 'assessment',
};

function detectPortal() {
    const path = window.location.pathname || '';
    if (path.includes('/students/')) return 'students';
    if (path.includes('/masterfiles/')) return 'masterfiles';
    if (path.includes('/assessment/')) return 'assessment';
    if (path.includes('/cashier/')) return 'cashier';
    if (path.includes('/coo/')) return 'coo';
    if (path.includes('/branch-admin/')) return 'branch-admin';
    if (path.includes('/csdl/')) return 'csdl';
    return 'csdl';
}

function resolveLoanPageUrl(portal = detectPortal()) {
    switch (portal) {
        case 'assessment':
            return AppPaths.page('views/assessment/assessment-loans-management.html');
        case 'cashier':
            return AppPaths.page('views/cashier/cashier-loans-management.html');
        case 'coo':
            return AppPaths.page('views/coo/coo-loans-management.html');
        case 'branch-admin':
            return AppPaths.page('views/branch-admin/branch-admin-loans-mangement.html');
        case 'students':
            return null;
        default:
            return AppPaths.page('views/csdl/csdl-loans-management.html');
    }
}

/**
 * Resolve a relative or absolute navigation target for a notification item.
 *
 * @param {object} notif
 * @returns {string|null}
 */
export function resolveNotificationHref(notif) {
    if (!notif) return null;

    const loanId = notif.notification_loan_id || notif.loanId;
    const title = String(notif.notification_title || notif.title || '').trim();
    const portal = detectPortal();
    if (loanId) {
        if (title === 'Loan Ready for PN Tagging' && ['csdl', 'masterfiles', 'assessment'].includes(portal)) {
            const office = portal === 'assessment' ? 'assessment' : 'csdl';
            return AppPaths.page(`views/${office}/${office}-pn-tagging.html?openLoan=${encodeURIComponent(loanId)}`);
        }
        const chatOffice = CHAT_NOTIFICATION_OFFICES[title];
        if (chatOffice && portal === 'students') {
            return `students-chat.html?loanId=${encodeURIComponent(loanId)}&officeType=${encodeURIComponent(chatOffice)}`;
        }
        if (title === 'New Student Chat Message' && ['assessment', 'csdl', 'coo', 'branch-admin'].includes(portal)) {
            return `${resolveLoanPageUrl(portal)}?chatLoan=${encodeURIComponent(loanId)}`;
        }
        if (portal === 'students') {
            return `students-loans.html?openLoan=${encodeURIComponent(loanId)}`;
        }
        return resolveLoanPageUrl(portal);
    }

    const routes = REGISTRATION_TITLE_ROUTES[title];
    if (!routes) return null;

    return routes[portal] || routes.csdl || routes.masterfiles || routes.assessment || routes.students || null;
}

/**
 * @param {object} notif
 * @returns {string}
 */
export function getNotificationActionLabel(notif) {
    if (!notif) return 'View';

    const loanId = notif.notification_loan_id || notif.loanId;
    const title = String(notif.notification_title || notif.title || '').trim();
    if (loanId && (CHAT_NOTIFICATION_OFFICES[title] || title === 'New Student Chat Message')) return 'Open chat';
    if (loanId) return 'View loan';

    switch (title) {
        case 'New student registration submitted':
            return 'Review registration';
        case 'New registration awaiting balance setup':
            return 'Set up balance';
        case 'Student registration completed':
            return 'View students';
        case 'Registration approved':
            return 'Go to dashboard';
        default:
            return 'View';
    }
}

export function navigateFromNotification(notif) {
    const href = resolveNotificationHref(notif);
    if (!href) return false;
    window.location.href = href;
    return true;
}
