import CooLoansManagementModule from '../modules/coo/coo-loans-managementModule.js?v=20261018-overdue-countdown';
import CooNotificationsModule from '../modules/coo/coo-notificationsModule.js';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new CooLoansManagementModule();
    window.cooLoansManagementModule = mod;
    await mod.init();

    const notificationsModule = new CooNotificationsModule();
    notificationsModule.init();
    window.cooNotificationsModule = notificationsModule;
});
