import CooSettingsModule from '../modules/coo/coo-settingsModule.js?v=20261007-profile-dob';
import CooNotificationsModule from '../modules/coo/coo-notificationsModule.js';
import { initSettingsExtras } from '../shared/shared-settings-extras.js';
import { announceSettingsPageShown, initSettingsPageNavigation } from '../shared/shared-settings-page-navigation.js?v=20260926-settings-refresh';

document.addEventListener('DOMContentLoaded', () => {
    const activeCollapse = initSettingsPageNavigation('cooSettingsAccordion');
    initSettingsExtras('staff');
    const settingsModule = new CooSettingsModule();
    settingsModule.init();
    window.settingsModule = settingsModule;

    const notificationsModule = new CooNotificationsModule();
    notificationsModule.init();
    window.cooNotificationsModule = notificationsModule;
    announceSettingsPageShown(activeCollapse);
});
