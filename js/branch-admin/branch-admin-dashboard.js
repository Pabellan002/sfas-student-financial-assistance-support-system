import BranchAdminDashboardModule from '../modules/branch-admin/branch-admin-dashboardModule.js?v=20261014-report-layout';
import BranchAdminNotificationsModule from '../modules/branch-admin/branch-admin-notificationsModule.js';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new BranchAdminDashboardModule();
    window.branchAdminDashboard = mod;
    await mod.init();

    const notificationsModule = new BranchAdminNotificationsModule();
    notificationsModule.init();
    window.branchAdminNotificationsModule = notificationsModule;
});
