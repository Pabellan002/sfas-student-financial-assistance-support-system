(() => {
    const originalPath = window.location.pathname;
    const path = originalPath.replace(/^\/(csdl|students|assessment|coo|branch-admin|cashier|masterfiles)\//, '/views/$1/');
    const section = path.match(/\/views\/(students|cashier|assessment|coo|branch-admin|csdl|masterfiles)\//)?.[1];
    if (!section || !document.body) return;

    const role = section === 'masterfiles' ? 'csdl' : section;
    const isMasterfiles = section === 'masterfiles';
    const cleanRoutes = /^\/(csdl|students|assessment|coo|branch-admin|cashier|masterfiles)\//.test(originalPath);
    const pages = {
        students: {
            id: 'studentMobileBottomNav', className: 'student-mobile-bottom-nav', bodyClass: 'students-mobile-bottom-nav-enabled',
            label: 'Student mobile navigation', linkClass: 'student-mobile-bottom-nav__link',
            items: [
                ['students-dashboard.html', 'bi-speedometer2', 'Home'],
                ['students-loans.html', 'bi-clipboard-data', 'Loans'],
                ['students-chat.html', 'bi-chat-dots', 'Chat'],
                ['students-settings.html', 'bi-gear', 'Settings']
            ]
        },
        cashier: {
            id: 'financeMobileBottomNav', className: 'finance-mobile-bottom-nav', bodyClass: 'finance-mobile-bottom-nav-enabled',
            label: 'Cashier mobile navigation', linkClass: 'finance-mobile-bottom-nav__link',
            items: [
                ['cashier-dashboard.html', 'bi-speedometer2', 'Home'],
                ['cashier-loans-management.html', 'bi-clipboard-data', 'Loans'],
                ['cashier-settings.html', 'bi-gear', 'Settings']
            ]
        },
        assessment: {
            id: 'assessmentMobileBottomNav', className: 'assessment-mobile-bottom-nav', bodyClass: 'assessment-mobile-bottom-nav-enabled',
            label: 'Assessment mobile navigation', linkClass: 'assessment-mobile-bottom-nav__link',
            items: [
                ['assessment-dashboard.html', 'bi-speedometer2', 'Home'],
                ['assessment-loans-management.html', 'bi-clipboard-data', 'Loans'],
                ['assessment-balances-management.html', 'bi-wallet2', 'Balances'],
                ['assessment-pn-tagging.html', 'bi-journal-check', 'PN Tagging'],
                ['assessment-settings.html', 'bi-gear', 'Settings']
            ]
        },
        coo: {
            id: 'cooMobileBottomNav', className: 'coo-mobile-bottom-nav', bodyClass: 'coo-mobile-bottom-nav-enabled',
            label: 'COO mobile navigation', linkClass: 'coo-mobile-bottom-nav__link',
            items: [
                ['coo-dashboard.html', 'bi-speedometer2', 'Home'],
                ['coo-loans-management.html', 'bi-clipboard-data', 'Loans'],
                ['coo-settings.html', 'bi-gear', 'Settings']
            ]
        },
        'branch-admin': {
            id: 'branchAdminMobileBottomNav', className: 'branch-admin-mobile-bottom-nav', bodyClass: 'branch-admin-mobile-bottom-nav-enabled',
            label: 'Branch admin mobile navigation', linkClass: 'branch-admin-mobile-bottom-nav__link',
            items: [
                ['branch-admin-dashboard.html', 'bi-speedometer2', 'Home'],
                ['branch-admin-loans-mangement.html', 'bi-clipboard-data', 'Loans'],
                ['branch-admin-settings.html', 'bi-gear', 'Settings']
            ]
        },
        csdl: {
            id: 'csdlMobileBottomNav', className: 'csdl-mobile-bottom-nav', bodyClass: 'csdl-mobile-bottom-nav-enabled',
            label: 'CSDL mobile navigation', linkClass: 'csdl-mobile-bottom-nav__link',
            items: [
                ['csdl-dashboard.html', 'bi-speedometer2', 'Home', 'dashboard'],
                ['csdl-loans-management.html', 'bi-clipboard-data', 'Loans', 'loans'],
                ['csdl-pn-tagging.html', 'bi-journal-check', 'PN Tagging', 'pntagging'],
                ['csdl-settings.html', 'bi-gear', 'Settings', 'settings']
            ]
        }
    };
    const page = pages[role];
    if (!page || document.getElementById(page.id)) return;

    const slug = (file) => role === 'branch-admin' && file === 'branch-admin-loans-mangement.html'
        ? 'loans'
        : file.slice(role.length + 1, -5);
    const current = path.split('/').pop() || '';
    const href = (file) => cleanRoutes
        ? `/${role}/${slug(file)}`
        : `${isMasterfiles ? '../csdl/' : ''}${file}`;

    const nav = document.createElement('nav');
    nav.id = page.id;
    if (role === 'csdl') {
        nav.style.gridTemplateColumns = 'none';
        nav.style.gridAutoFlow = 'column';
        nav.style.gridAutoColumns = 'minmax(0, 1fr)';
    }
    nav.className = `${page.className} d-lg-none`;
    nav.setAttribute('aria-label', page.label);
    nav.innerHTML = page.items.map(([file, icon, label, key]) => {
        const active = current === file || (cleanRoutes && current === slug(file));
        const balanceClass = role === 'assessment' && file === 'assessment-balances-management.html' ? ' is-balance' : '';
        return `<a class="${page.linkClass}${balanceClass}${active ? ' is-active' : ''}" href="${href(file)}"${key ? ` data-csdl-nav="${key}"` : ''}${active ? ' aria-current="page"' : ''}><i class="bi ${icon}" aria-hidden="true"></i><span>${label}</span></a>`;
    }).join('');

    document.body.classList.add(page.bodyClass);
    document.body.prepend(nav);
})();
