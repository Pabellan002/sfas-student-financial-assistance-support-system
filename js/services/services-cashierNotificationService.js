import ApiService from './services-apiService.js';

class CashierNotificationService {
    async fetchNotifications(limit = 10, page = null, perPage = 20) {
        const params = page !== null && page !== undefined ? { page, perPage } : { limit };
        return ApiService.get('/cashier/cashier-notification.php', params);
    }

    async markAsRead(notificationId) {
        return ApiService.post('/cashier/cashier-notification.php', {
            action: 'markAsRead',
            notificationId,
        });
    }

    async markAllAsRead() {
        return ApiService.post('/cashier/cashier-notification.php', {
            action: 'markAllAsRead',
        });
    }
}

export default new CashierNotificationService();
