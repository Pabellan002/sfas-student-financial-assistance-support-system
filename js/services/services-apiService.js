import AppPaths from './services-appPaths.js';
class ApiService {
    static csrfRefreshPromise = null;

    static getBaseURL() {
        return AppPaths.apiBase;
    }

    static async request(endpoint, options = {}) {
        const baseURL = this.getBaseURL();
        let ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        const currentPath = AppPaths.portalPath();
        if (currentPath.includes('/views/assessment/') || currentPath.includes('/views/security/assessment/') || currentPath.startsWith('/assessment/')) {
            ep = ep.replace(/^\/finance\/finance-/, '/assessment/assessment-');
        } else if (currentPath.includes('/views/cashier/') || currentPath.includes('/views/security/cashier/') || currentPath.startsWith('/cashier/')) {
            ep = ep.replace(/^\/assessment\/assessment-/, '/cashier/cashier-');
        }
        // cache-bust GETs
        const isGet = (options.method || 'GET').toUpperCase() === 'GET';
        const bust = isGet ? (`${ep}${ep.includes('?') ? '&' : '?'}_=${Date.now()}`) : ep;
        const url = `${baseURL}${bust}`;
        
        const method = options.method || 'GET';
        const isDataRequest = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase());
        const suppressErrors = options.suppressErrors || false;
        
        const isFormData = options.data instanceof FormData;
        const config = {
            method: method,
            url: url,
            // Let the browser/axios add the multipart boundary for FormData.
            headers: isFormData
                ? { ...options.headers }
                : { 'Content-Type': 'application/json', ...options.headers },
            withCredentials: true,
            validateStatus: suppressErrors ? (status) => status < 500 : undefined
        };

        if (options.data) {
            config.data = options.data;
        } else if (options.params) {
            config.params = options.params;
        }

        let token = document.querySelector('meta[name="csrf-token"]')?.content;
        if (isDataRequest && !token) {
            token = await this.refreshCSRFToken();
        }
        if (isDataRequest && token) {
            config.headers['X-CSRF-Token'] = token;
            if (config.data instanceof FormData) {
                config.data.set('csrf_token', token);
            } else if (typeof config.data === 'object' && config.data !== null) {
                config.data.csrf_token = token;
            }
        }

        try {
            const response = await axios(config);
            if (suppressErrors && response.status === 401) {
                return { success: false, authenticated: false };
            }
            if (typeof response.data === 'string' && response.data.includes('{')) {
                const jsonMatch = response.data.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        return JSON.parse(jsonMatch[0]);
                    } catch (e) {}
                }
            }
            return response.data;
        } catch (error) {
            if (suppressErrors && error.response?.status === 401) {
                return { success: false, authenticated: false };
            }
            let errorData = error.response?.data;
            if (typeof errorData === 'string') {
                try {
                    errorData = JSON.parse(errorData);
                } catch (_) {
                    errorData = null;
                }
            }
            if (errorData?.error_code === 'CSRF_INVALID') {
                const newToken = await this.refreshCSRFToken();
                if (newToken) {
                    if (config.data instanceof FormData) {
                        config.data.set('csrf_token', newToken);
                    } else if (config.data && typeof config.data === 'object') {
                        config.data.csrf_token = newToken;
                    } else if (typeof config.data === 'string') {
                        try {
                            const parsedData = JSON.parse(config.data);
                            if (parsedData && typeof parsedData === 'object') {
                                parsedData.csrf_token = newToken;
                                config.data = JSON.stringify(parsedData);
                            }
                        } catch (_) {
                            // Header validation still covers non-JSON request bodies.
                        }
                    }
                    config.headers['X-CSRF-Token'] = newToken;
                    const retryResponse = await axios(config);
                    return retryResponse.data;
                }
            }
            throw error;
        }
    }

    static async refreshCSRFToken() {
        if (!this.csrfRefreshPromise) {
            this.csrfRefreshPromise = (async () => {
                try {
                    const baseURL = this.getBaseURL();
                    const response = await axios.get(`${baseURL}/includes/includes-csrf-endpoint.php?action=get_token`, { withCredentials: true });
                    if (response.data.success) {
                        const metaTag = document.querySelector('meta[name="csrf-token"]');
                        if (metaTag) {
                            metaTag.setAttribute('content', response.data.token);
                        } else {
                            const meta = document.createElement('meta');
                            meta.name = 'csrf-token';
                            meta.content = response.data.token;
                            document.head.appendChild(meta);
                        }
                        return response.data.token;
                    }
                } catch (error) {}
                return null;
            })();
        }

        try {
            return await this.csrfRefreshPromise;
        } finally {
            this.csrfRefreshPromise = null;
        }
    }

    static async get(endpoint, params = {}, options = {}) {
        return this.request(endpoint, {
            method: 'GET',
            params,
            ...options
        });
    }

    static async post(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'POST',
            data
        });
    }

    static async put(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'PUT',
            data
        });
    }

    static async delete(endpoint) {
        return this.request(endpoint, {
            method: 'DELETE'
        });
    }

    static async postFormData(endpoint, formData) {
        return this.request(endpoint, {
            method: 'POST',
            data: formData
        });
    }
}

export default ApiService;
