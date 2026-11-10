import MasterfilesCampusesModule from '../modules/masterfiles/masterfiles-campusesModule.js?v=20261014-report-layout';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';
import { initMasterfilesActionDdViewport } from '../modules/masterfiles/masterfiles-action-dd-viewport.js';

document.addEventListener('DOMContentLoaded', async () => {
    initMasterfilesActionDdViewport();
    const mod = new MasterfilesCampusesModule();
    await mod.init();
    await mod.bindBulkDeleteControls();

    const notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
});
