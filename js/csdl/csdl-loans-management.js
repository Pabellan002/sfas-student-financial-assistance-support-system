import CsdlLoansManagementModule from '../modules/csdl/csdl-loans-managementModule.js?v=20261018-overdue-countdown';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new CsdlLoansManagementModule();
    window.loansManagementModule = mod; // Make it globally accessible for onclick handlers
    await mod.init();
    
    // Initialize notifications
    const notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
});
