// Resolve from this file, so APIs and links work at /, /sfas/, or any other folder.
// Page URLs can be rewritten by the web server; the module URL stays unambiguous.
const installation = new URL('../../', import.meta.url);
const basePath = installation.pathname.replace(/\/$/, '');
const portalPrefix = /^\/(csdl|students|assessment|coo|branch-admin|cashier|masterfiles)\//;

const AppPaths = {
    basePath,
    apiBase: `${installation.origin}${basePath}/api`,

    url(path = '') {
        return `${basePath}/${path.replace(/^\/+/, '')}`;
    },

    relativePath(pathname = window.location.pathname) {
        return basePath && pathname.startsWith(`${basePath}/`)
            ? pathname.slice(basePath.length)
            : pathname;
    },

    portalPath() {
        return this.relativePath().replace(portalPrefix, '/views/$1/');
    },

    page(path) {
        const relative = `/${path.replace(/^\/+/, '')}`;
        // The existing domain-root deployment has clean routes. Folder installs
        // use the actual HTML URLs, without requiring those extra rewrite rules.
        if (!basePath) {
            const auth = relative.match(/^\/views\/auth\/(login|register|forget-password)\.html([?#].*)?$/);
            if (auth) return `/${auth[1]}${auth[2] || ''}`;
            const portal = relative.match(/^\/views\/(csdl|students|assessment|coo|branch-admin|cashier|masterfiles)\/\1-([\w-]+)\.html([?#].*)?$/);
            if (portal) {
                const slug = portal[1] === 'branch-admin' && portal[2] === 'loans-mangement' ? 'loans' : portal[2];
                return `/${portal[1]}/${slug}${portal[3] || ''}`;
            }
        }
        return this.url(relative);
    },
};

export default AppPaths;
