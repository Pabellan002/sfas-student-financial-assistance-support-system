export const PORTAL_MOBILE_BREAKPOINT = '(max-width: 991.98px)';

export function getPortalNotificationBellLink() {
    return document.querySelector('.notifications-bell-link');
}

export function getPortalNotificationMenu() {
    return document.querySelector('.notifications-menu');
}

export function closePortalNotificationDropdown() {
    const toggle = getPortalNotificationBellLink();
    const menu = getPortalNotificationMenu();
    if (!menu || !toggle) return;

    if (window.bootstrap?.Dropdown) {
        try {
            window.bootstrap.Dropdown.getOrCreateInstance(toggle).hide();
            return;
        } catch (_) {
            // Fallback below.
        }
    }

    menu.classList.remove('show');
    toggle.classList.remove('show');
    toggle.setAttribute('aria-expanded', 'false');
}

export function configurePortalBellNavigation(notificationsPageUrl, state = { bound: false }) {
    const toggle = getPortalNotificationBellLink();
    if (!toggle) return;

    const mql = window.matchMedia(PORTAL_MOBILE_BREAKPOINT);

    const apply = () => {
        if (window.bootstrap?.Dropdown) {
            const instance = window.bootstrap.Dropdown.getInstance(toggle);
            if (instance) instance.dispose();
        }

        if (mql.matches) {
            toggle.setAttribute('href', notificationsPageUrl);
            toggle.removeAttribute('data-bs-toggle');
            toggle.removeAttribute('role');
            toggle.removeAttribute('aria-expanded');
            toggle.removeAttribute('data-bs-popper-config');
            toggle.removeAttribute('data-bs-boundary');
            closePortalNotificationDropdown();
        } else {
            toggle.setAttribute('href', '#');
            toggle.setAttribute('data-bs-toggle', 'dropdown');
            toggle.setAttribute('role', 'button');
            toggle.setAttribute('data-bs-popper-config', '{"strategy":"fixed"}');
            toggle.setAttribute('data-bs-boundary', 'viewport');
        }
    };

    apply();

    if (!state.bound) {
        state.bound = true;
        mql.addEventListener('change', apply);
    }
}

export function wirePortalViewAllLink(notificationsPageUrl) {
    document.querySelectorAll('.notifications-view-all').forEach((link) => {
        link.setAttribute('href', notificationsPageUrl);
        if (link.dataset.viewAllBound === '1') return;
        link.dataset.viewAllBound = '1';
        link.addEventListener('click', () => closePortalNotificationDropdown());
    });
}

export function bindPortalNotificationDropdownClose() {
    if (document.body.dataset.portalNotificationCloseBound === '1') return;
    document.body.dataset.portalNotificationCloseBound = '1';

    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (window.matchMedia(PORTAL_MOBILE_BREAKPOINT).matches) return;

        const bellToggle = getPortalNotificationBellLink();
        const menu = getPortalNotificationMenu();
        if (!bellToggle || !menu) return;

        if (target.closest('#notificationsList')) return;
        if (target.closest('#markAllReadBtn')) return;
        if (target.closest('.notifications-view-all')) return;
        if (target.closest('.notifications-bell-link') === bellToggle) return;
        if (target.closest('.notifications-menu') === menu) return;

        closePortalNotificationDropdown();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePortalNotificationDropdown();
    });

    window.addEventListener('scroll', () => closePortalNotificationDropdown(), { passive: true });
    window.addEventListener('resize', () => closePortalNotificationDropdown(), { passive: true });
}
