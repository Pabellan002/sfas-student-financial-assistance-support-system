import notificationService from '../../services/services-notificationService.js';
import webPushService from '../../services/services-webPushService.js';
import { resolveNotificationHref, getNotificationActionLabel } from '../../shared/shared-notification-navigation.js?v=20260927-office-threads';

class StudentsNotificationsModule {
    static NOTIFICATIONS_PAGE = 'students-notifications.html';
    static MOBILE_BREAKPOINT = '(max-width: 991.98px)';
    static PAGE_SIZE = 20;

    constructor() {
        this.unreadCount = 0;
        this.notifications = [];
        this.pagePagination = { page: 1, perPage: StudentsNotificationsModule.PAGE_SIZE, total: 0, totalPages: 1 };
        this._bellMediaBound = false;
        this._globalNotificationCloseBound = false;
        this.lastNotificationId = null;
        this.isFirstLoad = true;
        this.hasShownInitialToast = false; // Track if we've shown the initial toast
    }

    async init() {
        const isStudentPage = window.location.pathname.includes('/students/');
        if (!isStudentPage) {
            return;
        }

        // Request notification permission early (especially important for mobile)
        await this.requestNotificationPermission();

        await this.loadNotifications();
        await this.initWebPush();
        this.configureBellNavigation();
        this.setupEventListeners();

        if (this.isNotificationsPage()) {
            await this.initNotificationsPage();
        }
    }

    isNotificationsPage() {
        return /\/students\/(?:students-)?notifications(?:\.html)?$/.test(window.location.pathname);
    }

    async initWebPush() {
        try {
            const initialized = await webPushService.init();
            
            if (initialized) {
                const isSubscribed = await webPushService.isSubscribed();
                
                if (!isSubscribed) {
                    if (Notification.permission === 'default' || Notification.permission === 'granted') {
                        await webPushService.subscribe();
                    }
                }
            } else {
                this.setupPolling();
            }
        } catch (error) {
            console.error('[WebPush] Initialization error:', error);
            this.setupPolling();
        }
    }

    setupPolling() {
        this.pollInterval = setInterval(async () => {
            await this.loadNotifications();
            if (this.isNotificationsPage()) {
                await this.loadNotificationsPage(this.pagePagination.page, false);
            }
        }, 30000);
    }

    async loadNotifications() {
        try {
            const response = await notificationService.fetchNotifications(10);
            if (response.success) {
                const newNotifications = response.notifications || [];
                const unreadFromList = newNotifications.filter((n) => !(n.notification_is_read === 1 || n.isRead === true)).length;
                
                // Just update the notification list - Web Push notifications are handled by service worker
                // No need to show native notifications here as they're sent from the server
                
                // Set initial last notification ID on first load
                if (this.isFirstLoad && newNotifications.length > 0) {
                    this.lastNotificationId = newNotifications[0].notification_id || newNotifications[0].id;
                    this.isFirstLoad = false;
                }
                // Update last notification ID for subsequent loads
                else if (!this.isFirstLoad && newNotifications.length > 0) {
                    const latestId = newNotifications[0].notification_id || newNotifications[0].id;
                    this.lastNotificationId = latestId;
                }
                
                this.notifications = newNotifications;
                this.unreadCount = Number.isFinite(response.unreadCount) ? response.unreadCount : unreadFromList;
                this.updateDropdownUI();
            }
        } catch (error) {
            console.error('Error loading notifications:', error);
        }
    }

    async loadNotificationsPage(page = 1, append = false) {
        const listEl = document.getElementById('notificationsPageList');
        if (!listEl) return;

        if (!append) {
            listEl.innerHTML = `
                <div class="notifications-page-loading text-center py-5">
                    <div class="spinner-border text-secondary" role="status"><span class="visually-hidden">Loading…</span></div>
                    <p class="mt-3 text-muted small mb-0">Loading notifications…</p>
                </div>`;
        }

        try {
            const response = await notificationService.fetchNotifications(null, page, StudentsNotificationsModule.PAGE_SIZE);
            if (!response.success) {
                listEl.innerHTML = '<div class="notification-empty">Unable to load notifications.</div>';
                return;
            }

            const items = response.notifications || [];
            this.pagePagination = response.pagination || this.pagePagination;
            this.unreadCount = Number.isFinite(response.unreadCount) ? response.unreadCount : this.unreadCount;
            this.updateDropdownUI();

            if (items.length === 0 && page === 1) {
                listEl.innerHTML = `
                    <div class="notifications-page-empty text-center py-5">
                        <i class="bi bi-bell-slash text-muted fs-1 d-block mb-3" aria-hidden="true"></i>
                        <p class="text-muted mb-0">No notifications yet</p>
                        <p class="text-muted small mt-1">Updates about your loan applications will appear here.</p>
                    </div>`;
                this.updatePageFooter();
                return;
            }

            const html = items.map((notif) => this.renderPageNotificationItem(notif)).join('');
            if (append) {
                listEl.insertAdjacentHTML('beforeend', html);
            } else {
                listEl.innerHTML = html;
            }

            this.bindPageNotificationClicks(listEl);
            this.updatePageFooter();
        } catch (error) {
            console.error('Error loading notifications page:', error);
            listEl.innerHTML = '<div class="notification-empty">Unable to load notifications.</div>';
        }
    }

    renderPageNotificationItem(notif) {
        const isRead = notif.notification_is_read === 1 || notif.isRead === true;
        const date = new Date(notif.notification_created_at || notif.createdAt);
        const timeAgo = this.formatTimeAgo(date);
        const notificationId = notif.notification_id || notif.id;
        const loanId = notif.notification_loan_id || notif.loanId || '';
        const title = this.escapeHtml(notif.notification_title || notif.title || 'Notification');
        const message = this.escapeHtml(notif.notification_message || notif.message || '');
        const navHref = resolveNotificationHref(notif);
        const actionLabel = navHref ? getNotificationActionLabel(notif) : (loanId ? 'View loan' : '');

        return `
            <button type="button"
                class="notifications-page-item ${!isRead ? 'notifications-page-item--unread' : ''}"
                data-notification-id="${notificationId}"
                ${loanId ? `data-loan-id="${loanId}"` : ''}
                ${navHref ? `data-nav-href="${this.escapeHtml(navHref)}"` : ''}>
                <div class="notifications-page-item__top">
                    <div class="notifications-page-item__title">${title}</div>
                    ${!isRead ? '<span class="notification-new-badge">New</span>' : ''}
                </div>
                <div class="notifications-page-item__message">${message}</div>
                <div class="notifications-page-item__meta">
                    <span class="notifications-page-item__time">${timeAgo}</span>
                    ${actionLabel ? `<span class="notifications-page-item__action">${this.escapeHtml(actionLabel)} <i class="bi bi-chevron-right" aria-hidden="true"></i></span>` : ''}
                </div>
            </button>`;
    }

    bindPageNotificationClicks(container) {
        container.querySelectorAll('[data-notification-id]').forEach((item) => {
            if (item.dataset.bound === '1') return;
            item.dataset.bound = '1';
            item.addEventListener('click', async () => {
                const notificationId = parseInt(item.getAttribute('data-notification-id'), 10);
                const loanId = item.getAttribute('data-loan-id');
                const navHref = item.getAttribute('data-nav-href');
                await this.handleNotificationClick(notificationId, loanId, navHref);
            });
        });
    }

    updatePageFooter() {
        const summaryEl = document.getElementById('notificationsPageSummary');
        const loadMoreBtn = document.getElementById('notificationsPageLoadMore');
        const markAllBtn = document.getElementById('notificationsPageMarkAllBtn');

        if (summaryEl) {
            const { total, page, totalPages } = this.pagePagination;
            if (total > 0) {
                summaryEl.textContent = `Showing page ${page} of ${totalPages} · ${total} total`;
            } else {
                summaryEl.textContent = '';
            }
        }

        if (loadMoreBtn) {
            const hasMore = this.pagePagination.page < this.pagePagination.totalPages;
            loadMoreBtn.classList.toggle('d-none', !hasMore);
            loadMoreBtn.disabled = false;
        }

        if (markAllBtn) {
            markAllBtn.disabled = this.unreadCount <= 0;
        }
    }

    async initNotificationsPage() {
        const markAllBtn = document.getElementById('notificationsPageMarkAllBtn');
        const loadMoreBtn = document.getElementById('notificationsPageLoadMore');

        if (markAllBtn) {
            markAllBtn.addEventListener('click', async () => {
                await this.markAllAsRead();
                await this.loadNotificationsPage(1, false);
            });
        }

        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', async () => {
                const nextPage = this.pagePagination.page + 1;
                if (nextPage > this.pagePagination.totalPages) return;
                loadMoreBtn.disabled = true;
                await this.loadNotificationsPage(nextPage, true);
            });
        }

        await this.loadNotificationsPage(1, false);
    }

    configureBellNavigation() {
        const toggle = this.getNotificationToggleElement();
        if (!toggle) return;

        const mql = window.matchMedia(StudentsNotificationsModule.MOBILE_BREAKPOINT);

        const apply = () => {
            if (window.bootstrap?.Dropdown) {
                const instance = window.bootstrap.Dropdown.getInstance(toggle);
                if (instance) instance.dispose();
            }

            const isMobile = mql.matches;

            if (isMobile) {
                toggle.setAttribute('href', StudentsNotificationsModule.NOTIFICATIONS_PAGE);
                toggle.removeAttribute('data-bs-toggle');
                toggle.removeAttribute('role');
                toggle.removeAttribute('aria-expanded');
                toggle.removeAttribute('data-bs-popper-config');
                toggle.removeAttribute('data-bs-boundary');
                this.closeNotificationDropdown();
            } else {
                toggle.setAttribute('href', '#');
                toggle.setAttribute('data-bs-toggle', 'dropdown');
                toggle.setAttribute('role', 'button');
                toggle.setAttribute('data-bs-popper-config', '{"strategy":"fixed"}');
                toggle.setAttribute('data-bs-boundary', 'viewport');
            }
        };

        apply();

        if (!this._bellMediaBound) {
            this._bellMediaBound = true;
            mql.addEventListener('change', apply);
        }
    }

    setupEventListeners() {
        const markAllReadBtn = document.getElementById('markAllReadBtn');
        if (markAllReadBtn) {
            markAllReadBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.markAllAsRead();
                this.closeNotificationDropdown();
                if (this.isNotificationsPage()) {
                    await this.loadNotificationsPage(1, false);
                }
            });
        }

        const viewAllLink = document.querySelector('.notifications-view-all');
        if (viewAllLink) {
            viewAllLink.setAttribute('href', StudentsNotificationsModule.NOTIFICATIONS_PAGE);
            viewAllLink.addEventListener('click', () => {
                this.closeNotificationDropdown();
            });
        }

        const notificationBell = this.getNotificationToggleElement();
        if (notificationBell && 'Notification' in window && Notification.permission === 'default') {
            notificationBell.addEventListener('click', () => {
                if (window.matchMedia(StudentsNotificationsModule.MOBILE_BREAKPOINT).matches) {
                    return;
                }
                if (Notification.permission === 'default') {
                    Notification.requestPermission();
                }
            });
        }

        this.bindGlobalNotificationClose();
    }

    bindGlobalNotificationClose() {
        if (this._globalNotificationCloseBound) return;
        this._globalNotificationCloseBound = true;

        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            const bellToggle = this.getNotificationToggleElement();
            const menu = this.getNotificationMenuElement();
            if (!bellToggle || !menu) return;

            if (window.matchMedia(StudentsNotificationsModule.MOBILE_BREAKPOINT).matches) return;

            if (target.closest('#notificationsList')) return;
            if (target.closest('#markAllReadBtn')) return;
            if (target.closest('.notifications-view-all')) return;
            if (target.closest('[data-bs-toggle="dropdown"]') === bellToggle) return;
            if (target.closest('.notifications-menu') === menu) return;

            this.closeNotificationDropdown();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeNotificationDropdown();
            }
        });

        window.addEventListener('scroll', () => this.closeNotificationDropdown(), { passive: true });
        window.addEventListener('touchmove', () => this.closeNotificationDropdown(), { passive: true });
        window.addEventListener('resize', () => this.closeNotificationDropdown(), { passive: true });

        document.querySelector('.navbar-toggler')?.addEventListener('click', () => this.closeNotificationDropdown());
        document.getElementById('mobileSidebarCloseBtn')?.addEventListener('click', () => this.closeNotificationDropdown());
        document.getElementById('mobileSidebarOverlay')?.addEventListener('click', () => this.closeNotificationDropdown());

        document.addEventListener('show.bs.dropdown', (e) => {
            const toggle = e.target;
            if (!(toggle instanceof Element)) return;
            const bellToggle = this.getNotificationToggleElement();
            if (bellToggle && toggle !== bellToggle) {
                this.closeNotificationDropdown();
            }
        });
    }

    getNotificationToggleElement() {
        return document.querySelector('.notifications-bell-link');
    }

    getNotificationMenuElement() {
        return document.querySelector('.notifications-menu');
    }

    closeNotificationDropdown() {
        const toggle = this.getNotificationToggleElement();
        const menu = this.getNotificationMenuElement();
        if (!menu || !toggle) return;

        if (window.bootstrap?.Dropdown) {
            try {
                const instance = window.bootstrap.Dropdown.getOrCreateInstance(toggle);
                instance.hide();
                return;
            } catch (_) {
                // Fallback below.
            }
        }

        menu.classList.remove('show');
        toggle.classList.remove('show');
        toggle.setAttribute('aria-expanded', 'false');
    }

    updateDropdownUI() {
        const countBadge = document.getElementById('notificationCount');
        if (countBadge) {
            if (this.unreadCount > 0) {
                countBadge.textContent = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
                countBadge.style.display = 'inline-flex';
                countBadge.style.alignItems = 'center';
                countBadge.style.justifyContent = 'center';
                countBadge.style.minWidth = '18px';
                countBadge.style.height = '18px';
                countBadge.style.padding = '0 5px';
                countBadge.style.fontSize = '0.65rem';
                countBadge.style.lineHeight = '1';
            } else {
                countBadge.style.display = 'none';
            }
        }

        const notificationsList = document.getElementById('notificationsList');
        if (!notificationsList) return;

        if (this.notifications.length === 0) {
            notificationsList.innerHTML = '<div class="notification-empty">No notifications yet</div>';
            return;
        }

        notificationsList.innerHTML = this.notifications.map((notif) => {
            const isRead = notif.notification_is_read === 1 || notif.isRead === true;
            const date = new Date(notif.notification_created_at || notif.createdAt);
            const timeAgo = this.formatTimeAgo(date);

            let message = this.escapeHtml(notif.notification_message || notif.message || '');
            if (message.length > 45) {
                message = message.substring(0, 45) + '...';
            }

            const notificationId = notif.notification_id || notif.id;
            const loanId = notif.notification_loan_id || notif.loanId;
            const navHref = resolveNotificationHref(notif);
            const actionLabel = navHref ? getNotificationActionLabel(notif) : (loanId ? 'View loan' : '');

            return `
                <a class="notification-item ${!isRead ? 'notification-item-unread' : ''}" href="#"
                   data-notification-id="${notificationId}"
                   ${loanId ? `data-loan-id="${loanId}"` : ''}
                   ${navHref ? `data-nav-href="${this.escapeHtml(navHref)}"` : ''}>
                    <div class="notification-item-top">
                        <div class="notification-title">${this.escapeHtml(notif.notification_title || notif.title)}</div>
                        ${!isRead ? '<span class="notification-new-badge">New</span>' : ''}
                    </div>
                    <div class="notification-message">${message}</div>
                    <div class="notification-time">${timeAgo}${actionLabel ? ` · ${this.escapeHtml(actionLabel)}` : ''}</div>
                </a>`;
        }).join('');

        notificationsList.querySelectorAll('a[data-notification-id]').forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.preventDefault();
                const notificationId = parseInt(item.getAttribute('data-notification-id'), 10);
                const loanId = item.getAttribute('data-loan-id');
                const navHref = item.getAttribute('data-nav-href');
                await this.handleNotificationClick(notificationId, loanId, navHref);
            });
        });
    }

    async handleNotificationClick(notificationId, loanId, navHref) {
        await this.markAsRead(notificationId);
        this.closeNotificationDropdown();

        if (navHref) {
            window.location.href = navHref;
            return;
        }

        if (loanId) {
            this.navigateToLoan(loanId);
        }
    }

    navigateToLoan(loanId) {
        const id = parseInt(loanId, 10);
        if (!id) return;

        if (window.studentsDashboardModule && typeof window.studentsDashboardModule.viewLoan === 'function') {
            window.studentsDashboardModule.viewLoan(id);
            return;
        }
        if (window.studentsLoansModule && typeof window.studentsLoansModule.viewLoan === 'function') {
            window.studentsLoansModule.viewLoan(id);
            return;
        }
        window.location.href = `students-loans.html?openLoan=${encodeURIComponent(id)}`;
    }

    async markAsRead(notificationId) {
        try {
            await notificationService.markAsRead(notificationId);
            await this.loadNotifications();
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    }

    async markAllAsRead() {
        try {
            await notificationService.markAllAsRead();
            await this.loadNotifications();
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
        }
    }

    formatTimeAgo(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffSecs < 60) return 'Just now';
        if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
        if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
        if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
        return date.toLocaleDateString();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Request notification permission
     * This is still needed for Web Push to work via Service Worker
     */
    async requestNotificationPermission() {
        if (!('Notification' in window)) {
            return false;
        }

        if (Notification.permission === 'granted') {
            return true;
        }

        if (Notification.permission === 'denied') {
            return false;
        }

        // Request permission
        try {
            const permission = await Notification.requestPermission();
            return permission === 'granted';
        } catch (error) {
            console.error('[Notifications] Error requesting permission:', error);
            return false;
        }
    }

    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
    }
}

export default StudentsNotificationsModule;
