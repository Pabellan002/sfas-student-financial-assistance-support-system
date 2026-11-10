import BranchAdminSettingsModule from '../modules/branch-admin/branch-admin-settingsModule.js?v=20261007-profile-dob';
import BranchAdminNotificationsModule from '../modules/branch-admin/branch-admin-notificationsModule.js';
import { initSettingsExtras } from '../shared/shared-settings-extras.js';
import { announceSettingsPageShown, initSettingsPageNavigation } from '../shared/shared-settings-page-navigation.js?v=20260926-settings-refresh';

document.addEventListener('DOMContentLoaded', () => {
    const activeCollapse = initSettingsPageNavigation('branchSettingsAccordion');
    initSettingsExtras('staff');
    const settingsModule = new BranchAdminSettingsModule();
    settingsModule.init();
    window.branchAdminSettingsModule = settingsModule;

    const notificationsModule = new BranchAdminNotificationsModule();
    notificationsModule.init();
    window.branchAdminNotificationsModule = notificationsModule;
    announceSettingsPageShown(activeCollapse);
});
