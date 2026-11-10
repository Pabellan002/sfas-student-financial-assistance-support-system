import ApiService from './services-apiService.js';

class AssessmentNotificationService {
    async fetchNotifications(limit = 10, page = null, perPage = 20) {
        try {
            const params = page !== null && page !== undefined ? { page, perPage } : { limit };
            return await ApiService.get('/assessment/assessment-notification.php', params);
        } catch (error) {
            console.error('Error fetching Assessment notifications:', error);
            return { success: false, unreadCount: 0, notifications: [] };
        }
    }

    async markAsRead(notificationId) {
        try {
            return await ApiService.post('/assessment/assessment-notification.php', {
                action: 'markAsRead',
                notificationId
            });
        } catch (error) {
            console.error('Error marking Assessment notification as read:', error);
            return { success: false };
        }
    }

    async markAllAsRead() {
        try {
            return await ApiService.post('/assessment/assessment-notification.php', {
                action: 'markAllAsRead'
            });
        } catch (error) {
            console.error('Error marking all Assessment notifications as read:', error);
            return { success: false };
        }
    }
}

const assessmentNotificationService = new AssessmentNotificationService();
export default assessmentNotificationService;
