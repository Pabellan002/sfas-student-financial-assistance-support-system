// Service Worker for Push Notifications
const appBase = new URL('./', self.location.href).pathname.replace(/\/$/, '');
self.addEventListener('push', function(event) {
    let notificationData = {
        title: 'New Notification',
        body: 'You have a new notification',
        icon: `${appBase}/assets/images/i.png`,
        badge: `${appBase}/assets/images/i.png`,
        tag: 'notification',
        requireInteraction: false,
        data: {}
    };

    if (event.data) {
        try {
            const data = event.data.json();
            
            notificationData = {
                title: data.title || notificationData.title,
                body: data.body || data.message || notificationData.body,
                icon: data.icon || notificationData.icon,
                badge: data.badge || notificationData.badge,
                tag: data.tag || `notification-${data.id || Date.now()}`,
                data: data.data || data || {},
                requireInteraction: data.requireInteraction || false
            };
        } catch (e) {
            console.error('[Service Worker] Error parsing push data:', e);
        }
    }
    
    event.waitUntil(
        self.registration.showNotification(notificationData.title, {
            body: notificationData.body,
            icon: notificationData.icon,
            badge: notificationData.badge,
            tag: notificationData.tag,
            data: notificationData.data,
            requireInteraction: notificationData.requireInteraction,
            vibrate: [200, 100, 200]
        })
    );
});

// Handle notification click
self.addEventListener('notificationclick', function(event) {
    event.notification.close();

    const notificationData = event.notification.data || {};
    const loanId = notificationData.loanId;
    const userType = notificationData.userType || 'student';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            // Try to focus an existing window
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url.includes('/students/') || client.url.includes('/csdl/')) {
                    if ('focus' in client) {
                        return client.focus();
                    }
                }
            }

            // If no window is open, open a new one
            let url = appBase ? `${appBase}/views/students/students-dashboard.html` : '/students/dashboard';
            
            if (loanId) {
                // Navigate to loan details if loan ID is provided
                if (userType === 'student') {
                    url = appBase
                        ? `${appBase}/views/students/students-loans.html?openLoan=${loanId}`
                        : `/students/loans?openLoan=${loanId}`;
                } else if (userType === 'employee') {
                    url = appBase
                        ? `${appBase}/views/csdl/csdl-loans-management.html?openLoan=${loanId}`
                        : `/csdl/loans-management?openLoan=${loanId}`;
                }
            }
            
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

// Handle notification close
self.addEventListener('notificationclose', function(event) {
    // Optional: Track notification dismissal
});






