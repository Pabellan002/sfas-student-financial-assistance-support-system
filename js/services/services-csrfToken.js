const csrfApiBase = new URL('../../api/', document.currentScript.src).href;

class CSRFTokenService {
    
    static async getToken() {
        try {
            const response = await axios.get(`${csrfApiBase}includes/includes-csrf-endpoint.php?action=get_token`);
            if (response.data.success) {
                return response.data.token;
            }
            throw new Error('Failed to get CSRF token');
        } catch (error) {
            throw error;
        }
    }
    
    static addToken(data) {
        const token = document.querySelector('meta[name="csrf-token"]')?.content;
        
        if (!token) {
            return data;
        }
        
        if (data instanceof FormData) {
            data.append('csrf_token', token);
        } else if (typeof data === 'object') {
            data.csrf_token = token;
        }
        
        return data;
    }
    
    static addTokenToHeaders(config) {
        const token = document.querySelector('meta[name="csrf-token"]')?.content;
        
        if (token) {
            if (!config.headers) {
                config.headers = {};
            }
            config.headers['X-CSRF-Token'] = token;
        }
        
        return config;
    }
    
    static setupAxiosInterceptor() {
        axios.interceptors.request.use(
            (config) => {
                if (['post', 'put', 'delete', 'patch'].includes(config.method.toLowerCase())) {
                    const token = document.querySelector('meta[name="csrf-token"]')?.content;
                    if (token) {
                        config.headers = config.headers || {};
                        config.headers['X-CSRF-Token'] = token;
                    }
                }
                return config;
            },
            (error) => {
                return Promise.reject(error);
            }
        );
    }
}

