import SessionManagerModule from '../modules/auth/auth-sessionManagerModule.js?v=20261011-five-minute-session';

(function () {
    const path = window.location.pathname || '';
    // Public auth pages: never run heartbeat (guests look "inactive" to peek API — would wrongly add ?session_expired=1).
    if (path.includes('/auth/login.html') || path.includes('/auth/forget-password')) {
        return;
    }
    const start = () => {
        const mgr = new SessionManagerModule({ intervalMs: 5000, warningLeadSec: 60, defaultTimeoutSec: 300, debug: false, loginPage: '../auth/login.html' });
        mgr.start();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
