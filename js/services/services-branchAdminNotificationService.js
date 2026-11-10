import ApiService from './services-apiService.js';

class BranchAdminNotificationService {
    async fetchNotifications(limit = 10, page = null, perPage = 20) {
        try {
            const params = page !== null && page !== undefined ? { page, perPage } : { limit };
            const response = await ApiService.get('/branch-admin/branch-admin-notifications.php', params);
            return response;
        } catch (error) {
            console.error('Error fetching Branch Admin notifications:', error);
            return { success: false, unreadCount: 0, notifications: [] };
        }
    }

    async markAsRead(notificationId) {
        try {
            const response = await ApiService.post('/branch-admin/branch-admin-notifications.php', {
                action: 'markAsRead',
                notificationId
            });
            return response;
        } catch (error) {
            console.error('Error marking Branch Admin notification as read:', error);
            return { success: false };
        }
    }

    async markAllAsRead() {
        try {
            const response = await ApiService.post('/branch-admin/branch-admin-notifications.php', {
                action: 'markAllAsRead'
            });
            return response;
        } catch (error) {
            console.error('Error marking all Branch Admin notifications as read:', error);
            return { success: false };
        }
    }
}

const branchAdminNotificationService = new BranchAdminNotificationService();
export default branchAdminNotificationService;
