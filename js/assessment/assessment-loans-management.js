import AssessmentLoansManagementModule from '../modules/assessment/assessment-loans-managementModule.js?v=20261018-overdue-countdown';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const module = new AssessmentLoansManagementModule();
    window.assessmentLoansManagementModule = module;
    await module.init();

    const notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    window.assessmentNotificationsModule = notificationsModule;
});
