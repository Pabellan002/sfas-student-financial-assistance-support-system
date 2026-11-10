import AppPaths from '../services/services-appPaths.js';
const REFRESH_INTERVAL_MS = 15000;

const COUNT_TARGETS = [
    { page: 'csdl-loans-management.html', api: 'csdl/csdl-loans-management.php?action=stats', path: 'stats.pending', label: 'pending applications' },
    { page: 'csdl-pn-tagging.html', api: 'csdl/csdl-pn-tagging.php?action=stats', path: 'stats.pending', label: 'applications awaiting PN tagging' },
    { page: 'masterfiles-students.html', api: 'masterfiles/masterfiles-students.php?action=counts', path: 'pendingRegistrations', label: 'pending registrations' },
    { page: 'students-chat.html', api: 'shared/shared-loan-chat.php?action=unread_count', path: 'unreadCount', label: 'unread chat messages' },
    { page: 'assessment-loans-management.html', api: 'assessment/assessment-loan-management.php?action=stats', path: 'stats.allApplications', label: 'pending applications' },
    { page: 'assessment-balances-management.html', api: 'assessment/assessment-balances-management.php?action=count', path: 'pendingBalanceRegistrations', label: 'pending balance registrations' },
    { page: 'assessment-pn-tagging.html', api: 'assessment/assessment-pn-tagging.php?action=stats', path: 'stats.pending', label: 'applications awaiting PN tagging' },
    { page: 'coo-loans-management.html', api: 'coo/coo-loan-management.php?action=stats', path: 'stats.pending', label: 'pending applications' },
    { page: 'branch-admin-loans-mangement.html', api: 'branch-admin/branch-admin-loan-management.php?action=list&page=1&perPage=1', path: 'stats.pending', label: 'pending applications' },
    { page: 'cashier-loans-management.html', api: 'cashier/cashier-loan-management.php?action=payment_tagging_stats', path: 'stats.readyForPayment', label: 'loans ready for payment' },
];

function getApplicationBasePath() {
    return AppPaths.basePath;
}

function installLiveCountStyles() {
    if (document.getElementById('sidebarLiveCountStyles')) return;
    const style = document.createElement('style');
    style.id = 'sidebarLiveCountStyles';
    style.textContent = `
        .sidebar-live-count{display:inline-flex;align-items:center;justify-content:center;min-width:1.45rem;height:1.25rem;padding:0 .38rem;border-radius:999px;background:#dc3545;color:#fff;font-size:.68rem;font-weight:700;line-height:1;flex:0 0 auto}
        .nav-link.active .sidebar-live-count{background:#fff;color:#087326}
        #studentMobileBottomNav .student-mobile-bottom-nav__link{position:relative}
        #studentMobileBottomNav .student-mobile-chat-count{position:absolute;top:.15rem;right:.3rem;min-width:1.15rem;height:1.15rem;padding:0 .2rem;font-size:.62rem}
    `;
    document.head.appendChild(style);
}

function injectSidebarLiveCountBadges() {
    const sidebar = document.getElementById('sidebarMenu');
    const appBase = getApplicationBasePath();
    sidebar?.querySelectorAll('a[href]').forEach((link) => {
        const rawHref = link.getAttribute('href') || '';
        const target = COUNT_TARGETS.find((item) => rawHref.split(/[?#]/)[0].endsWith(item.page));
        if (!target || link.querySelector('.sidebar-live-count')) return;
        link.classList.add('d-flex', 'align-items-center');
        const badge = document.createElement('span');
        badge.className = 'sidebar-live-count ms-auto';
        badge.dataset.liveCountUrl = `${appBase}/api/${target.api}`;
        badge.dataset.liveCountPath = target.path;
        badge.dataset.liveCountLabel = target.label;
        badge.style.display = 'none';
        badge.textContent = '0';
        link.appendChild(badge);
    });

    const mobileChatLink = Array.from(document.querySelectorAll('#studentMobileBottomNav a[href]'))
        .find((link) => /(?:students-chat\.html|\/students\/chat)$/.test((link.getAttribute('href') || '').split(/[?#]/)[0]));
    if (mobileChatLink && !mobileChatLink.querySelector('.student-mobile-chat-count')) {
        const target = COUNT_TARGETS.find((item) => item.page === 'students-chat.html');
        const badge = document.createElement('span');
        badge.className = 'sidebar-live-count student-mobile-chat-count';
        badge.dataset.liveCountUrl = `${appBase}/api/${target.api}`;
        badge.dataset.liveCountPath = target.path;
        badge.dataset.liveCountLabel = target.label;
        badge.style.display = 'none';
        badge.textContent = '0';
        mobileChatLink.appendChild(badge);
    }
}

function readPath(source, path) {
    return String(path || '').split('.').reduce((value, key) => value?.[key], source);
}

function normalizeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
}

function renderCount(element, count) {
    element.textContent = count > 99 ? '99+' : String(count);
    element.style.display = count > 0 ? '' : 'none';
    const label = element.dataset.liveCountLabel || 'records';
    element.setAttribute('title', `${count} ${label}`);
    element.setAttribute('aria-label', `${count} ${label}`);
}

function observeDirectCountUpdates() {
    document.querySelectorAll('[data-live-count-url][data-live-count-path]').forEach((element) => {
        if (element.dataset.liveCountObserved) return;
        element.dataset.liveCountObserved = 'true';
        new MutationObserver(() => {
            const count = Number.parseInt(element.textContent, 10) || 0;
            element.style.display = count > 0 ? '' : 'none';
        }).observe(element, { childList: true, characterData: true, subtree: true });
    });
}

async function refreshSidebarLiveCounts() {
    const elements = Array.from(document.querySelectorAll('[data-live-count-url][data-live-count-path]'));
    const groups = new Map();
    elements.forEach((element) => {
        const url = element.dataset.liveCountUrl;
        if (!groups.has(url)) groups.set(url, []);
        groups.get(url).push(element);
    });

    await Promise.all(Array.from(groups.entries()).map(async ([url, targets]) => {
        try {
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || data?.success === false) return;
            targets.forEach((element) => renderCount(element, normalizeCount(readPath(data, element.dataset.liveCountPath))));
        } catch (_) {
            // Preserve the last count if a background refresh is interrupted.
        }
    }));
}

function initSidebarLiveCounts() {
    if (window.__sidebarLiveCountsInitialized) return;
    window.__sidebarLiveCountsInitialized = true;
    installLiveCountStyles();
    injectSidebarLiveCountBadges();
    observeDirectCountUpdates();
    if (!document.querySelector('[data-live-count-url][data-live-count-path]')) return;
    refreshSidebarLiveCounts();
    window.setInterval(() => {
        if (!document.hidden) refreshSidebarLiveCounts();
    }, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshSidebarLiveCounts();
    });
    window.addEventListener('sidebar-live-counts:refresh', refreshSidebarLiveCounts);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarLiveCounts, { once: true });
} else {
    initSidebarLiveCounts();
}

export { refreshSidebarLiveCounts };
