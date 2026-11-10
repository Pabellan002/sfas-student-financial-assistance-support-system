import CsdlPnTaggingModule from '../modules/csdl/csdl-pn-taggingModule.js?v=20261020-separate-pn-tagging';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const module = new CsdlPnTaggingModule();
    window.csdlPnTaggingModule = module;
    await module.init();

    const notifications = new CsdlNotificationsModule();
    await notifications.init();
    window.csdlNotificationsModule = notifications;
});
