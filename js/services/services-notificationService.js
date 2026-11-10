import ApiService from './services-apiService.js';

class NotificationService {
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
        // Only start if we're on a student page and user is logged in
        const userType = document.body.dataset.userType || 
                        (window.location.pathname.includes('/students/') ? 'student' : null);
        
        if (userType !== 'student') {
            return; // Only for students
        }

        if (this.eventSource && this.isConnected) {
            return; // Already connected
        }

        try {
            const baseURL = ApiService.getBaseURL();
            const sseUrl = `${baseURL}/students/students-notifications.php?stream=1`;

            this.eventSource = new EventSource(sseUrl, { withCredentials: true });

            this.eventSource.onopen = () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log('SSE connection opened');
            };

            this.eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'connected') {
                        console.log('SSE connected successfully');
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
                // EventSource onerror fires even during normal operation
                // Only handle actual connection failures
                if (this.eventSource && this.eventSource.readyState === EventSource.CLOSED) {
                    console.warn('SSE connection closed');
                    this.isConnected = false;
                    
                    // Close the connection properly
                    try {
                        this.eventSource.close();
                    } catch (e) {
                        // Ignore errors when closing
                    }
                    
                    // Attempt to reconnect only if connection was actually closed
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        setTimeout(() => {
                            console.log(`Reconnecting... Attempt ${this.reconnectAttempts}`);
                            this.eventSource = null; // Clear reference before reconnecting
                            this.start();
                        }, this.reconnectDelay);
                    } else {
                        console.error('Max reconnection attempts reached');
                        if (this.callbacks.onError) {
                            this.callbacks.onError({ message: 'Connection failed. Please refresh the page.' });
                        }
                    }
                }
                // If connection is OPEN or CONNECTING, ignore the error event
                // This is normal EventSource behavior
            };

        } catch (error) {
            console.error('Error starting SSE connection:', error);
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
            console.log('SSE connection closed');
        }
    }

    /**
     * Fetch notifications via API (fallback or initial load)
     */
    async fetchNotifications(limit = 10, page = null, perPage = 20) {
        try {
            const params = page !== null && page !== undefined
                ? { page, perPage }
                : { limit };
            const response = await ApiService.get('/students/students-notifications.php', params);
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
            const response = await ApiService.post('/students/students-notifications.php', {
                action: 'markRead',
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
            const response = await ApiService.post('/students/students-notifications.php', {
                action: 'markAllRead'
            });
            return response;
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
            return { success: false };
        }
    }
}

// Create singleton instance
const notificationService = new NotificationService();

export default notificationService;

