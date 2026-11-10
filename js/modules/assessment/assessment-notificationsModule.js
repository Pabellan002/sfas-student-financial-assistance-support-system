import AppPaths from '../../services/services-appPaths.js';
import assessmentNotificationService from '../../services/services-assessmentNotificationService.js';
import cashierNotificationService from '../../services/services-cashierNotificationService.js';
import webPushService from '../../services/services-webPushService.js';
import {
    setupPortalNotificationBell,
    bootstrapPortalNotificationsPage,
    closePortalNotificationDropdown,
} from '../../shared/shared-portal-notifications-core.js';
import { resolveNotificationHref, getNotificationActionLabel } from '../../shared/shared-notification-navigation.js?v=20261020-csdl-pn-tagging';

class AssessmentNotificationsModule {
    constructor() {
        this.unreadCount = 0;
        this.notifications = [];
        this.pollInterval = null;
        this._bellState = { bound: false };
        this.isCashierPortal = window.location.pathname.includes('/cashier/');
        this.notificationService = this.isCashierPortal
            ? cashierNotificationService
            : assessmentNotificationService;
        this.lastNotificationId = null;
        this.isFirstLoad = true;
        this.hasShownInitialToast = false;
    }

    getNotificationsPageUrl() {
        return this.isCashierPortal
            ? 'cashier-notifications.html'
            : 'assessment-notifications.html';
    }

    isNotificationsPage() {
        return /\/(?:cashier|assessment)\/(?:(?:cashier|assessment)-)?notifications(?:\.html)?$/.test(window.location.pathname);
    }

    getLoansPageUrl() {
        return this.isCashierPortal
            ? AppPaths.page('views/cashier/cashier-loans-management.html')
            : AppPaths.page('views/assessment/assessment-loans-management.html');
    }

    async init() {        
        // Register globally for native notifications
        window.assessmentNotificationsModule = this;
        
        // Request notification permission early
        await this.requestNotificationPermission();
        
        await this.loadNotifications();
        
        // Initialize Web Push
        await this.initWebPush();
        
        this.setupEventListeners();
        setupPortalNotificationBell(this.getNotificationsPageUrl(), this._bellState);

        if (this.isNotificationsPage()) {
            await this.initNotificationsPage();
        }    }

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
            console.error('[Assessment WebPush] Initialization error:', error);
            this.setupPolling();
        }
    }

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

        try {
            const permission = await Notification.requestPermission();
            return permission === 'granted';
        } catch (error) {
            console.error('[Assessment Notifications] Error requesting permission:', error);
            return false;
        }
    }

    setupPolling() {
        // Poll for new notifications every 30 seconds
        this.pollInterval = setInterval(async () => {
            await this.loadNotifications();
            if (this.isNotificationsPage()) {
                await this.loadNotificationsPage(this.pagePagination.page, false);
            }
        }, 30000);
    }

    setupPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = setInterval(async () => {
            await this.loadNotifications();
        }, 30000);
    }

    async loadNotifications() {
        try {            
            const response = await this.notificationService.fetchNotifications(10);            
            if (response.success) {
                const newNotifications = response.notifications || [];
                const unreadFromList = newNotifications.filter((n) => !(n.notification_is_read === 1 || n.isRead === true)).length;
                
                // On first load, show a native notification for the most recent UNREAD notification
                if (this.isFirstLoad && !this.hasShownInitialToast && newNotifications.length > 0) {
                    const latestUnreadNotification = newNotifications.find(n => !(n.notification_is_read === 1 || n.isRead === true));
                    
                    if (latestUnreadNotification) {
                        const notificationId = latestUnreadNotification.notification_id || latestUnreadNotification.id;
                        
                        // Check if we've already shown a notification for this in this session
                        const shownNotificationsKey = 'shownBrowserNotifications';
                        const shownNotifications = JSON.parse(sessionStorage.getItem(shownNotificationsKey) || '[]');
                        
                        if (!shownNotifications.includes(notificationId)) {
                            // Show native browser notification
                            this.showNativeNotification(latestUnreadNotification);
                            this.hasShownInitialToast = true;
                            
                            // Mark this notification as shown in this session
                            shownNotifications.push(notificationId);
                            sessionStorage.setItem(shownNotificationsKey, JSON.stringify(shownNotifications));
                        }
                    }
                    
                    // Set initial last notification ID
                    if (newNotifications.length > 0) {
                        this.lastNotificationId = newNotifications[0].notification_id || newNotifications[0].id;
                    }
                    this.isFirstLoad = false;
                }
                // Check for new notifications (only after first load)
                else if (!this.isFirstLoad && newNotifications.length > 0) {
                    const latestNotification = newNotifications[0];
                    const latestId = latestNotification.notification_id || latestNotification.id;
                    
                    // Show native notification if there's a new notification
                    if (this.lastNotificationId && latestId !== this.lastNotificationId) {
                        const shownNotificationsKey = 'shownBrowserNotifications';
                        const shownNotifications = JSON.parse(sessionStorage.getItem(shownNotificationsKey) || '[]');
                        
                        if (!shownNotifications.includes(latestId)) {
                            this.showNativeNotification(latestNotification);
                            
                            // Mark this notification as shown
                            shownNotifications.push(latestId);
                            sessionStorage.setItem(shownNotificationsKey, JSON.stringify(shownNotifications));
                        }
                    }
                    
                    this.lastNotificationId = latestId;
                }
                
                this.notifications = newNotifications;
                this.unreadCount = Number.isFinite(response.unreadCount) ? response.unreadCount : unreadFromList;
                this.updateUI();
            }
        } catch (error) {
            console.error('[NotificationModule] Error loading notifications:', error);
        }
    }

    setupEventListeners() {
        const markAllReadBtn = document.getElementById('markAllReadBtn');
        if (markAllReadBtn) {
            markAllReadBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.markAllAsRead();
                closePortalNotificationDropdown();
                if (this.isNotificationsPage()) {
                    await this.initNotificationsPage();
                }
            });
        }

        const notificationBell = document.querySelector('.notifications-bell-link');
        if (notificationBell && 'Notification' in window && Notification.permission === 'default') {
            notificationBell.addEventListener('click', async () => {
                if (window.matchMedia('(max-width: 991.98px)').matches) return;
                if (Notification.permission === 'default') {
                    await webPushService.subscribe();
                }
            });
        }
    }

    async initNotificationsPage() {
        await bootstrapPortalNotificationsPage({
            service: assessmentNotificationService,
            formatTimeAgo: (date) => this.formatTimeAgo(date),
            escapeHtml: (text) => this.escapeHtml(text),
            onItemClick: async (notificationId, loanId) => {
                await this.markAsRead(notificationId);
                if (loanId) {
                    window.location.href = this.getLoansPageUrl();
                }
            },
            onAfterLoad: (response) => {
                if (response?.success) {
                    this.unreadCount = Number.isFinite(response.unreadCount) ? response.unreadCount : this.unreadCount;
                    this.updateUI();
                }
            },
        });
    }

    updateUI() {
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

        if (!this.notifications.length) {
            notificationsList.innerHTML = '<div class="notification-empty">No notifications yet</div>';
            return;
        }

        notificationsList.innerHTML = this.notifications.map((notif) => {
            const notificationId = notif.notification_id || notif.id;
            const loanId = notif.notification_loan_id || notif.loanId;
            const isRead = notif.notification_is_read === 1 || notif.isRead === true;
            const dateRaw = notif.notification_created_at || notif.createdAt;
            const timeAgo = this.formatTimeAgo(new Date(dateRaw));
            const title = this.escapeHtml(notif.notification_title || notif.title || 'Notification');

            let message = this.escapeHtml(notif.notification_message || notif.message || '');
            if (message.length > 60) message = `${message.substring(0, 60)}...`;

            // Get navigation URL and action label
            const navHref = resolveNotificationHref(notif);
            const actionLabel = navHref ? getNotificationActionLabel(notif) : (loanId ? 'View loan' : '');

            return `
                <a class="notification-item ${!isRead ? 'notification-item-unread' : ''}" href="#"
                   data-notification-id="${notificationId}"
                   ${loanId ? `data-loan-id="${loanId}"` : ''}
                   ${navHref ? `data-nav-href="${this.escapeHtml(navHref)}"` : ''}>
                    <div class="notification-item-top">
                        <div class="notification-title">${title}</div>
                        ${!isRead ? '<span class="notification-new-badge">New</span>' : ''}
                    </div>
                    <div class="notification-message">${message}</div>
                    <div class="notification-time">${timeAgo}${actionLabel ? ` · ${this.escapeHtml(actionLabel)}` : ''}</div>
                </a>
            `;
        }).join('');

        notificationsList.querySelectorAll('a[data-notification-id]').forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.preventDefault();
                const notificationId = parseInt(item.getAttribute('data-notification-id'), 10);
                const loanId = item.getAttribute('data-loan-id');
                const navHref = item.getAttribute('data-nav-href');

                await this.markAsRead(notificationId);
                closePortalNotificationDropdown();
                
                // Navigate to specific href if available, otherwise default to loans page
                if (navHref) {
                    window.location.href = navHref;
                    return;
                }
                if (loanId) {
                    window.location.href = this.getLoansPageUrl();
                }
            });
        });
    }

    async markAsRead(notificationId) {
        try {
            await this.notificationService.markAsRead(notificationId);
            await this.loadNotifications();
        } catch (error) {
            console.error('Error marking Assessment notification as read:', error);
        }
    }

    async markAllAsRead() {
        try {
            await this.notificationService.markAllAsRead();
            await this.loadNotifications();
        } catch (error) {
            console.error('Error marking all Assessment notifications as read:', error);
        }
    }

    formatTimeAgo(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Just now';
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

    async handleNotificationClick(notificationId, loanId, navHref) {
        await this.markAsRead(notificationId);
        closePortalNotificationDropdown();

        if (navHref) {
            window.location.href = navHref;
            return;
        }

        if (loanId) {
            window.location.href = this.getLoansPageUrl();
        }
    }

    /**
     * Request notification permission
     */
    async requestNotificationPermission() {
        if (!('Notification' in window)) {            return false;
        }

        if (Notification.permission === 'granted') {            return true;
        }

        if (Notification.permission === 'denied') {            return false;
        }

        // Request permission
        try {
            const permission = await Notification.requestPermission();            return permission === 'granted';
        } catch (error) {
            console.error('[Notifications] Error requesting permission:', error);
            return false;
        }
    }

    /**
     * Show native browser notification
     */
    async showNativeNotification(notification) {
        // Check if browser supports notifications
        if (!('Notification' in window)) {            return;
        }

        // Request permission if not already granted
        if (Notification.permission === 'default') {            const granted = await this.requestNotificationPermission();
            if (!granted) {                return;
            }
        }

        // Check permission
        if (Notification.permission !== 'granted') {            return;
        }

        const title = notification.notification_title || notification.title || 'New Notification';
        const message = notification.notification_message || notification.message || '';
        const loanId = notification.notification_loan_id || notification.loanId;
        const notificationId = notification.notification_id || notification.id;

        // Create native notification
        const nativeNotification = new Notification(title, {
            body: message,
            icon: AppPaths.url('assets/images/i.png'),
            badge: AppPaths.url('assets/images/i.png'),
            tag: `notification-${notificationId}`,
            requireInteraction: false,
            silent: false
        });

        // Handle notification click
        nativeNotification.onclick = async (event) => {
            event.preventDefault();
            window.focus();
            nativeNotification.close();

            // Mark as read
            await this.markAsRead(notificationId);

            // Navigate to appropriate page
            const navHref = resolveNotificationHref(notification);
            if (navHref) {
                window.location.href = navHref;
            } else if (loanId) {
                window.location.href = this.getLoansPageUrl();
            }
        };

        // Auto close after 10 seconds
        setTimeout(() => {
            nativeNotification.close();
        }, 10000);
    }
}

export default AssessmentNotificationsModule;
