import CooNotificationsModule from '../modules/coo/coo-notificationsModule.js';

document.addEventListener('DOMContentLoaded', () => {
    const module = new CooNotificationsModule();
    module.init();
    window.cooNotificationsModule = module;
});
