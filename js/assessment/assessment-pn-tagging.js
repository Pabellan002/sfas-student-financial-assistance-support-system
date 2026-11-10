import AssessmentPnTaggingModule from '../modules/assessment/assessment-pn-taggingModule.js?v=20261020-separate-pn-tagging';
import AssessmentNotificationsModule from '../modules/assessment/assessment-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const module = new AssessmentPnTaggingModule();
    window.assessmentPnTaggingModule = module;
    await module.init();

    const notificationsModule = new AssessmentNotificationsModule();
    await notificationsModule.init();
    window.assessmentNotificationsModule = notificationsModule;
});
