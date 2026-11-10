import {
    configurePortalBellNavigation,
    wirePortalViewAllLink,
    bindPortalNotificationDropdownClose,
    closePortalNotificationDropdown,
} from './shared-portal-notifications-bell.js';
import { initPortalNotificationsPage } from './shared-portal-notifications-page.js';
import { resolveNotificationHref, getNotificationActionLabel } from './shared-notification-navigation.js?v=20260927-office-threads';

export function setupPortalNotificationBell(notificationsPageUrl, state = { bound: false }) {
    configurePortalBellNavigation(notificationsPageUrl, state);
    wirePortalViewAllLink(notificationsPageUrl);
    bindPortalNotificationDropdownClose();
}

export function renderPortalNotificationPageItem(notif, formatTimeAgo, escapeHtml, loanActionLabel = 'View loan') {
    const isRead = notif.notification_is_read === 1 || notif.isRead === true;
    const date = new Date(notif.notification_created_at || notif.createdAt);
    const timeAgo = formatTimeAgo(date);
    const notificationId = notif.notification_id || notif.id;
    const loanId = notif.notification_loan_id || notif.loanId || '';
    const title = escapeHtml(notif.notification_title || notif.title || 'Notification');
    const message = escapeHtml(notif.notification_message || notif.message || '');
    const navHref = resolveNotificationHref(notif);
    const actionLabel = navHref ? getNotificationActionLabel(notif) : (loanId ? loanActionLabel : '');

    return `
        <button type="button"
            class="notifications-page-item ${!isRead ? 'notifications-page-item--unread' : ''}"
            data-notification-id="${notificationId}"
            ${loanId ? `data-loan-id="${loanId}"` : ''}
            ${navHref ? `data-nav-href="${escapeHtml(navHref)}"` : ''}>
            <div class="notifications-page-item__top">
                <div class="notifications-page-item__title">${title}</div>
                ${!isRead ? '<span class="notification-new-badge">New</span>' : ''}
            </div>
            <div class="notifications-page-item__message">${message}</div>
            <div class="notifications-page-item__meta">
                <span class="notifications-page-item__time">${timeAgo}</span>
                ${actionLabel ? `<span class="notifications-page-item__action">${escapeHtml(actionLabel)} <i class="bi bi-chevron-right" aria-hidden="true"></i></span>` : ''}
            </div>
        </button>`;
}

export async function bootstrapPortalNotificationsPage({
    service,
    formatTimeAgo,
    escapeHtml,
    onItemClick,
    onAfterLoad,
}) {
    await initPortalNotificationsPage({
        fetchPage: (page, pageSize) => service.fetchNotifications(null, page, pageSize),
        bindItem: {
            render: (notif) => renderPortalNotificationPageItem(notif, formatTimeAgo, escapeHtml),
            attach: (container) => {
                container.querySelectorAll('[data-notification-id]').forEach((item) => {
                    if (item.dataset.bound === '1') return;
                    item.dataset.bound = '1';
                    item.addEventListener('click', async () => {
                        const notificationId = parseInt(item.getAttribute('data-notification-id'), 10);
                        const loanId = item.getAttribute('data-loan-id');
                        const navHref = item.getAttribute('data-nav-href');
                        await onItemClick(notificationId, loanId, navHref);
                    });
                });
            },
            onMarkAll: () => service.markAllAsRead(),
        },
        getEmptyHtml: () => `
            <div class="notifications-page-empty text-center py-5">
                <i class="bi bi-bell-slash text-muted fs-1 d-block mb-3" aria-hidden="true"></i>
                <p class="text-muted mb-0">No notifications yet</p>
            </div>`,
        onAfterLoad,
    });
}

export { closePortalNotificationDropdown };
