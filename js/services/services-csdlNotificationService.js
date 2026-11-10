import ApiService from './services-apiService.js';

class CsdlNotificationService {
    constructor() {
        this.eventSource = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000; // 3 seconds
        this.callbacks = {
            onNotification: null,
            onUpdate: null,
            onError: null
        };
    }

    /**
     * Start SSE connection for real-time notifications
     */
    start() {
        // Only start if we're on a CSDL, masterfiles, or finance page and user is logged in
        const isCsdlPage = window.location.pathname.includes('/csdl/');
        const isMasterfilesPage = window.location.pathname.includes('/masterfiles/');
        const isFinancePage = window.location.pathname.includes('/assessment/');
        const userType = document.body.dataset.userType || 
                        ((isCsdlPage || isMasterfilesPage || isFinancePage) ? 'employee' : null);
        
        if (userType !== 'employee') {
            return; // Only for employees
        }

        if (this.eventSource && this.isConnected) {
            return; // Already connected
        }

        try {
            const baseURL = ApiService.getBaseURL();
            // Use finance notifications API if on finance page, otherwise CSDL
            const apiPath = isFinancePage ? 'assessment/assessment-notification' : 'csdl/csdl-notifications';
            const sseUrl = `${baseURL}/${apiPath}.php?stream=1`;

            this.eventSource = new EventSource(sseUrl, { withCredentials: true });

            this.eventSource.onopen = () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log('SSE connection opened (CSDL)');
            };

            this.eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'connected') {
                        console.log('SSE connected successfully (CSDL)');
                    } else if (data.type === 'notification') {
                        this.handleNotification(data);
                    } else if (data.type === 'error') {
                        console.error('SSE error:', data.message);
                        if (this.callbacks.onError) {
                            this.callbacks.onError(data);
                        }
                    }
                } catch (error) {
                    console.error('Error parsing SSE message:', error);
                }
            };

            this.eventSource.onerror = (error) => {
                console.error('SSE connection error (CSDL):', error);
                this.isConnected = false;
                
                if (this.eventSource) {
                    this.eventSource.close();
                }

                // Attempt to reconnect
                if (this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    setTimeout(() => {
                        console.log(`Reconnecting (CSDL)... Attempt ${this.reconnectAttempts}`);
                        this.start();
                    }, this.reconnectDelay);
                } else {
                    console.error('Max reconnection attempts reached (CSDL)');
                    if (this.callbacks.onError) {
                        this.callbacks.onError({ message: 'Connection failed. Please refresh the page.' });
                    }
                }
            };

        } catch (error) {
            console.error('Error starting SSE connection (CSDL):', error);
        }
    }

    /**
     * Handle incoming notification data
     */
    handleNotification(data) {
        if (this.callbacks.onNotification) {
            this.callbacks.onNotification(data);
        }
        if (this.callbacks.onUpdate) {
            this.callbacks.onUpdate(data.unreadCount, data.notifications);
        }
    }

    /**
     * Register callback for notifications
     */
    onNotification(callback) {
        this.callbacks.onNotification = callback;
    }

    /**
     * Register callback for updates (unread count + notifications list)
     */
    onUpdate(callback) {
        this.callbacks.onUpdate = callback;
    }

    /**
     * Register callback for errors
     */
    onError(callback) {
        this.callbacks.onError = callback;
    }

    /**
     * Stop SSE connection
     */
    stop() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
            this.isConnected = false;
            console.log('SSE connection closed (CSDL)');
        }
    }

    /**
     * Fetch notifications via API (fallback or initial load)
     */
    async fetchNotifications(limit = 10, page = null, perPage = 20) {
        try {
            const isFinancePage = window.location.pathname.includes('/assessment/');
            const apiPath = isFinancePage ? '/assessment/assessment-notification.php' : '/csdl/csdl-notifications.php';
            const params = page !== null && page !== undefined ? { page, perPage } : { limit };
            const response = await ApiService.get(apiPath, params);
            return response;
        } catch (error) {
            console.error('Error fetching notifications:', error);
            return { success: false, unreadCount: 0, notifications: [] };
        }
    }

    /**
     * Mark notification as read
     */
    async markAsRead(notificationId) {
        try {
            const isFinancePage = window.location.pathname.includes('/assessment/');
            const apiPath = isFinancePage ? '/assessment/assessment-notification.php' : '/csdl/csdl-notifications.php';
            const response = await ApiService.post(apiPath, {
                action: 'markAsRead',
                notificationId
            });
            return response;
        } catch (error) {
            console.error('Error marking notification as read:', error);
            return { success: false };
        }
    }

    /**
     * Mark all notifications as read
     */
    async markAllAsRead() {
        try {
            const isFinancePage = window.location.pathname.includes('/assessment/');
            const apiPath = isFinancePage ? '/assessment/assessment-notification.php' : '/csdl/csdl-notifications.php';
            const response = await ApiService.post(apiPath, {
                action: 'markAllAsRead'
            });
            return response;
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
            return { success: false };
        }
    }
}

// Create singleton instance
const csdlNotificationService = new CsdlNotificationService();

export default csdlNotificationService;





