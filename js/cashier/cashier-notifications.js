import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js';

document.addEventListener('DOMContentLoaded', () => {
    const module = new AssessmentNotificationsModule();
    module.init();
    window.cashierNotificationsModule = module;
});
