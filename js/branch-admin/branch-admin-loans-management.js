import BranchAdminLoansManagementModule from '../modules/branch-admin/branch-admin-loans-mangementModule.js?v=20261018-overdue-countdown';
import BranchAdminNotificationsModule from '../modules/branch-admin/branch-admin-notificationsModule.js';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new BranchAdminLoansManagementModule();
    window.branchAdminLoansManagementModule = mod;
    await mod.init();

    const notificationsModule = new BranchAdminNotificationsModule();
    notificationsModule.init();
    window.branchAdminNotificationsModule = notificationsModule;
});
