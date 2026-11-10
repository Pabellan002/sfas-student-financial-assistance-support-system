import AssessmentDashboardModule from '../modules/assessment/assessment-dashboardModule.js?v=20261014-report-layout';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const module = new AssessmentDashboardModule();
    await module.init();
    window.assessmentDashboardModule = module;

    const notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    window.assessmentNotificationsModule = notificationsModule;
});
