import CashierLoansManagementModule from '../modules/cashier/cashier-loans-managementModule.js?v=20261015-action-badges';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new CashierLoansManagementModule();
    window.cashierLoansManagementModule = mod; // Make it globally accessible for onclick handlers
    await mod.init();

    // Initialize notifications (AssessmentNotificationsModule supports cashier portal)
    const notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    
    window.cashierNotificationsModule = notificationsModule;
});
