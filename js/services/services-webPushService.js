import AppPaths from './services-appPaths.js';
import ApiService from './services-apiService.js';

class WebPushService {
    constructor() {
        this.registration = null;
        this.subscription = null;
        this.vapidPublicKey = null;
        this.userType = null;
    }

    /**
     * Initialize Web Push service
     */
    async init() {
        // Check if browser supports service workers and push
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            return false;
        }

        // Determine user type
        this.userType = document.body.dataset.userType || 
                       (window.location.pathname.includes('/students/') ? 'student' : 
                       (window.location.pathname.includes('/csdl/') ||
                        window.location.pathname.includes('/masterfiles/') ||
                        window.location.pathname.includes('/finance/') ||
                        window.location.pathname.includes('/assessment/') ||
                        window.location.pathname.includes('/coo/') ||
                        window.location.pathname.includes('/cashier/') ||
                        window.location.pathname.includes('/branch-admin/') ? 'employee' : null));

        if (!this.userType) {
            return false;
        }

        try {
            // Register service worker
            const appBase = AppPaths.basePath;
            this.registration = await navigator.serviceWorker.register(`${appBase}/sw.js`);
            
            // Get VAPID public key
            await this.fetchVapidKey();
            
            if (!this.vapidPublicKey) {
                return false;
            }
            
            // Check existing subscription
            this.subscription = await this.registration.pushManager.getSubscription();
            
            return true;
        } catch (error) {
            console.error('[WebPushService] Init error:', error);
            return false;
        }
    }

    /**
     * Fetch VAPID public key from server
     */
    async fetchVapidKey() {
        try {
            const endpoint = this.userType === 'student' 
                ? '/students/students-push-subscriptions.php?vapid=1'
                : '/csdl/csdl-push-subscriptions.php?vapid=1';
            
            const response = await ApiService.get(endpoint);
            if (response.success && response.publicKey) {
                this.vapidPublicKey = response.publicKey;
            }
        } catch (error) {
            console.error('[WebPushService] Error fetching VAPID key:', error);
        }
    }

    /**
     * Request notification permission
     */
    async requestPermission() {
        if (Notification.permission === 'granted') {
            return true;
        }

        const permission = await Notification.requestPermission();
        return permission === 'granted';
    }

    /**
     * Subscribe to push notifications
     */
    async subscribe() {
        if (!this.registration) {
            return false;
        }

        if (!this.vapidPublicKey) {
            await this.fetchVapidKey();
            if (!this.vapidPublicKey) {
                console.error('[WebPushService] Cannot subscribe: no VAPID key');
                return false;
            }
        }

        try {
            // Request permission
            const hasPermission = await this.requestPermission();
            
            if (!hasPermission) {
                return false;
            }

            // Convert VAPID key to Uint8Array
            const applicationServerKey = this.urlBase64ToUint8Array(this.vapidPublicKey);

            // Subscribe to push
            this.subscription = await this.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });
            
            // Send subscription to server
            const subscriptionData = {
                endpoint: this.subscription.endpoint,
                keys: {
                    p256dh: this.arrayBufferToBase64(this.subscription.getKey('p256dh')),
                    auth: this.arrayBufferToBase64(this.subscription.getKey('auth'))
                }
            };

            const endpoint = this.userType === 'student'
                ? '/students/students-push-subscriptions.php'
                : '/csdl/csdl-push-subscriptions.php';
                
            const response = await ApiService.post(endpoint, {
                action: 'subscribe',
                subscription: subscriptionData
            });
            
            if (response.success) {
                return true;
            }

            console.error('[WebPushService] Server rejected subscription');
            return false;
        } catch (error) {
            console.error('[WebPushService] Subscribe error:', error);
            return false;
        }
    }

    /**
     * Unsubscribe from push notifications
     */
    async unsubscribe() {
        if (!this.subscription) {
            return true;
        }

        try {
            // Unsubscribe from push manager
            const successful = await this.subscription.unsubscribe();
            
            if (successful) {
                // Notify server
                const endpoint = this.userType === 'student'
                    ? '/students/students-push-subscriptions.php'
                    : '/csdl/csdl-push-subscriptions.php';

                await ApiService.post(endpoint, {
                    action: 'unsubscribe',
                    endpoint: this.subscription.endpoint
                });

                this.subscription = null;
            }

            return successful;
        } catch (error) {
            console.error('[WebPushService] Unsubscribe error:', error);
            return false;
        }
    }

    /**
     * Check if user is subscribed
     */
    async isSubscribed() {
        if (!this.registration) {
            return false;
        }

        try {
            this.subscription = await this.registration.pushManager.getSubscription();
            return this.subscription !== null;
        } catch (error) {
            return false;
        }
    }

    /**
     * Convert URL-safe base64 to Uint8Array
     */
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');

        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);

        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    /**
     * Convert ArrayBuffer to base64
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }
}

// Create singleton instance
const webPushService = new WebPushService();

export default webPushService;





