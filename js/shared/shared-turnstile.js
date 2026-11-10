import ApiService from '../services/services-apiService.js';

let apiPromise;
const modalWidgets = new WeakMap();

function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!apiPromise) {
        apiPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            const fail = () => reject(new Error('Security verification could not load. Check your connection and refresh the page.'));
            const timer = setTimeout(fail, 15000);
            script.addEventListener('load', () => {
                clearTimeout(timer);
                if (window.turnstile) resolve(window.turnstile);
                else fail();
            });
            script.addEventListener('error', () => { clearTimeout(timer); fail(); });
            document.head.appendChild(script);
        });
    }
    return apiPromise;
}

// One instance per form: tokens must never be shared between actions or requests.
export default class TurnstileWidget {
    constructor(container, action) {
        this.container = typeof container === 'string' ? document.getElementById(container) : container;
        this.action = action;
        this.token = '';
        this.widgetId = null;
        this.renderedSize = null;
        this.busy = false;
        this.rendering = false;
        this.verificationPromise = null;
        this.verificationReject = null;
        this.overlayMode = this.container?.dataset.overlay === 'true';
        this.resizeFrame = null;
        if (!this.container) throw new Error('Security verification container is missing.');

        this.container.classList.add('turnstile-responsive');
        this.host = document.createElement('div');
        this.host.className = 'turnstile-responsive__host';
        this.status = document.createElement('p');
        this.status.className = 'turnstile-responsive__status small text-danger mt-2 mb-0 d-none';
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');
        this.container.append(this.host, this.status);

        // Settings sections may start inside collapsed accordions or hidden tabs.
        this.observer = new ResizeObserver(() => this.handleResize());
        this.observer.observe(this.container);
        this.renderIfVisible();
    }

    getResponsiveSize() {
        // Cloudflare's flexible widget has a 300px minimum width. Use its
        // 150px compact layout whenever the form cannot safely provide that.
        const availableWidth = this.host?.clientWidth || this.container.clientWidth;
        return availableWidth >= 300 ? 'flexible' : 'compact';
    }

    handleResize() {
        if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = requestAnimationFrame(() => {
            this.resizeFrame = null;
            if (this.widgetId === null) {
                this.renderIfVisible();
                return;
            }

            const nextSize = this.getResponsiveSize();
            if (nextSize === this.renderedSize || this.busy || !window.turnstile) return;

            // Turnstile does not resize an existing iframe between compact and
            // flexible modes, so replace it after crossing the 300px boundary.
            this.token = '';
            this.showMessage('');
            try {
                window.turnstile.remove(this.widgetId);
                this.widgetId = null;
                this.renderedSize = null;
                this.host.replaceChildren();
                this.renderIfVisible();
            } catch (_) {
                // Leave the current usable widget in place if replacement fails.
            }
        });
    }

    async renderIfVisible() {
        if (this.widgetId !== null || this.rendering || !this.container.getClientRects().length) return;
        this.rendering = true;
        try {
            const api = await loadTurnstile();
            if (!this.container.isConnected || !this.container.getClientRects().length) return;
            const size = this.getResponsiveSize();
            this.widgetId = api.render(this.host, {
                sitekey: this.container.dataset.sitekey,
                action: this.action,
                theme: 'light',
                size,
                'refresh-expired': 'manual',
                'refresh-timeout': 'manual',
                callback: token => {
                    this.token = token;
                    this.showMessage('');
                    this.container.dispatchEvent(new CustomEvent('turnstile:verified', {
                        detail: { token }
                    }));
                },
                'expired-callback': () => this.reset(),
                'timeout-callback': () => this.reset(),
                'error-callback': () => {
                    this.token = '';
                    this.showMessage('Security verification failed. Please retry the check or refresh the page.');
                    return true;
                }
            });
            this.renderedSize = size;
        } catch (error) {
            this.token = '';
            const message = error.message || 'Security verification is unavailable. Please refresh the page.';
            this.showMessage(message);
            this.cancelPendingVerification(message);
        } finally {
            this.rendering = false;
        }
    }

    showMessage(message) {
        this.status.textContent = message;
        this.status.classList.toggle('d-none', !message);
    }

    reset() {
        this.token = '';
        this.showMessage('');
        this.cancelPendingVerification('Security verification expired. Please try again.');
        this.closeOverlay();
        if (this.widgetId !== null && window.turnstile) {
            try {
                window.turnstile.reset(this.widgetId);
            } catch (_) {
                this.showMessage('Please refresh the page to restart security verification.');
            }
        }
    }

    openOverlay() {
        if (!this.overlayMode) return;
        this.container.classList.remove('d-none');
        document.body.classList.add('turnstile-overlay-open');
    }

    closeOverlay() {
        if (!this.overlayMode) return;
        this.container.classList.add('d-none');
        document.body.classList.remove('turnstile-overlay-open');
    }

    cancelPendingVerification(message) {
        if (!this.verificationReject) return;
        const reject = this.verificationReject;
        this.verificationReject = null;
        this.closeOverlay();
        reject(new Error(message));
    }

    async waitForVerification() {
        if (this.token) return this.token;
        if (!this.overlayMode) {
            throw new Error('Please complete security verification before continuing.');
        }
        if (this.verificationPromise) return this.verificationPromise;

        this.openOverlay();
        const pendingVerification = new Promise((resolve, reject) => {
            this.verificationReject = reject;
            this.container.addEventListener('turnstile:verified', event => {
                this.verificationReject = null;
                this.closeOverlay();
                resolve(event.detail?.token || this.token);
            }, { once: true });
        });
        this.verificationPromise = pendingVerification;
        await this.renderIfVisible();

        try {
            return await pendingVerification;
        } finally {
            if (this.verificationPromise === pendingVerification) {
                this.verificationPromise = null;
            }
            this.verificationReject = null;
        }
    }

    async run(request) {
        if (this.busy) {
            const message = 'A request is already in progress. Please wait.';
            const error = new Error(message);
            error.response = { data: { message } };
            throw error;
        }

        if (!this.token) {
            try {
                await this.waitForVerification();
            } catch (error) {
                const message = error.message || 'Please complete security verification before continuing.';
                this.showMessage(message);
                error.response = error.response || { data: { message } };
                throw error;
            }
        }

        if (this.busy) {
            const message = 'A request is already in progress. Please wait.';
            const error = new Error(message);
            error.response = { data: { message } };
            throw error;
        }

        this.busy = true;
        const token = this.token;
        try {
            return await request(token);
        } finally {
            // Even failed account/OTP requests may have consumed the token.
            this.reset();
            this.busy = false;
        }
    }

    post(endpoint, data = {}) {
        return this.run(token => ApiService.post(endpoint, { ...data, 'cf-turnstile-response': token }));
    }

    postFormData(endpoint, data) {
        return this.run(token => {
            data.set('cf-turnstile-response', token);
            return ApiService.postFormData(endpoint, data);
        });
    }

    static forModal(modalId, action) {
        const modal = document.getElementById(modalId);
        if (!modal) throw new Error('The verification dialog is unavailable.');
        let entry = modalWidgets.get(modal);
        if (entry && entry.action === action) return entry.widget;
        if (entry) {
            entry.widget.observer.disconnect();
            if (entry.widget.widgetId !== null && window.turnstile) window.turnstile.remove(entry.widget.widgetId);
            entry.widget.container.remove();
        }
        const profileContainer = document.getElementById('profileTurnstile');
        const useOverlay = profileContainer?.dataset.overlay === 'true';
        const container = document.createElement('div');
        container.className = useOverlay ? 'settings-turnstile-overlay d-none' : 'mt-3';
        if (useOverlay) container.dataset.overlay = 'true';
        container.setAttribute('aria-label', 'Security verification for resending a code');
        container.dataset.sitekey = profileContainer.dataset.sitekey;
        (useOverlay ? document.body : modal.querySelector('.modal-body')).appendChild(container);
        const widget = new TurnstileWidget(container, action);
        modalWidgets.set(modal, { action, widget });
        return widget;
    }

    static bindModal(modalId, getAction) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        modal.addEventListener('shown.bs.modal', () => TurnstileWidget.forModal(modalId, getAction()));
        modal.addEventListener('hidden.bs.modal', () => modalWidgets.get(modal)?.widget.reset());
    }
}
