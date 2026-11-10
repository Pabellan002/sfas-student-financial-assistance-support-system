import CsdlNotificationsModule from '../modules/csdl/csdl-notificationsModule.js?v=20261020-csdl-pn-tagging';

document.addEventListener('DOMContentLoaded', () => {
    const module = new CsdlNotificationsModule();
    module.init();
    window.csdlNotificationsModule = module;
});
