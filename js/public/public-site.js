(() => {
    'use strict';

    const appBase = new URL('../../', document.currentScript.src).pathname.replace(/\/$/, '');
    if (!appBase) {
        const publicRoutes = {
            '/index.html': '/',
            '/views/public/about.html': '/about',
            '/views/public/apply.html': '/apply',
            '/views/public/contact.html': '/contact',
            '/views/auth/login.html': '/login',
            '/views/auth/register.html': '/register'
        };
        document.querySelectorAll('a[href]').forEach((link) => {
            let target;
            try { target = new URL(link.href); } catch (_) { return; }
            if (target.origin !== location.origin) return;
            const route = publicRoutes[target.pathname];
            if (route) link.href = route + target.search + target.hash;
        });
    }

    const menu = document.querySelector('.menu-toggle');
    const navigation = document.getElementById('site-nav');
    if (menu && navigation) {
        navigation.classList.add('is-enhanced');
        menu.hidden = false;
        const setMenu = (open) => {
            navigation.classList.toggle('is-open', open);
            menu.setAttribute('aria-expanded', String(open));
            menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
            const symbol = menu.querySelector('use');
            if (symbol) {
                symbol.setAttribute('href', symbol.getAttribute('href').replace(/#[^#]+$/, open ? '#x-lg' : '#list'));
            }
        };
        menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
        navigation.addEventListener('click', (event) => {
            if (event.target.closest('a')) setMenu(false);
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('.site-header')) setMenu(false);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
                setMenu(false);
                menu.focus();
            }
        });
        window.matchMedia('(min-width: 901px)').addEventListener('change', () => setMenu(false));
    }

    // All panels remain available as ordinary anchor sections without JavaScript.
    function enhanceTabs(listSelector, panelsSelector) {
        const list = document.querySelector(listSelector);
        const panelGroup = document.querySelector(panelsSelector);
        if (!list || !panelGroup) return;
        const tabs = Array.from(list.querySelectorAll('a[href^="#"]'));
        const panels = tabs.map(tab => document.getElementById(tab.hash.slice(1)));
        if (!tabs.length || panels.some(panel => !panel)) return;

        panelGroup.classList.add('is-enhanced');
        list.setAttribute('role', 'tablist');
        // The guide becomes a horizontal grid on narrower screens.
        const guide = list.matches('.guide-tabs');
        const orientationQuery = window.matchMedia('(max-width: 900px)');
        const updateOrientation = () => {
            list.setAttribute('aria-orientation', guide && orientationQuery.matches ? 'horizontal' : 'vertical');
        };
        updateOrientation();
        orientationQuery.addEventListener('change', updateOrientation);
        tabs.forEach((tab, index) => {
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', panels[index].id);
            panels[index].setAttribute('role', 'tabpanel');
            panels[index].setAttribute('aria-labelledby', tab.id);
            panels[index].tabIndex = 0;
        });
        const select = (index, focus = false) => {
            tabs.forEach((tab, position) => {
                const active = index === position;
                tab.setAttribute('aria-selected', String(active));
                tab.tabIndex = active ? 0 : -1;
                panels[position].hidden = !active;
            });
            if (focus) tabs[index].focus();
        };
        const hashIndex = () => panels.findIndex(panel => '#' + panel.id === window.location.hash);
        const initialIndex = hashIndex();
        select(initialIndex >= 0 ? initialIndex : 0);

        tabs.forEach((tab, index) => {
            tab.addEventListener('click', (event) => {
                event.preventDefault();
                select(index);
                try {
                    window.history.replaceState(null, '', tab.hash);
                } catch (_) {
                    // Tab navigation works even if history updates are unavailable.
                }
                if (window.matchMedia('(max-width: 640px)').matches) {
                    panels[index].scrollIntoView({
                        block: 'start',
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
                    });
                }
            });
            tab.addEventListener('keydown', (event) => {
                let next;
                const horizontal = list.getAttribute('aria-orientation') === 'horizontal';
                if (event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) next = (index + 1) % tabs.length;
                if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) next = (index - 1 + tabs.length) % tabs.length;
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = tabs.length - 1;
                if (next !== undefined) {
                    event.preventDefault();
                    select(next, true);
                }
            });
        });
        window.addEventListener('hashchange', () => {
            const index = hashIndex();
            if (index >= 0) {
                select(index);
                panels[index].scrollIntoView({ block: 'start' });
            }
        });
        if (initialIndex >= 0) {
            requestAnimationFrame(() => panels[initialIndex].scrollIntoView({ block: 'start' }));
        }
    }

    enhanceTabs('.guide-tabs', '.guide-panels');
    enhanceTabs('.topic-list', '.support-panels');

    const checklist = document.querySelector('.checklist');
    if (checklist) {
        const inputs = Array.from(checklist.querySelectorAll('input[type="checkbox"]'));
        const count = document.getElementById('checklist-count');
        const progress = document.getElementById('checklist-progress');
        const storageKey = 'sfas-public-preparation-v1';
        try {
            const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
            if (Array.isArray(saved)) {
                inputs.forEach(input => { input.checked = saved.includes(input.dataset.checklistItem); });
            }
        } catch (_) {
            // Checklist also works when browser storage is unavailable.
        }
        const update = () => {
            const checked = inputs.filter(input => input.checked);
            if (count) count.textContent = checked.length + ' of ' + inputs.length + ' ready';
            if (progress) progress.value = checked.length;
            try {
                sessionStorage.setItem(storageKey, JSON.stringify(checked.map(input => input.dataset.checklistItem)));
            } catch (_) {}
        };
        checklist.addEventListener('change', update);
        window.addEventListener('pageshow', update);
        update();
    }


    // Content remains visible without motion support or JavaScript.
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if ('IntersectionObserver' in window && typeof Element.prototype.animate === 'function') {
        const activeAnimations = new Set();
        const observer = new IntersectionObserver((entries) => {
            let delay = 0;
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                observer.unobserve(entry.target);
                if (motionPreference.matches) return;
                const animation = entry.target.animate(
                    [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'translateY(0)' }],
                    { duration: 550, delay: Math.min(delay, 160), easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'backwards' }
                );
                delay += 55;
                activeAnimations.add(animation);
                animation.addEventListener('finish', () => activeAnimations.delete(animation), { once: true });
                animation.addEventListener('cancel', () => activeAnimations.delete(animation), { once: true });
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
        document.querySelectorAll('[data-reveal], .faq-list details, .office-list article, .footer-campus')
            .forEach(element => observer.observe(element));
        motionPreference.addEventListener('change', () => {
            if (motionPreference.matches) {
                activeAnimations.forEach(animation => animation.cancel());
                activeAnimations.clear();
            }
        });
    }

    document.querySelectorAll('[data-year]').forEach(element => {
        element.textContent = String(new Date().getFullYear());
    });
})();
