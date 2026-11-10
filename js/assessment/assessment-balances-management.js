import AssessmentBalancesManagementModule from '../modules/assessment/assessment-balances-managementModule.js?v=20261014-report-layout';
import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new AssessmentBalancesManagementModule();
    window.assessmentBalancesManagementModule = mod; // Make it globally accessible for onclick handlers
    await mod.init();

    // Initialize notifications
    const notificationsModule = new CsdlNotificationsModule();
    notificationsModule.init();
    window.csdlNotificationsModule = notificationsModule;
});
