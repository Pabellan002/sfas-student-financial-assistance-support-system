import LoginModule, { finishAuthGate } from '../modules/auth/auth-loginModule.js?v=20260930-password-dismiss';

let loginModule;
let initialized = false;

const boot = async () => {
    try {
        const raw = localStorage.getItem('session_debug_log');
        if (raw) {
            // Recent redirect log available
        }
    } catch (_) {
        // ignore
    }
    try {
        if (!loginModule) loginModule = new LoginModule();
        await loginModule.init();
    } finally {
        initialized = true;
        // Show login UI only when we remain on this page.
        finishAuthGate();
    }
};

document.addEventListener('DOMContentLoaded', boot);

// Handle bfcache restore (Back/Forward) where DOMContentLoaded won't fire
const recheck = async () => {
    if (!initialized) return;
    try {
        if (!loginModule) loginModule = new LoginModule();
        await loginModule.redirectIfAlreadyLoggedIn();
    } catch (_) {}
    // On bfcache/back navigation where user remains on login page, ensure gate is removed.
    finishAuthGate();
};

window.addEventListener('pageshow', (event) => { if (event.persisted) recheck(); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); }, { passive: true });
