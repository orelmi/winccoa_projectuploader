/**
 * WinCC OA Project Manager - Service Worker
 * Provides offline support, caching, and background sync
 * Author: orelmi
 */

const CACHE_NAME = 'winccoa-pm-v1';
const STATIC_ASSETS = [
    '/project',
    '/project/css/style.css',
    '/project/js/app.js'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[ServiceWorker] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[ServiceWorker] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('[ServiceWorker] Install complete');
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('[ServiceWorker] Install failed:', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[ServiceWorker] Activating...');
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => {
                            console.log('[ServiceWorker] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[ServiceWorker] Activate complete');
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests and API calls
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip WebSocket upgrade requests
    if (event.request.headers.get('Upgrade') === 'websocket') {
        return;
    }

    // Skip API endpoints (use network only)
    if (url.pathname.includes('/project/pmon') ||
        url.pathname.includes('/project/history') ||
        url.pathname.includes('/project/download') ||
        url.pathname.includes('/project/restart') ||
        url.pathname.includes('/project/csrf') ||
        url.pathname.includes('/logs/')) {
        return;
    }

    // Network-first strategy for HTML, cache-first for assets
    if (url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) {
        // Cache-first for static assets
        event.respondWith(
            caches.match(event.request)
                .then((cachedResponse) => {
                    if (cachedResponse) {
                        // Return cached version, but update cache in background
                        fetchAndCache(event.request);
                        return cachedResponse;
                    }
                    return fetchAndCache(event.request);
                })
        );
    } else {
        // Network-first for HTML pages
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // Clone and cache the response
                    if (response.ok) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Fallback to cache if network fails
                    return caches.match(event.request)
                        .then((cachedResponse) => {
                            if (cachedResponse) {
                                return cachedResponse;
                            }
                            // Return offline page if available
                            return caches.match('/project');
                        });
                })
        );
    }
});

// Helper function to fetch and cache
function fetchAndCache(request) {
    return fetch(request)
        .then((response) => {
            if (response.ok) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(request, responseClone);
                });
            }
            return response;
        });
}

// Handle push notifications
self.addEventListener('push', (event) => {
    console.log('[ServiceWorker] Push received');

    let data = { title: 'WinCC OA', body: 'Notification', icon: '/project/icon.png' };

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body || 'New notification',
        icon: data.icon || '/project/icon.png',
        badge: '/project/badge.png',
        vibrate: [100, 50, 100],
        data: {
            url: data.url || '/project'
        },
        actions: [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'WinCC OA Project Manager', options)
    );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
    console.log('[ServiceWorker] Notification clicked');
    event.notification.close();

    if (event.action === 'dismiss') {
        return;
    }

    const url = event.notification.data?.url || '/project';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // Focus existing window if available
                for (const client of clientList) {
                    if (client.url.includes('/project') && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Open new window
                if (clients.openWindow) {
                    return clients.openWindow(url);
                }
            })
    );
});

// Handle background sync for failed uploads
self.addEventListener('sync', (event) => {
    console.log('[ServiceWorker] Sync event:', event.tag);

    if (event.tag === 'upload-retry') {
        event.waitUntil(retryFailedUploads());
    }
});

// Retry failed uploads from IndexedDB
async function retryFailedUploads() {
    console.log('[ServiceWorker] Retrying failed uploads...');
    // This would read from IndexedDB and retry uploads
    // Implementation depends on how upload state is stored
}

// Message handler for communication with main thread
self.addEventListener('message', (event) => {
    console.log('[ServiceWorker] Message received:', event.data);

    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data.type === 'GET_VERSION') {
        event.ports[0].postMessage({ version: CACHE_NAME });
    }

    if (event.data.type === 'CLEAR_CACHE') {
        caches.delete(CACHE_NAME).then(() => {
            event.ports[0].postMessage({ success: true });
        });
    }
});
