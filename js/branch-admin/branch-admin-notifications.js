import BranchAdminNotificationsModule from '../modules/branch-admin/branch-admin-notificationsModule.js';

document.addEventListener('DOMContentLoaded', () => {
    const module = new BranchAdminNotificationsModule();
    module.init();
    window.branchAdminNotificationsModule = module;
});
