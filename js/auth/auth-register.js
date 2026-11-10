import RegisterModule from '../modules/auth/auth-registerModule.js?v=20261011-mobile-no-zero';

let registerModule;

const boot = async () => {
    if (!registerModule) {
        registerModule = new RegisterModule();
    }
    await registerModule.init();
};

document.addEventListener('DOMContentLoaded', boot);

window.addEventListener('pageshow', (event) => {
    if (!registerModule) return;
    if (event.persisted || registerModule.shouldResetAfterSubmit()) {
        registerModule.resetForm();
    }
});
