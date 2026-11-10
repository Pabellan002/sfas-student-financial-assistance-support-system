import CsdlDashboardModule from '../modules/csdl/csdl-dashboardModule.js?v=20261014-report-layout';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new CsdlDashboardModule();
    window.csdlDashboard = mod;
    await mod.init();
    
    const notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
});

