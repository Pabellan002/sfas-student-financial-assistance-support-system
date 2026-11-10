import ForgetPasswordModule from '../modules/auth/auth-forget-passwordModule.js?v=20260929-password-toggle';

document.addEventListener('DOMContentLoaded', async () => {
    const mod = new ForgetPasswordModule();
    await mod.init();
});


