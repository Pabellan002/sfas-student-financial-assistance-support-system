import AssessmentSettingsModule from '../modules/assessment/assessment-settingsModule.js?v=20261007-profile-dob';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js?v=20261020-csdl-pn-tagging';
import { initSettingsExtras } from '../shared/shared-settings-extras.js';
import { announceSettingsPageShown, initSettingsPageNavigation } from '../shared/shared-settings-page-navigation.js?v=20260926-settings-refresh';

document.addEventListener('DOMContentLoaded', async () => {
    const activeCollapse = initSettingsPageNavigation('assessmentSettingsAccordion');
    initSettingsExtras('staff');
    const module = new AssessmentSettingsModule();
    await module.init();
    announceSettingsPageShown(activeCollapse);

    const notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    window.assessmentNotificationsModule = notificationsModule;
});
