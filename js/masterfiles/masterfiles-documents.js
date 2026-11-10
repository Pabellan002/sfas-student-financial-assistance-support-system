import MasterfilesDocumentsModule from '../modules/masterfiles/masterfiles-documentsModule.js?v=20261029-refresh';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const module = new MasterfilesDocumentsModule();
    window.masterfilesDocumentsModule = module;
    await module.init();
    await module.bindBulkDeleteControls();
    
    // Initialize notifications
    const notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
});
