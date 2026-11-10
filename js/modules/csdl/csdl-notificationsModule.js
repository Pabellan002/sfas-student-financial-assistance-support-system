import AppPaths from '../../services/services-appPaths.js';
import csdlNotificationService from '../../services/services-csdlNotificationService.js';
import webPushService from '../../services/services-webPushService.js';
import {
    setupPortalNotificationBell,
    bootstrapPortalNotificationsPage,
    closePortalNotificationDropdown,
} from '../../shared/shared-portal-notifications-core.js';
import { resolveNotificationHref, getNotificationActionLabel } from '../../shared/shared-notification-navigation.js?v=20261020-csdl-pn-tagging';

class CsdlNotificationsModule {
    constructor() {
        this.unreadCount = 0;
        this.notifications = [];
        this._bellState = { bound: false };
        this.lastNotificationId = null;
        this.isFirstLoad = true;
        this.hasShownInitialToast = false;
    }

    getNotificationsPageUrl() {
        const path = window.location.pathname;
        if (path.includes('/assessment/')) return 'assessment-notifications.html';
        if (path.includes('/masterfiles/')) return 'masterfiles-notifications.html';
        return 'csdl-notifications.html';
    }

    isNotificationsPage() {
        return /\/(?:csdl|assessment|masterfiles)\/(?:[\w-]*-)?notifications(?:\.html)?$/.test(window.location.pathname);
    }

    getLoansPageUrl() {
        return window.location.pathname.includes('/assessment/')
            ? AppPaths.page('views/assessment/assessment-loans-management.html')
            : AppPaths.page('views/csdl/csdl-loans-management.html');
    }

    async init() {
        // Check if we're on a CSDL, masterfiles, or finance page (all are admin/employee pages)
        const isCsdlPage = window.location.pathname.includes('/csdl/');
        const isMasterfilesPage = window.location.pathname.includes('/masterfiles/');
        const isFinancePage = window.location.pathname.includes('/assessment/');
        if (!isCsdlPage && !isMasterfilesPage && !isFinancePage) {
            return;
        }

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
            console.error('[CSDL WebPush] Initialization error:', error);
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
            console.error('[CSDL Notifications] Error requesting permission:', error);
            return false;
        }
    }
    
    setupPolling() {
        // Poll every 5 seconds
        this.pollInterval = setInterval(async () => {
            await this.loadNotifications();
        }, 5000);
    }

    async loadNotifications() {
        try {
            const response = await csdlNotificationService.fetchNotifications(10);
            if (response.success) {
                const newNotifications = response.notifications || [];
                
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
                    this.lastNotificationID = latestId;
                }
                
                this.unreadCount = response.unreadCount || 0;
                this.notifications = newNotifications;
                this.updateUI();
            }
        } catch (error) {
            console.error('Error loading notifications:', error);
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
            service: csdlNotificationService,
            formatTimeAgo: (date) => this.formatTimeAgo(date),
            escapeHtml: (text) => this.escapeHtml(text),
            onItemClick: async (notificationId, loanId, navHref) => {
                await this.markAsRead(notificationId);
                if (navHref) {
                    window.location.href = navHref;
                    return;
                }
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
        // Update notification count badge (show numeric count)
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

        // Update notifications list
        const notificationsList = document.getElementById('notificationsList');
        if (notificationsList) {
            if (this.notifications.length === 0) {
                notificationsList.innerHTML = '<div class="notification-empty">No notifications yet</div>';
            } else {
                notificationsList.innerHTML = this.notifications.map(notif => {
                    const isRead = notif.notification_is_read === 1;
                    const date = new Date(notif.notification_created_at);
                    const timeAgo = this.formatTimeAgo(date);
                    
                    // Extract student name from message (format: "A new loan application has been submitted by {Name}...")
                    let message = notif.notification_message;
                    let studentName = null;
                    
                    // Try to extract name from common patterns
                    const namePatterns = [
                        /submitted by ([^.]+)\./i,
                        /resubmitted by ([^.]+)\./i
                    ];
                    
                    for (const pattern of namePatterns) {
                        const match = message.match(pattern);
                        if (match && match[1]) {
                            studentName = match[1].trim();
                            break;
                        }
                    }
                    
                    // Format message - truncate if too long
                    let displayMessage = this.escapeHtml(message);
                    if (displayMessage.length > 55) {
                        displayMessage = displayMessage.substring(0, 55) + '...';
                    }
                    
                    const navHref = resolveNotificationHref(notif);
                    const actionLabel = navHref ? getNotificationActionLabel(notif) : (notif.notification_loan_id ? 'View loan' : '');

                    return `
                        <a class="notification-item ${!isRead ? 'notification-item-unread' : ''}" href="#"
                           data-notification-id="${notif.notification_id}"
                           ${notif.notification_loan_id ? `data-loan-id="${notif.notification_loan_id}"` : ''}
                           ${navHref ? `data-nav-href="${this.escapeHtml(navHref)}"` : ''}>
                            <div class="notification-item-top">
                                <div class="notification-title">${this.escapeHtml(notif.notification_title)}</div>
                                ${!isRead ? '<span class="notification-new-badge">New</span>' : ''}
                            </div>
                            ${studentName ? `<div class="notification-message"><strong>${this.escapeHtml(studentName)}</strong></div>` : ''}
                            <div class="notification-message">${displayMessage}</div>
                            <div class="notification-time">${timeAgo}${actionLabel ? ` · ${this.escapeHtml(actionLabel)}` : ''}</div>
                        </a>
                    `;
                }).join('');
                
                // Add click handlers to notification items
                notificationsList.querySelectorAll('a[data-notification-id]').forEach(item => {
                    item.addEventListener('click', async (e) => {
                        e.preventDefault();
                        const notificationId = parseInt(item.getAttribute('data-notification-id'));
                        const loanId = item.getAttribute('data-loan-id');
                        const navHref = item.getAttribute('data-nav-href');
                        
                        // Mark as read
                        await this.markAsRead(notificationId);
                        closePortalNotificationDropdown();
                        
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
        }
    }

    async markAsRead(notificationId) {
        try {
            await csdlNotificationService.markAsRead(notificationId);
            // Reload notifications to update UI
            await this.loadNotifications();
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    }

    async markAllAsRead() {
        try {
            await csdlNotificationService.markAllAsRead();
            // Reload notifications to update UI
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

    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
    }
}

export default CsdlNotificationsModule;
