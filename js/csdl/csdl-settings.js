import CsdlSettingsModule from '../modules/csdl/csdl-settingsModule.js?v=20261014-report-layout';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';
import { initSettingsExtras } from '../shared/shared-settings-extras.js';
import { announceSettingsPageShown, initSettingsPageNavigation } from '../shared/shared-settings-page-navigation.js?v=20260926-settings-refresh';

let settingsModule;
let notificationsModule;

document.addEventListener('DOMContentLoaded', () => {
    const activeCollapse = initSettingsPageNavigation('csdlSettingsAccordion');
    initSettingsExtras('staff');
    settingsModule = new CsdlSettingsModule();
    settingsModule.init();
    window.settingsModule = settingsModule;
    
    // Initialize notifications
    notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
    announceSettingsPageShown(activeCollapse);
});
