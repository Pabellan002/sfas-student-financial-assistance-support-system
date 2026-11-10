import AppPaths from '../../services/services-appPaths.js';
import { showSessionReplacementNotice } from './auth-sessionReplacement.js';

class SessionManagerModule {
    constructor(options = {}) {
        this.checkUrl = options.checkUrl || '/auth/auth-check-session.php';
        this.logoutUrl = options.logoutUrl || '/auth/auth-logout.php';
        this.loginPage = options.loginPage || AppPaths.page('views/auth/login.html');
        this.intervalMs = options.intervalMs || 15000; // 15s heartbeat for responsiveness
        this.warningLeadSec = options.warningLeadSec || 60; // warn when <= 60s remaining
        this.defaultTimeoutSec = options.defaultTimeoutSec || 300; // 5 minutes fallback
        this.forceClientTimeoutSec = options.forceClientTimeoutSec || null; // if set, override backend remaining for testing
        this.warningShown = false;
        this.timer = null;
        this._lastRefreshAt = Date.now();
        this.debug = options.debug !== undefined ? options.debug : false;
        this.activityDebounceMs = options.activityDebounceMs || 30000; // 30s debounce between pulses
        this._lastPulseAt = 0;
        this._sessionEndsAt = null;
        this._warningTimerId = null;
        /** True after we have seen an authenticated active session this page load (avoids false "session expired" for guests). */
        this._hadActiveSession = false;
    }

    log(...args) {
        if (!this.debug) return;
        // Debug logging disabled
    }

    start() {
        this.stop();
        this.log('start()', { intervalMs: this.intervalMs, warningLeadSec: this.warningLeadSec, defaultTimeoutSec: this.defaultTimeoutSec });
        // Immediately refresh activity once on load so countdown starts fresh
        this.pulse().catch(() => {});
        this.tick();
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.bindActivity();
        this._lastRefreshAt = Date.now();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async tick() {
        if (document.hidden || window.__sessionReplacementNoticeShown) return;
        try {
            const base = this.getBaseURL();
            const url = base + this.checkUrl + (this.checkUrl.includes('?') ? '&' : '?') + 'peek=1';
            this.log('tick() → requesting', url);
            const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Session-Peek': '1' } });
            this.log('tick() ← response', { status: res.status, ok: res.ok });
            const data = await res.json();
            if (window.__sessionReplacementNoticeShown) return;
            this.log('tick() ← data', data);
            if (!data || data.success !== true) {
                this.log('tick() bad or unsuccessful payload → skip');
                return;
            }
            // Not logged in uses the same payload as timed-out session; only redirect if we were signed in before.
            if (!data.active) {
                this.log('inactive session peek', { hadActive: this._hadActiveSession });
                if (this._hadActiveSession) {
                    this.redirectToLogin(data.reason === 'signed_in_elsewhere' ? 'signed_in_elsewhere' : 'session_expired');
                }
                return;
            }
            this._hadActiveSession = true;

            const remainingFromBackend = typeof data.remaining === 'number' ? data.remaining : null;

            // Determine effective remaining time
            // If warning is already shown, don't reset _sessionEndsAt - preserve the locked countdown
            let effectiveRemaining = null;
            if (this.warningShown && this._sessionEndsAt) {
                // Warning already displayed - use the locked end time
                effectiveRemaining = Math.ceil((this._sessionEndsAt - Date.now()) / 1000);
                this.log('warning shown - using locked sessionEndsAt', { sessionEndsAt: this._sessionEndsAt, effectiveRemaining });
            } else {
                // Warning not shown yet - calculate normally
                if (typeof this.forceClientTimeoutSec === 'number' && this.forceClientTimeoutSec > 0) {
                    const elapsedSec = Math.floor((Date.now() - this._lastRefreshAt) / 1000);
                    effectiveRemaining = this.forceClientTimeoutSec - elapsedSec;
                    this._sessionEndsAt = this._lastRefreshAt + (this.forceClientTimeoutSec * 1000);
                } else if (remainingFromBackend !== null) {
                    effectiveRemaining = remainingFromBackend;
                    this._sessionEndsAt = Date.now() + (remainingFromBackend * 1000);
                }
            }

            const shouldWarn = effectiveRemaining !== null ? effectiveRemaining <= this.warningLeadSec : !!data.warn;
            this.log('computed', { remaining: effectiveRemaining, backendRemaining: remainingFromBackend, forceClientTimeoutSec: this.forceClientTimeoutSec, shouldWarn, warningLeadSec: this.warningLeadSec });
            if (shouldWarn && !this.warningShown) {
                this.warningShown = true;
                // Lock in the session end time when warning is first shown (only if not already set)
                if (!this._sessionEndsAt) {
                    if (typeof this.forceClientTimeoutSec === 'number' && this.forceClientTimeoutSec > 0) {
                        this._sessionEndsAt = Date.now() + (effectiveRemaining * 1000);
                    } else if (effectiveRemaining !== null) {
                        this._sessionEndsAt = Date.now() + (effectiveRemaining * 1000);
                    }
                    this.log('warning first shown - locked sessionEndsAt', { sessionEndsAt: this._sessionEndsAt, effectiveRemaining, timeNow: Date.now() });
                }
                const secsNow = this._sessionEndsAt ? Math.ceil((this._sessionEndsAt - Date.now()) / 1000) : (effectiveRemaining ?? 0);
                this.showWarning(Math.max(0, secsNow));
            }
            if (!shouldWarn) this.warningShown = false;

            // Handle countdowns and auto-logout when backend doesn't return remaining OR when forced testing is enabled
            if (effectiveRemaining === null || typeof this.forceClientTimeoutSec === 'number') {
                const elapsedSec = Math.floor((Date.now() - this._lastRefreshAt) / 1000);
                const targetTimeout = typeof this.forceClientTimeoutSec === 'number' && this.forceClientTimeoutSec > 0
                    ? this.forceClientTimeoutSec
                    : this.defaultTimeoutSec;
                const localRemaining = targetTimeout - elapsedSec;
                this.log('fallbackCountdown', { elapsedSec, localRemaining, targetTimeout });
                // Schedule precise opening at exactly the threshold if we're within one interval
                const intervalSec = Math.max(1, Math.round(this.intervalMs / 1000));
                if (!this.warningShown && localRemaining > this.warningLeadSec && localRemaining <= this.warningLeadSec + intervalSec) {
                    if (this._warningTimerId) clearTimeout(this._warningTimerId);
                    const msUntilThreshold = Math.max(0, (localRemaining - this.warningLeadSec) * 1000);
                    this._warningTimerId = setTimeout(() => {
                        this.warningShown = true;
                        this.showWarning(this.warningLeadSec);
                    }, msUntilThreshold);
                }
                if (localRemaining <= 0) {
                    this.log('fallback reached 0 → redirect');
                    if (this._hadActiveSession) {
                        this.redirectToLogin('session_expired');
                    }
                    return;
                }
                if (localRemaining <= this.warningLeadSec && !this.warningShown) {
                    this.warningShown = true;
                    this.showWarning(Math.max(0, localRemaining));
                }
                if (localRemaining > this.warningLeadSec) this.warningShown = false;
            }
        } catch (e) {
            // Network error: ignore one-off failures
            this.log('tick() error', e?.message || e);
        }
    }

    bindActivity() {
        const onActivity = () => {
            // Do not auto-close the SweetAlert on mere activity; keep the warning visible
            // If warning is already shown, don't reset the session timer by pulsing
            if (this.warningShown) {
                this.log('activity detected but warning already shown - not pulsing to preserve countdown');
                return;
            }
            this.warningShown = false;
            const now = Date.now();
            if (now - (this._lastPulseAt || 0) < (this.activityDebounceMs || 30000)) return;
            this._lastPulseAt = now;
            this.pulse();
        };
        ['click','keydown','mousemove','scroll','touchstart','touchmove'].forEach(evt => {
            window.addEventListener(evt, onActivity, { passive: true });
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                onActivity();
                this.tick();
            }
        });
        // Force reload when returning from bfcache (back/forward navigation)
        window.addEventListener('pageshow', (ev) => {
            if (ev.persisted) {
                try { window.location.reload(); } catch (_) {}
            }
        });
    }

    showWarning(remainingSec) {
        if (!window.Swal) return;
        let secs = Math.max(0, remainingSec | 0);
        this.log('showWarning', { remainingSec: secs });
        let intervalId = null;
        const format = (s) => `${Math.max(0, s)}s`;
        const modalWidth = (typeof window !== 'undefined' && window.innerWidth <= 576) ? '92vw' : '420px';
        Swal.fire({
            icon: 'warning',
            title: 'Session will expire soon',
            html: `Your session will expire in <b id="sm-count">${format(secs)}</b> due to inactivity.`,
            width: modalWidth,
            padding: '1rem',
            focusConfirm: false,
            customClass: { popup: 'sm-session-warning' },
            confirmButtonText: 'Stay signed in',
            denyButtonText: 'Logout',
            showDenyButton: true,
            reverseButtons: true,
            confirmButtonColor: '#0a8f1b',
            denyButtonColor: '#dc3545',
            didOpen: () => {
                const label = Swal.getHtmlContainer()?.querySelector('#sm-count');
                const computeRemaining = () => {
                    if (this._sessionEndsAt) {
                        const ms = this._sessionEndsAt - Date.now();
                        return Math.max(0, Math.ceil(ms / 1000));
                    }
                    return Math.max(0, secs);
                };
                intervalId = setInterval(() => {
                    secs = computeRemaining();
                    this.log('countdown tick', { secs, sessionEndsAt: this._sessionEndsAt });
                    if (label) label.textContent = format(secs);
                    if (secs <= 0) {
                        this.log('countdown reached 0 - closing modal and logging out');
                        clearInterval(intervalId);
                        // Close the modal - the .then() handler will catch the dismissal and log out
                        Swal.close();
                    }
                }, 1000);
            },
            willClose: () => { if (intervalId) clearInterval(intervalId); }
        }).then(async (result) => {
            if (window.__sessionReplacementNoticeShown) return;
            this.log('warning result', result);
            if (result.isDenied) {
                try {
                    const base = this.getBaseURL();
                    const token = document.querySelector('meta[name="csrf-token"]')?.content || '';
                    this.log('logout from warning (user clicked logout)');
                    await fetch(base + this.logoutUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': token,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        credentials: 'same-origin',
                        body: JSON.stringify({ csrf_token: token })
                    });
                } catch (_) {}
                this.redirectToLogin('signed_out');
            } else if (result.isConfirmed) {
                this.log('stay signed in → pulse');
                // Reset session timer when user chooses to stay signed in
                this._sessionEndsAt = null;
                this.warningShown = false;
                try { await this.pulse(); } catch (_) {}
            } else {
                // User closed the modal without clicking either button (e.g., countdown reached 0, or ESC key)
                this.log('warning closed without user action - auto logout');
                try {
                    const base = this.getBaseURL();
                    const token = document.querySelector('meta[name="csrf-token"]')?.content || '';
                    await fetch(base + this.logoutUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': token,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        credentials: 'same-origin',
                        body: JSON.stringify({ csrf_token: token })
                    });
                } catch (_) {}
                this.redirectToLogin('session_expired');
            }
        }).catch((err) => {
            this.log('warning promise rejected', err);
        });
    }

    redirectToLogin(reason = '') {
        if (window.__sessionReplacementNoticeShown) return;
        this.log('redirectToLogin →', this.loginPage);
        
        const loginPath = AppPaths.page('views/auth/login.html');
        if (reason === 'signed_in_elsewhere') {
            this.stop();
            showSessionReplacementNotice(loginPath);
            return;
        }
        let finalPath = loginPath;
        if (reason === 'signed_out' || reason === 'session_expired') {
            const separator = finalPath.includes('?') ? '&' : '?';
            finalPath = `${finalPath}${separator}${reason}=1`;
        }
        window.location.href = finalPath;
    }

    getBaseURL() {
        return AppPaths.apiBase;
    }

    async pulse() {
        if (window.__sessionReplacementNoticeShown) return;
        try {
            const base = this.getBaseURL();
            const url = base + this.checkUrl + (this.checkUrl.includes('?') ? '&' : '?') + 'update=1';
            this.log('pulse →', url);
            const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Session-Update': '1' } });
            const data = await res.json();
            if (data?.success === true && data.active === false && data.reason === 'signed_in_elsewhere') {
                this.redirectToLogin('signed_in_elsewhere');
                return;
            }
            if (data?.success === true && data.active === true) {
                this._hadActiveSession = true;
                this._lastRefreshAt = Date.now();
            }
        } catch (_) {}
    }

}

export default SessionManagerModule;
