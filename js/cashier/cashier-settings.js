import CashierSettingsModule from '../modules/cashier/cashier-settingsModule.js?v=20261007-profile-dob';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js';
import { initSettingsExtras } from '../shared/shared-settings-extras.js';
import { announceSettingsPageShown, initSettingsPageNavigation } from '../shared/shared-settings-page-navigation.js?v=20260926-settings-refresh';

let settingsModule;
let notificationsModule;

document.addEventListener('DOMContentLoaded', async () => {
    const activeCollapse = initSettingsPageNavigation('cashierSettingsAccordion');
    initSettingsExtras('staff');
    settingsModule = new CashierSettingsModule();
    settingsModule.init();
    window.settingsModule = settingsModule;
    
    // Initialize notifications (AssessmentNotificationsModule supports cashier portal)
    notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    
    window.cashierNotificationsModule = notificationsModule;
    announceSettingsPageShown(activeCollapse);
});
