import AppPaths from '../../services/services-appPaths.js';
import cooNotificationService from '../../services/services-cooNotificationService.js';
import webPushService from '../../services/services-webPushService.js';
import {
    setupPortalNotificationBell,
    bootstrapPortalNotificationsPage,
    closePortalNotificationDropdown,
} from '../../shared/shared-portal-notifications-core.js';

const COO_LOANS_PAGE = AppPaths.page('views/coo/coo-loans-management.html');

class CooNotificationsModule {
    constructor() {
        this.unreadCount = 0;
        this.notifications = [];
        this.pollInterval = null;
        this._bellState = { bound: false };
        this.lastNotificationId = null;
        this.isFirstLoad = true;
        this.hasShownInitialToast = false;
    }

    getNotificationsPageUrl() {
        return 'coo-notifications.html';
    }

    isNotificationsPage() {
        return /\/coo\/(?:coo-)?notifications(?:\.html)?$/.test(window.location.pathname);
    }

    async init() {
        // Register globally for native notifications
        window.cooNotificationsModule = this;
        
        // Request notification permission early
        await this.requestNotificationPermission();
        
        // Load initial notifications
        await this.loadNotifications();

        // Initialize Web Push
        await this.initWebPush();

        // Set up UI event listeners
        this.setupEventListeners();
        setupPortalNotificationBell(this.getNotificationsPageUrl(), this._bellState);

        if (this.isNotificationsPage()) {
            await this.initNotificationsPage();
        }
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
            console.error('[COO WebPush] Initialization error:', error);
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
            console.error('[COO Notifications] Error requesting permission:', error);
            return false;
        }
    }

    setupPolling() {
        // Poll for notifications every 30 seconds
        this.pollInterval = setInterval(async () => {
            await this.loadNotifications();
            if (this.isNotificationsPage()) {
                await this.loadNotificationsPage(this.pagePagination.page, false);
            }
        }, 30000);
    }

    async loadNotifications() {
        try {
            const response = await cooNotificationService.fetchNotifications(10);
            if (response.success) {
                const newNotifications = response.notifications || [];
                
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
                
                this.unreadCount = response.unreadCount || 0;
                this.notifications = newNotifications;
                this.updateUI();
            }
        } catch (error) {
            console.error('Error loading COO notifications:', error);
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
    }

    async initNotificationsPage() {
        await bootstrapPortalNotificationsPage({
            service: cooNotificationService,
            formatTimeAgo: (date) => this.formatTimeAgo(date),
            escapeHtml: (text) => this.escapeHtml(text),
            onItemClick: async (notificationId, loanId) => {
                await this.markAsRead(notificationId);
                if (loanId) {
                    window.location.href = COO_LOANS_PAGE;
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
        if (notificationsList) {
            if (this.notifications.length === 0) {
                notificationsList.innerHTML = '<div class="notification-empty">No notifications yet</div>';
            } else {
                notificationsList.innerHTML = this.notifications.map(notif => {
                    const isRead = notif.notification_is_read === 1;
                    const date = new Date(notif.notification_created_at);
                    const timeAgo = this.formatTimeAgo(date);
                    
                    let message = notif.notification_message;
                    let studentName = null;
                    
                    const namePatterns = [
                        /submitted by ([^.]+)\./i,
                        /resubmitted by ([^.]+)\./i,
                        /endorsed.*Student: ([^.]+)\./i
                    ];
                    
                    for (const pattern of namePatterns) {
                        const match = message.match(pattern);
                        if (match && match[1]) {
                            studentName = match[1].trim();
                            break;
                        }
                    }
                    
                    let displayMessage = this.escapeHtml(message);
                    if (displayMessage.length > 55) {
                        displayMessage = displayMessage.substring(0, 55) + '...';
                    }
                    
                    return `
                        <a class="notification-item ${!isRead ? 'notification-item-unread' : ''}" href="#"
                           data-notification-id="${notif.notification_id}"
                           ${notif.notification_loan_id ? `data-loan-id="${notif.notification_loan_id}"` : ''}>
                            <div class="notification-item-top">
                                <div class="notification-title">${this.escapeHtml(notif.notification_title)}</div>
                                ${!isRead ? '<span class="notification-new-badge">New</span>' : ''}
                            </div>
                            ${studentName ? `<div class="notification-message"><strong>${this.escapeHtml(studentName)}</strong></div>` : ''}
                            <div class="notification-message">${displayMessage}</div>
                            <div class="notification-time">${timeAgo}</div>
                        </a>
                    `;
                }).join('');
                
                notificationsList.querySelectorAll('a[data-notification-id]').forEach(item => {
                    item.addEventListener('click', async (e) => {
                        e.preventDefault();
                        const notificationId = parseInt(item.getAttribute('data-notification-id'));
                        const loanId = item.getAttribute('data-loan-id');
                        
                        await this.markAsRead(notificationId);
                        closePortalNotificationDropdown();
                        
                        if (loanId) {
                            window.location.href = COO_LOANS_PAGE;
                        }
                    });
                });
            }
        }
    }

    async markAsRead(notificationId) {
        try {
            await cooNotificationService.markAsRead(notificationId);
            await this.loadNotifications();
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    }

    async markAllAsRead() {
        try {
            await cooNotificationService.markAllAsRead();
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

        if (diffSecs < 60) {
            return 'Just now';
        } else if (diffMins < 60) {
            return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
        } else if (diffHours < 24) {
            return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
        } else if (diffDays < 7) {
            return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
        } else {
            return date.toLocaleDateString();
        }
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
            window.location.href = COO_LOANS_PAGE;
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

            // Navigate to loans page
            if (loanId) {
                window.location.href = COO_LOANS_PAGE;
            }
        };

        // Auto close after 10 seconds
        setTimeout(() => {
            nativeNotification.close();
        }, 10000);
    }

    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
    }
}

export default CooNotificationsModule;
