import MasterfilesStudentsModule from '../modules/masterfiles/masterfiles-studentsModule.js?v=20261029-refresh';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';
import { initMasterfilesActionDdViewport } from '../modules/masterfiles/masterfiles-action-dd-viewport.js';

document.addEventListener('DOMContentLoaded', async () => {
    initMasterfilesActionDdViewport();
    const mod = new MasterfilesStudentsModule();
    await mod.init();
    
    // Initialize notifications
    const notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
});

