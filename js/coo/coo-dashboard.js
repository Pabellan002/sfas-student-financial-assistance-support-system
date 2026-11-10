import CooDashboardModule from '../modules/coo/coo-dashboardModule.js?v=20261014-report-layout';
import CooNotificationsModule from '../modules/coo/coo-notificationsModule.js';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new CooDashboardModule();
    await mod.init();

    const notificationsModule = new CooNotificationsModule();
    notificationsModule.init();
    window.cooNotificationsModule = notificationsModule;
});
