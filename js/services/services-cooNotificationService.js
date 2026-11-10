import ApiService from './services-apiService.js';

class CooNotificationService {
    async fetchNotifications(limit = 10, page = null, perPage = 20) {
        try {
            const params = page !== null && page !== undefined ? { page, perPage } : { limit };
            const response = await ApiService.get('/coo/coo-notifications.php', params);
            return response;
        } catch (error) {
            console.error('Error fetching COO notifications:', error);
            return { success: false, unreadCount: 0, notifications: [] };
        }
    }

    async markAsRead(notificationId) {
        try {
            const response = await ApiService.post('/coo/coo-notifications.php', {
                action: 'markAsRead',
                notificationId
            });
            return response;
        } catch (error) {
            console.error('Error marking COO notification as read:', error);
            return { success: false };
        }
    }

    async markAllAsRead() {
        try {
            const response = await ApiService.post('/coo/coo-notifications.php', {
                action: 'markAllAsRead'
            });
            return response;
        } catch (error) {
            console.error('Error marking all COO notifications as read:', error);
            return { success: false };
        }
    }
}

const cooNotificationService = new CooNotificationService();
export default cooNotificationService;
