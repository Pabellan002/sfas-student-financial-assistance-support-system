import SessionChecker from '../modules/auth/auth-sessionCheckerModule.js';

// Run immediately to avoid showing protected content before redirect
(async () => {
    const checker = new SessionChecker();
    await checker.ensureActive();
})();

// Re-validate on back/forward navigation and on tab visibility restore
const recheck = async () => {
    try {
        const checker = new SessionChecker();
        await checker.ensureActive();
    } catch (_) {}
};

window.addEventListener('pageshow', recheck, { passive: true });
window.addEventListener('popstate', recheck, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); }, { passive: true });


