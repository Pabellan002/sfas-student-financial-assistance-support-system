import CashierDashboardModule from '../modules/cashier/cashier-dashboardModule.js?v=20261014-report-layout';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new CashierDashboardModule();
    await mod.init();
    
    // Initialize notifications (AssessmentNotificationsModule supports cashier portal)
    const notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    
    window.cashierNotificationsModule = notificationsModule;
});

