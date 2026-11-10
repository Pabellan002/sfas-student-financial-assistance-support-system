import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const module = new AssessmentNotificationsModule();
    await module.init();
    window.assessmentNotificationsModule = module;
});
