import AppPaths from '../services/services-appPaths.js';
import SessionCheckerModule from '../modules/auth/auth-sessionCheckerModule.js';
import rbacUtil from './shared-rbac.js?v=20261020-csdl-pn-tagging';
import './shared-sidebar-live-counts.js?v=20261020-csdl-pn-tagging';

function getPortalPath() {
    return AppPaths.portalPath();
}

function installCleanNavigationLinks() {
    if (AppPaths.basePath) return;

    const roles = new Set(['csdl', 'students', 'assessment', 'coo', 'branch-admin', 'cashier', 'masterfiles']);
    const cleanHref = (href) => {
        let url;
        try { url = new URL(href, location.href); } catch (_) { return null; }
        if (url.origin !== location.origin) return null;
        const path = url.pathname.replace(/^\/views\//, '/');
        const parts = path.split('/').filter(Boolean);
        let target = null;

        if (parts.length === 2 && roles.has(parts[0]) && parts[1].startsWith(`${parts[0]}-`) && parts[1].endsWith('.html')) {
            let slug = parts[1].slice(parts[0].length + 1, -5);
            if (parts[0] === 'branch-admin' && slug === 'loans-mangement') slug = 'loans';
            target = `/${parts[0]}/${slug}`;
        } else if (parts.length === 2 && parts[0] === 'auth') {
            const authRoutes = { 'login.html': '/login', 'register.html': '/register', 'forget-password.html': '/forget-password' };
            target = authRoutes[parts[1]] || null;
        } else if (parts.length === 2 && parts[0] === 'public' && /^(about|apply|contact)\.html$/.test(parts[1])) {
            target = `/${parts[1].slice(0, -5)}`;
        }

        return target ? `${target}${url.search}${url.hash}` : null;
    };
    const update = (root) => {
        if (root.nodeType !== Node.ELEMENT_NODE) return;
        const links = root.matches('a[href]') ? [root] : root.querySelectorAll('a[href]');
        links.forEach((link) => {
            const next = cleanHref(link.getAttribute('href'));
            if (next && next !== link.getAttribute('href')) {
                link.dataset.legacyHref = link.getAttribute('href');
                link.setAttribute('href', next);
            }
        });
    };

    update(document.body);
    new MutationObserver((changes) => {
        changes.forEach((change) => {
            if (change.type === 'attributes') update(change.target);
            else change.addedNodes.forEach(update);
        });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
}

async function fetchSession() {
    const checker = new SessionCheckerModule();
    const base = checker.getBaseURL();
    const res = await fetch(base + '/auth/auth-check-session.php', { credentials: 'same-origin' });
    return res.json();
}

/** Sidebar bottom profile → settings (must run even if session fetch fails) */
function attachSidebarProfileNavigation() {
    const el =
        document.getElementById('sidebarProfileToSettings') ||
        document.querySelector('#sidebarMenu .mt-auto .d-flex.align-items-center');
    if (!el) {
        return;
    }
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const explicit = el.getAttribute('data-settings-href');
        if (explicit) {
            window.location.href = explicit;
            return;
        }
        const currentPath = getPortalPath();
        let settingsPath = 'settings.html';
        if (currentPath.includes('/csdl/')) {
            settingsPath = 'csdl-settings.html';
        } else if (currentPath.includes('/masterfiles/')) {
            settingsPath = '../csdl/csdl-settings.html';
        } else if (currentPath.includes('/students/')) {
            settingsPath = 'students-settings.html';
        } else if (currentPath.includes('/assessment/')) {
            settingsPath = 'assessment-settings.html';
        } else if (currentPath.includes('/cashier/')) {
            settingsPath = 'cashier-settings.html';
        } else if (currentPath.includes('/coo/')) {
            settingsPath = 'coo-settings.html';
        } else if (currentPath.includes('/branch-admin/')) {
            settingsPath = 'branch-admin-settings.html';
        } else if (currentPath.includes('/assessment/')) {
            settingsPath = 'assessment-settings.html';
        } else {
            settingsPath = 'csdl/csdl-settings.html';
        }
        window.location.href = settingsPath;
    });
}

/** Build one flat, sectioned CSDL sidebar on CSDL and Masterfiles pages. */
function normalizeCsdlSidebar() {
    const path = getPortalPath() || '';
    const isCsdlPage = path.includes('/views/csdl/') || path.includes('/views/security/csdl/');
    const isMasterfilesPage = path.includes('/views/masterfiles/') || path.includes('/views/security/masterfiles/');
    if (!isCsdlPage && !isMasterfilesPage) return;

    const sidebar = document.getElementById('sidebarMenu');
    if (!sidebar || sidebar.classList.contains('csdl-sidebar-modern')) return;
    sidebar.classList.add('csdl-sidebar-modern');

    const makeSectionLabel = (text, modifier = '') => {
        const item = document.createElement('li');
        item.className = `csdl-sidebar-section-label${modifier ? ` ${modifier}` : ''}`;
        item.setAttribute('aria-hidden', 'true');
        item.innerHTML = `<span class="link-text">${text}</span>`;
        return item;
    };

    const desktopNav = sidebar.querySelector('.csdl-sidebar-desktop-nav');
    if (desktopNav) {
        const masterfilesToggle = desktopNav.querySelector('a[data-bs-toggle="collapse"][href="#masterfilesMenu"]');
        const parentItem = masterfilesToggle?.closest('li.nav-item');
        const submenuList = parentItem?.querySelector('#masterfilesMenu > ul');
        if (parentItem && submenuList) {
            parentItem.before(makeSectionLabel('Masterfiles', 'csdl-sidebar-section-label--masterfiles'));
            Array.from(submenuList.children).forEach((item) => parentItem.before(item));
            parentItem.remove();
        }
    }

    sidebar.querySelectorAll('.csdl-sidebar-mobile-masterfiles').forEach((mobileNav) => {
        mobileNav.prepend(makeSectionLabel('Masterfiles', 'csdl-sidebar-section-label--masterfiles'));
    });
}

function renderSidebar(user) {
    return `
    <div class="d-flex flex-column h-100">
      <div class="p-3 border-bottom">
        <div class="fw-semibold" style="letter-spacing:.5px; color:#6c757d;">PHINMA EDUCATION</div>
        <div class="small text-muted">CSDL Admin</div>
      </div>
      <ul class="nav nav-pills flex-column p-2 gap-1">
        <li class="nav-item"><a class="nav-link active" href="csdl-dashboard.html"><i class="bi bi-speedometer2 me-2"></i>Dashboard</a></li>
        <li class="nav-item"><a class="nav-link" href="#"><i class="bi bi-cash-coin me-2"></i>Loans</a></li>
        <li class="nav-item"><a class="nav-link" href="#"><i class="bi bi-gear me-2"></i>Settings</a></li>
      </ul>
      <div class="mt-auto p-3 border-top">
        <div class="d-flex align-items-center sidebar-profile-container">
          <div class="rounded-circle bg-success-subtle d-flex align-items-center justify-content-center sidebar-profile-avatar" style="width:40px;height:40px;">
            <i class="bi bi-person text-success"></i>
          </div>
          <div class="ms-2 sidebar-profile-text">
            <div class="fw-semibold">${user?.user?.name ?? 'User'}</div>
            <div class="text-muted small">ID: ${user?.user?.id ?? '-'}</div>
          </div>
          <button id="btnSidebarLogout" class="btn btn-outline-danger btn-sm ms-auto"><i class="bi bi-box-arrow-right"></i></button>
        </div>
      </div>
    </div>`;
}

function renderHeader(user) {
    return `
    <h5 class="mb-0">Dashboard</h5>
    <div class="d-flex align-items-center gap-2">
      <span class="text-muted small d-none d-md-inline">${user?.user?.name ?? ''}</span>
      <button id="btnHeaderLogout" class="btn btn-outline-danger btn-sm"><i class="bi bi-box-arrow-right"></i> Logout</button>
    </div>`;
}

function initStudentMobileBottomNav() {
    const path = getPortalPath() || '';
    if (!path.includes('/views/students/')) {
        return;
    }

    const body = document.body;
    if (!body) {
        return;
    }
    body.classList.add('students-mobile-bottom-nav-enabled');

    const existing = document.getElementById('studentMobileBottomNav');
    if (existing) {
        return;
    }

    const items = [
        { href: 'students-dashboard.html', icon: 'bi-speedometer2', label: 'Home' },
        { href: 'students-loans.html', icon: 'bi-clipboard-data', label: 'Loans' },
        { href: 'students-chat.html', icon: 'bi-chat-dots', label: 'Chat' },
        { href: 'students-settings.html', icon: 'bi-gear', label: 'Settings' }
    ];

    const currentFile = path.split('/').pop() || '';
    const nav = document.createElement('nav');
    nav.id = 'studentMobileBottomNav';
    nav.className = 'student-mobile-bottom-nav d-lg-none';
    nav.setAttribute('aria-label', 'Student mobile navigation');

    nav.innerHTML = items.map((item) => {
        const isActive = currentFile === item.href;
        return `
            <a class="student-mobile-bottom-nav__link${isActive ? ' is-active' : ''}" href="${item.href}">
                <i class="bi ${item.icon}" aria-hidden="true"></i>
                <span>${item.label}</span>
            </a>
        `;
    }).join('');

    document.body.appendChild(nav);
}

function initFinanceMobileBottomNav() {
    const path = getPortalPath() || '';
    if (!path.includes('/views/cashier/') && !path.includes('/views/security/cashier/')) {
        return;
    }
    const body = document.body;
    if (!body) {
        return;
    }

    body.classList.add('finance-mobile-bottom-nav-enabled');

    const existing = document.getElementById('financeMobileBottomNav');
    if (existing) {
        return;
    }

    const items = [
        { href: 'cashier-dashboard.html', icon: 'bi-speedometer2', label: 'Home' },
        { href: 'cashier-loans-management.html', icon: 'bi-clipboard-data', label: 'Loans' },
        { href: 'cashier-settings.html', icon: 'bi-gear', label: 'Settings' }
    ];

    const currentFile = path.split('/').pop() || '';
    const nav = document.createElement('nav');
    nav.id = 'financeMobileBottomNav';
    nav.className = 'finance-mobile-bottom-nav d-lg-none';
    nav.setAttribute('aria-label', 'Cashier mobile navigation');
    nav.innerHTML = items.map((item) => {
        const isActive = currentFile === item.href;
        return `
            <a class="finance-mobile-bottom-nav__link${isActive ? ' is-active' : ''}" href="${item.href}">
                <i class="bi ${item.icon}" aria-hidden="true"></i>
                <span>${item.label}</span>
            </a>
        `;
    }).join('');
    document.body.appendChild(nav);
}

function initAssessmentMobileBottomNav() {
    const path = getPortalPath() || '';
    if (!path.includes('/views/assessment/') && !path.includes('/views/security/assessment/')) {
        return;
    }
    const body = document.body;
    if (!body) {
        return;
    }

    body.classList.add('assessment-mobile-bottom-nav-enabled');

    const existing = document.getElementById('assessmentMobileBottomNav');
    if (existing) {
        return;
    }

    const items = [
        { href: 'assessment-dashboard.html', icon: 'bi-speedometer2', label: 'Home' },
        { href: 'assessment-loans-management.html', icon: 'bi-clipboard-data', label: 'Loans' },
        { href: 'assessment-balances-management.html', icon: 'bi-wallet2', label: 'Balances' },
        { href: 'assessment-pn-tagging.html', icon: 'bi-journal-check', label: 'PN Tagging' },
        { href: 'assessment-settings.html', icon: 'bi-gear', label: 'Settings' }
    ];

    const currentFile = path.split('/').pop() || '';
    const nav = document.createElement('nav');
    nav.id = 'assessmentMobileBottomNav';
    nav.className = 'assessment-mobile-bottom-nav d-lg-none';
    nav.setAttribute('aria-label', 'Assessment mobile navigation');
    nav.innerHTML = items.map((item) => {
        const isActive = currentFile === item.href;
        return `
            <a class="assessment-mobile-bottom-nav__link${item.href === 'assessment-balances-management.html' ? ' is-balance' : ''}${isActive ? ' is-active' : ''}" href="${item.href}">
                <i class="bi ${item.icon}" aria-hidden="true"></i>
                <span>${item.label}</span>
            </a>
        `;
    }).join('');
    document.body.appendChild(nav);
}

function initCooMobileBottomNav() {
    const path = getPortalPath() || '';
    if (!path.includes('/views/coo/') && !path.includes('/views/security/coo/')) {
        return;
    }
    const body = document.body;
    if (!body) {
        return;
    }

    body.classList.add('coo-mobile-bottom-nav-enabled');

    const existing = document.getElementById('cooMobileBottomNav');
    if (existing) {
        return;
    }

    const items = [
        { href: 'coo-dashboard.html', icon: 'bi-speedometer2', label: 'Home' },
        { href: 'coo-loans-management.html', icon: 'bi-clipboard-data', label: 'Loans' },
        { href: 'coo-settings.html', icon: 'bi-gear', label: 'Settings' }
    ];

    const currentFile = path.split('/').pop() || '';
    const nav = document.createElement('nav');
    nav.id = 'cooMobileBottomNav';
    nav.className = 'coo-mobile-bottom-nav d-lg-none';
    nav.setAttribute('aria-label', 'COO mobile navigation');
    nav.innerHTML = items.map((item) => {
        const isActive = currentFile === item.href;
        return `
            <a class="coo-mobile-bottom-nav__link${isActive ? ' is-active' : ''}" href="${item.href}">
                <i class="bi ${item.icon}" aria-hidden="true"></i>
                <span>${item.label}</span>
            </a>
        `;
    }).join('');
    document.body.appendChild(nav);
}

function initBranchAdminMobileBottomNav() {
    const path = getPortalPath() || '';
    if (!path.includes('/views/branch-admin/') && !path.includes('/views/security/branch-admin/')) {
        return;
    }
    const body = document.body;
    if (!body) {
        return;
    }

    body.classList.add('branch-admin-mobile-bottom-nav-enabled');

    const existing = document.getElementById('branchAdminMobileBottomNav');
    if (existing) {
        return;
    }

    const items = [
        { href: 'branch-admin-dashboard.html', icon: 'bi-speedometer2', label: 'Home' },
        { href: 'branch-admin-loans-mangement.html', icon: 'bi-clipboard-data', label: 'Loans' },
        { href: 'branch-admin-settings.html', icon: 'bi-gear', label: 'Settings' }
    ];

    const currentFile = path.split('/').pop() || '';
    const nav = document.createElement('nav');
    nav.id = 'branchAdminMobileBottomNav';
    nav.className = 'branch-admin-mobile-bottom-nav d-lg-none';
    nav.setAttribute('aria-label', 'Branch admin mobile navigation');
    nav.innerHTML = items.map((item) => {
        const isActive = currentFile === item.href;
        return `
            <a class="branch-admin-mobile-bottom-nav__link${isActive ? ' is-active' : ''}" href="${item.href}">
                <i class="bi ${item.icon}" aria-hidden="true"></i>
                <span>${item.label}</span>
            </a>
        `;
    }).join('');
    document.body.appendChild(nav);
}

function initCsdlMobileBottomNav() {
    const path = getPortalPath() || '';
    const isCsdlView = path.includes('/views/csdl/') || path.includes('/views/security/csdl/');
    const isMasterfilesView = path.includes('/views/masterfiles/') || path.includes('/views/security/masterfiles/');
    if (!isCsdlView && !isMasterfilesView) {
        return;
    }

    const body = document.body;
    if (!body) {
        return;
    }

    body.classList.add('csdl-mobile-bottom-nav-enabled');

    const existing = document.getElementById('csdlMobileBottomNav');
    if (existing) {
        return;
    }

    const base = isMasterfilesView ? '../csdl/' : '';
    const currentFile = path.split('/').pop() || '';
    const items = [
        {
            key: 'dashboard',
            href: `${base}csdl-dashboard.html`,
            icon: 'bi-speedometer2',
            label: 'Home',
            isActive: currentFile.includes('csdl-dashboard')
        },
        {
            key: 'loans',
            href: `${base}csdl-loans-management.html`,
            icon: 'bi-clipboard-data',
            label: 'Loans',
            isActive: currentFile.includes('csdl-loans-management')
        },
        {
            key: 'pntagging',
            href: `${base}csdl-pn-tagging.html`,
            icon: 'bi-journal-check',
            label: 'PN Tagging',
            isActive: currentFile.includes('csdl-pn-tagging')
        },
        {
            key: 'settings',
            href: `${base}csdl-settings.html`,
            icon: 'bi-gear',
            label: 'Settings',
            isActive: currentFile.includes('csdl-settings')
        }
    ];

    const nav = document.createElement('nav');
    nav.id = 'csdlMobileBottomNav';
    nav.style.gridTemplateColumns = 'none';
    nav.style.gridAutoFlow = 'column';
    nav.style.gridAutoColumns = 'minmax(0, 1fr)';
    nav.className = 'csdl-mobile-bottom-nav d-lg-none';
    nav.setAttribute('aria-label', 'CSDL mobile navigation');
    nav.innerHTML = items.map((item) => `
        <a class="csdl-mobile-bottom-nav__link${item.isActive ? ' is-active' : ''}" href="${item.href}" data-csdl-nav="${item.key}">
            <i class="bi ${item.icon}" aria-hidden="true"></i>
            <span>${item.label}</span>
        </a>
    `).join('');

    document.body.appendChild(nav);
}

async function initLayout() {
    let session = null;
    try {
        session = await fetchSession();
    } catch (_) {
        session = null;
    }
    
    try {
        // Only render sidebar/header if they exist AND are empty
        // Many pages have pre-built sidebars (like CSDL dashboard)
        const sidebar = document.getElementById('sidebar');
        const header = document.getElementById('header');
        
        if (sidebar && sidebar.innerHTML.trim() === '') {
            sidebar.innerHTML = renderSidebar(session);
        }
        if (header && header.innerHTML.trim() === '') {
            header.innerHTML = renderHeader(session);
        }

        const doLogout = async () => {
            const confirmResult = await (window.Swal ? Swal.fire({
                title: 'Logout?',
                text: 'You will be signed out of your session. Are you sure you want to continue?.',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, logout',
                cancelButtonText: 'Cancel',
                reverseButtons: true,
                confirmButtonColor: '#03600f'
            }) : Promise.resolve({ isConfirmed: true }));
            if (!confirmResult?.isConfirmed) return;

            if (window.Swal) {
                Swal.fire({
                    title: 'Signing out...',
                    text: 'Please wait while we end your session.',
                    allowOutsideClick: false,
                    allowEscapeKey: false,
                    showConfirmButton: false,
                    didOpen: () => {
                        Swal.showLoading();
                    }
                });
            }

            // Stop all session monitoring to prevent interference during logout
            if (window.sessionChecker) {
                window.sessionChecker.redirected = true;
                window.sessionChecker.destroy();
            }

            let ok = false;
            try {
                const checker = new SessionCheckerModule();
                const base = checker.getBaseURL();
                
                // Get CSRF token, fetch if not available
                let token = document.querySelector('meta[name="csrf-token"]')?.content || '';
                if (!token) {
                    try {
                        const csrfRes = await fetch(base + '/includes/includes-csrf-endpoint.php?action=get_token', { credentials: 'same-origin' });
                        const csrfData = await csrfRes.json();
                        if (csrfData.success) {
                            token = csrfData.token;
                            const metaTag = document.querySelector('meta[name="csrf-token"]');
                            if (metaTag) {
                                metaTag.setAttribute('content', token);
                            } else {
                                const meta = document.createElement('meta');
                                meta.name = 'csrf-token';
                                meta.content = token;
                                document.head.appendChild(meta);
                            }
                        }
                    } catch (_) {}
                }
                
                const res = await fetch(base + '/auth/auth-logout.php', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': token,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    credentials: 'same-origin',
                    cache: 'no-store',
                    body: JSON.stringify({ csrf_token: token })
                });
                ok = res.ok || res.status === 204;

                // Verify server-side session is truly inactive before navigating.
                try {
                    const verifyRes = await fetch(`${base}/auth/auth-check-session.php?peek=1&_=${Date.now()}`, {
                        method: 'GET',
                        credentials: 'same-origin',
                        cache: 'no-store',
                        headers: {
                            'X-Session-Peek': '1',
                            'Cache-Control': 'no-cache, no-store, max-age=0',
                            'Pragma': 'no-cache'
                        }
                    });
                    const verifyData = await verifyRes.json();
                    if (verifyData?.active === true || verifyData?.authenticated === true) {
                        ok = false;
                    }
                } catch (_) {
                    // If verification fails, proceed with best-effort logout redirect below.
                }
            } catch (_) {}

            // Clear session data after logout API call
            try {
                localStorage.removeItem('user_session');
                sessionStorage.clear();
            } catch (_) {}

            if (window.Swal && Swal.isVisible()) Swal.close();
            
            // Use replace instead of href to prevent back button issues
            const loginPath = AppPaths.page('views/auth/login.html');

            const separator = loginPath.includes('?') ? '&' : '?';
            const stamp = `ts=${Date.now()}`;
            if (!ok && window.Swal) {
                await Swal.fire({
                    icon: 'warning',
                    title: 'Logout not confirmed yet',
                    text: 'Your session may still be active. Please try again once.',
                    confirmButtonColor: '#03600f'
                });
            }
            window.location.replace(`${loginPath}${separator}signed_out=1&${stamp}`);
        };

        document.getElementById('btnHeaderLogout')?.addEventListener('click', doLogout);
        document.getElementById('btnSidebarLogout')?.addEventListener('click', doLogout);

        // Also support pages that already have full markup (header/profile/sidebar elements)
        try {
            const name = session?.user?.name || 'User';
            const roleName = session?.user?.role_name || (session?.user?.type === 'student' ? 'Student' : 'Staff');
            const sidebarName = document.getElementById('sidebarProfileName');
            if (sidebarName) {
                sidebarName.textContent = name;
                sidebarName.title = name;
            }
            const sidebarRole = document.getElementById('sidebarProfileRole');
            if (sidebarRole) {
                sidebarRole.textContent = roleName;
                sidebarRole.title = roleName;
            }
            
            // Load profile image based on user type
            if (session?.user?.type === 'employee' && session?.user?.id) {
                try {
                    const checker = new SessionCheckerModule();
                    const base = checker.getBaseURL();
                    const profileRes = await fetch(base + '/csdl/csdl-settings.php?action=get-profile', { credentials: 'same-origin' });
                    if (profileRes.ok) {
                        const profileData = await profileRes.json();
                        if (profileData.success && profileData.employee?.employee_profile_image) {
                            const imagePath = '../../' + profileData.employee.employee_profile_image;
                            
                            // Update header avatar
                            const headerAvatar = document.getElementById('headerUserAvatarImg');
                            if (headerAvatar) {
                                headerAvatar.src = imagePath;
                            }
                            
                            // Update sidebar avatar
                            const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                            if (sidebarAvatar) {
                                sidebarAvatar.src = imagePath;
                            }
                        } else {
                            // Use default avatar if no profile image
                            const headerAvatar = document.getElementById('headerUserAvatarImg');
                            if (headerAvatar && name) {
                                headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=32`;
                            }
                            const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                            if (sidebarAvatar && name) {
                                sidebarAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=64`;
                            }
                        }
                    }
                } catch (e) {
                    // Fallback to default avatar
                    const headerAvatar = document.getElementById('headerUserAvatarImg');
                    if (headerAvatar && name) {
                        headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=32`;
                    }
                    const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                    if (sidebarAvatar && name) {
                        sidebarAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=64`;
                    }
                }
            } else if (session?.user?.type === 'student' && session?.user?.id) {
                try {
                    const checker = new SessionCheckerModule();
                    const base = checker.getBaseURL();
                    const profileRes = await fetch(base + '/students/students-settings.php?action=profile', { credentials: 'same-origin' });
                    if (profileRes.ok) {
                        const profileData = await profileRes.json();
                        if (profileData.success && profileData.profile?.student_profile_image) {
                            const imagePath = '../../' + profileData.profile.student_profile_image;
                            
                            // Update header avatar
                            const headerAvatar = document.getElementById('headerUserAvatarImg');
                            if (headerAvatar) {
                                headerAvatar.src = imagePath;
                            }
                            
                            // Update sidebar avatar
                            const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                            if (sidebarAvatar) {
                                sidebarAvatar.src = imagePath;
                            }
                        } else {
                            // Use default avatar if no profile image
                            const headerAvatar = document.getElementById('headerUserAvatarImg');
                            if (headerAvatar && name) {
                                headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=32`;
                            }
                            const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                            if (sidebarAvatar && name) {
                                sidebarAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=64`;
                            }
                        }
                    }
                } catch (e) {
                    // Fallback to default avatar
                    const headerAvatar = document.getElementById('headerUserAvatarImg');
                    if (headerAvatar && name) {
                        headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=32`;
                    }
                    const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                    if (sidebarAvatar && name) {
                        sidebarAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=64`;
                    }
                }
            } else {
                // For other user types or if no profile image, use default avatar
                const headerAvatar = document.getElementById('headerUserAvatarImg');
                if (headerAvatar && name) {
                    headerAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=32`;
                }
                const sidebarAvatar = document.getElementById('sidebarProfileAvatar');
                if (sidebarAvatar && name) {
                    sidebarAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=03600f&color=fff&size=64`;
                }
            }
            
            const logoutBtn = document.getElementById('logoutBtn');
            if (logoutBtn) logoutBtn.addEventListener('click', (e) => { e.preventDefault(); doLogout(); });

            const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
            if (settingsLogoutBtn) settingsLogoutBtn.addEventListener('click', (e) => { e.preventDefault(); doLogout(); });
        } catch (e) {
            // Failed to update profile UI
        }

        attachSidebarProfileNavigation();

		// Sidebar interactions (desktop collapse + mobile show/hide)
		try {
			const sidebarMenu = document.getElementById('sidebarMenu');
			const mainContent = document.getElementById('mainContent');
			const desktopToggleBtn = document.getElementById('sidebarToggleBtn');
			const mobileToggleBtn = document.querySelector('.navbar-toggler');
			const mobileOverlay = document.getElementById('mobileSidebarOverlay');

			/** Close row action menus (details.action-dd) and mobile filter dropdown so they don’t sit above the drawer */
			const closeFloatingUiOverlays = () => {
				document.querySelectorAll('.action-dd[open]').forEach((dd) => {
					dd.removeAttribute('open');
				});
				try {
					const mobileFilterBtn = document.getElementById('mobileFilterBtn');
					if (mobileFilterBtn && typeof window.bootstrap !== 'undefined' && window.bootstrap.Dropdown) {
						const inst = window.bootstrap.Dropdown.getInstance(mobileFilterBtn);
						if (inst) inst.hide();
					}
				} catch (_) { /* noop */ }
			};

			const syncSidebarProfileVisibility = () => {
				const isCollapsed = sidebarMenu?.classList.contains('collapsed');
				const textNodes = document.querySelectorAll('#sidebarMenu .sidebar-profile-text, .sidebar-profile-text');
				textNodes.forEach(node => { node.style.display = isCollapsed ? 'none' : ''; });
				const avatarNodes = document.querySelectorAll('#sidebarMenu .sidebar-profile-avatar, .sidebar-profile-avatar');
				avatarNodes.forEach(node => {
					node.style.width = isCollapsed ? '32px' : '40px';
					node.style.height = isCollapsed ? '32px' : '40px';
				});
			};

			// Desktop collapse/expand
			desktopToggleBtn?.addEventListener('click', () => {
				if (!sidebarMenu) return;
				sidebarMenu.classList.toggle('collapsed');
				const isCollapsed = sidebarMenu.classList.contains('collapsed');
				if (isCollapsed) {
					mainContent?.classList.add('expanded');
				} else {
					mainContent?.classList.remove('expanded');
				}
				syncSidebarProfileVisibility();
			});

			// Mobile open (toggler uses stopPropagation — document "click outside" won’t run; close overlays here)
			mobileToggleBtn?.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (!sidebarMenu) return;
				closeFloatingUiOverlays();
				// Prevent body scroll when sidebar is open
				document.body.classList.add('sidebar-open');
				sidebarMenu.classList.add('show');
				if (mobileOverlay) mobileOverlay.classList.add('show');
			});
			
			// Mobile close button in sidebar
			const mobileCloseBtn = document.getElementById('mobileSidebarCloseBtn');
			mobileCloseBtn?.addEventListener('click', () => {
				closeFloatingUiOverlays();
				if (sidebarMenu) sidebarMenu.classList.remove('show');
				if (mobileOverlay) mobileOverlay.classList.remove('show');
				document.body.classList.remove('sidebar-open');
			});

			// Mobile close via overlay
			mobileOverlay?.addEventListener('click', () => {
				closeFloatingUiOverlays();
				if (sidebarMenu) sidebarMenu.classList.remove('show');
				if (mobileOverlay) mobileOverlay.classList.remove('show');
				document.body.classList.remove('sidebar-open');
			});
			
			// Close sidebar when clicking on a nav link (mobile) - use event delegation
			// But exclude dropdown toggles (like Masterfiles) - only close on actual navigation
			sidebarMenu?.addEventListener('click', (e) => {
				if (window.innerWidth < 992) {
					const navLink = e.target.closest('.nav-link');
					if (navLink) {
						// Check if it's a collapse/dropdown toggle (like Masterfiles parent)
						const isToggle = navLink.hasAttribute('data-bs-toggle') && 
						                 navLink.getAttribute('data-bs-toggle') === 'collapse';
						
						// Only close if it's a real navigation link (not a toggle, has valid href)
						if (!isToggle) {
							const href = navLink.getAttribute('href');
							if (href && href !== '#' && !href.startsWith('#')) {
								setTimeout(() => {
									closeFloatingUiOverlays();
									if (sidebarMenu) sidebarMenu.classList.remove('show');
									if (mobileOverlay) mobileOverlay.classList.remove('show');
									document.body.classList.remove('sidebar-open');
								}, 100);
							}
						}
					}
				}
			});

			// Close on ESC in mobile
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && window.innerWidth < 992) {
					closeFloatingUiOverlays();
					if (sidebarMenu) sidebarMenu.classList.remove('show');
					if (mobileOverlay) mobileOverlay.classList.remove('show');
					document.body.classList.remove('sidebar-open');
				}
			});

			// On resize, ensure mobile state is reset on desktop widths
			window.addEventListener('resize', () => {
				if (window.innerWidth >= 992) {
					closeFloatingUiOverlays();
					if (sidebarMenu) sidebarMenu.classList.remove('show');
					if (mobileOverlay) mobileOverlay.classList.remove('show');
					document.body.classList.remove('sidebar-open');
				}
			});

			// Initial sync for loaded state
			syncSidebarProfileVisibility();
		} catch (_) {}
    } catch (_) {}
    
    // Initialize RBAC after DOM elements are ready
    try {
        await rbacUtil.init();
        rbacUtil.applySidebarPermissions();
        
        // Detect current module and apply action permissions
        const currentPath = getPortalPath();
        let module = null;
        
        if (currentPath.includes('/csdl/')) {
            module = 'csdl';
        } else if (currentPath.includes('/finance/')) {
            module = 'finance';
        } else if (currentPath.includes('/branch-admin/')) {
            module = 'branch_admin';
        } else if (currentPath.includes('/coo/')) {
            module = 'coo';
        } else if (currentPath.includes('/assessment/')) {
            module = 'assessment';
        }
        
        if (module) {
            rbacUtil.applyActionPermissions(module);
        }
    } catch (e) {
        // RBAC initialization failed
    }
}

// Load and apply system settings (system name, school name, logo)
async function loadSystemSettings() {
    try {
        const checker = new SessionCheckerModule();
        const base = checker.getBaseURL();
        
        // Fetch branding settings from shared authenticated endpoint
        const response = await fetch(base + '/auth/auth-branding.php', {
            credentials: 'same-origin'
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        if (!data.success || !data.settings) return;
        
        const systemName = data.settings.system_name?.value || 'Student Financial Assistance';
        const schoolName = data.settings.school_name?.value || '';
        const systemLogo = data.settings.system_logo?.value || null;
        
        // Update all navbar brand text elements
        document.querySelectorAll('.navbar-brand span').forEach(el => {
            el.textContent = systemName;
        });
        
        // Update sidebar mobile header
        document.querySelectorAll('.sidebar-header-mobile .fw-bold').forEach(el => {
            el.textContent = systemName;
        });
        
        // Update logo images if custom logo is set
        if (systemLogo) {
            document.querySelectorAll('.navbar-brand img, .sidebar-header-mobile img').forEach(img => {
                img.src = '../../' + systemLogo;
                img.alt = systemName + ' Logo';
            });
        }
        
        // Update page title if it contains the system name
        if (document.title.includes('CSDL') || document.title.includes('Student')) {
            const titleParts = document.title.split(' - ');
            if (titleParts.length > 1) {
                document.title = titleParts[0] + ' - ' + systemName;
            }
        }
        
        // Store in sessionStorage for quick access
        sessionStorage.setItem('systemName', systemName);
        sessionStorage.setItem('schoolName', schoolName);
        if (systemLogo) {
            sessionStorage.setItem('systemLogo', systemLogo);
        }
        
    } catch (error) {
        // Failed to load system settings
    }
}

function installRenamedApiRouteAliases() {
    const path = getPortalPath() || '';
    const oldFetch = window.fetch?.bind(window);
    if (!oldFetch || window.__renamedApiRoutesInstalled) return;

    const replacement = path.includes('/views/assessment/') || path.includes('/views/security/assessment/')
        ? ['/api/finance/finance-', '/api/assessment/assessment-']
        : (path.includes('/views/cashier/') || path.includes('/views/security/cashier/')
            ? ['/api/assessment/assessment-', '/api/cashier/cashier-']
            : null);
    if (!replacement) return;

    window.__renamedApiRoutesInstalled = true;
    window.fetch = (input, init) => {
        if (typeof input === 'string') {
            return oldFetch(input.replace(replacement[0], replacement[1]), init);
        }
        return oldFetch(input, init);
    };
}

function normalizeSwappedPortalLinks() {
    const path = getPortalPath() || '';
    const isCashierPortal = path.includes('/views/cashier/') || path.includes('/views/security/cashier/');
    const isAssessmentPortal = path.includes('/views/assessment/') || path.includes('/views/security/assessment/');
    if (!isCashierPortal && !isAssessmentPortal) return;

    const fromPrefix = isCashierPortal ? 'assessment-' : 'cashier-';
    const toPrefix = isCashierPortal ? 'cashier-' : 'assessment-';
    document.querySelectorAll('a[href]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (href.startsWith(fromPrefix)) {
            link.setAttribute('href', `${toPrefix}${href.slice(fromPrefix.length)}`);
        }
    });
}

function initPortalPageHeadDate() {
    const dateText = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    document.querySelectorAll('.coo-page-head-date-text, .finance-page-head-date-text, .assessment-page-head-date-text, .branch-page-head-date-text, .student-page-head-date-text, .csdl-page-head-date-text').forEach((el) => {
        el.textContent = dateText;
    });
}

function installDateCalendars() {
    const dateInputs = document.querySelectorAll('input[type="date"]');
    if (!dateInputs.length && !document.getElementById('examSchedulesTableBody')) return;

    const enhanced = new WeakSet();
    const triggers = new WeakMap();
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!nativeValue?.get || !nativeValue?.set) return;
    const popup = document.createElement('div');
    popup.className = 'sfas-date-calendar';
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Choose a date');
    popup.innerHTML = `
        <div class="sfas-date-calendar__toolbar">
            <button type="button" class="sfas-date-calendar__nav" data-direction="-1" aria-label="Previous month"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
            <select class="form-select" aria-label="Month"></select>
            <select class="form-select" aria-label="Year"></select>
            <button type="button" class="sfas-date-calendar__nav" data-direction="1" aria-label="Next month"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
        </div>
        <div class="sfas-date-calendar__weekdays" aria-hidden="true"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
        <div class="sfas-date-calendar__days" role="group" aria-label="Days of the month"></div>
        <div class="sfas-date-calendar__footer"><button type="button" class="sfas-date-calendar__clear">Clear date</button></div>`;
    document.body.appendChild(popup);

    const monthSelect = popup.querySelectorAll('select')[0];
    const yearSelect = popup.querySelectorAll('select')[1];
    const days = popup.querySelector('.sfas-date-calendar__days');
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    monthNames.forEach((name, index) => monthSelect.add(new Option(name, String(index + 1))));

    let activeInput = null;
    let viewYear = 0;
    let viewMonth = 0;
    const isoDate = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const todayIso = () => {
        const now = new Date();
        return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
    };
    const isBirthDate = (input) => /birth|date_of_birth/i.test(input.id);
    const labelFor = (input) => input.labels?.[0]?.textContent?.trim()
        || input.getAttribute('aria-label')
        || input.title
        || (input.classList.contains('exam-schedule-start') ? 'Start date' : '')
        || (input.classList.contains('exam-schedule-end') ? 'End date' : '')
        || 'date';
    const limits = (input) => {
        const minimum = /^\d{4}-\d{2}-\d{2}$/.test(input.min) ? input.min : '1900-01-01';
        const maximum = /^\d{4}-\d{2}-\d{2}$/.test(input.max)
            ? input.max : (isBirthDate(input) ? todayIso() : '2100-12-31');
        return { minimum, maximum };
    };
    const display = (input) => {
        const trigger = triggers.get(input);
        if (!trigger) return;
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value);
        trigger.querySelector('span').textContent = match
            ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
            : 'Select date';
        trigger.classList.toggle('has-value', Boolean(match));
        trigger.classList.toggle('is-invalid', input.classList.contains('is-invalid'));
        trigger.disabled = input.disabled;
        if (input.disabled && activeInput === input) close();
    };
    const close = (restoreFocus = false) => {
        if (!activeInput) return;
        const trigger = triggers.get(activeInput);
        popup.hidden = true;
        trigger?.setAttribute('aria-expanded', 'false');
        activeInput = null;
        if (restoreFocus) trigger?.focus();
    };
    const position = () => {
        if (!activeInput || popup.hidden) return;
        const trigger = triggers.get(activeInput);
        if (!trigger?.isConnected) { close(); return; }
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(320, window.innerWidth - 16);
        popup.style.width = `${width}px`;
        const height = popup.offsetHeight;
        const top = rect.bottom + 6 + height <= window.innerHeight - 8
            ? rect.bottom + 6
            : (rect.top - height - 6 >= 8 ? rect.top - height - 6 : Math.max(8, window.innerHeight - height - 8));
        popup.style.top = `${top}px`;
        popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    };
    const render = () => {
        if (!activeInput) return;
        const { minimum, maximum } = limits(activeInput);
        const minimumYear = Number(minimum.slice(0, 4));
        const maximumYear = Number(maximum.slice(0, 4));
        viewYear = Math.max(minimumYear, Math.min(maximumYear, viewYear));
        if (isoDate(viewYear, viewMonth, 1).slice(0, 7) < minimum.slice(0, 7)) viewMonth = Number(minimum.slice(5, 7));
        if (isoDate(viewYear, viewMonth, 1).slice(0, 7) > maximum.slice(0, 7)) viewMonth = Number(maximum.slice(5, 7));

        const years = document.createDocumentFragment();
        for (let year = maximumYear; year >= minimumYear; year--) years.appendChild(new Option(String(year), String(year)));
        yearSelect.replaceChildren(years);
        yearSelect.value = String(viewYear);
        for (const option of monthSelect.options) {
            const period = isoDate(viewYear, Number(option.value), 1).slice(0, 7);
            option.disabled = period < minimum.slice(0, 7) || period > maximum.slice(0, 7);
        }
        monthSelect.value = String(viewMonth);

        const fragment = document.createDocumentFragment();
        const leading = new Date(viewYear, viewMonth - 1, 1).getDay();
        for (let index = 0; index < leading; index++) fragment.appendChild(document.createElement('span'));
        const count = new Date(viewYear, viewMonth, 0).getDate();
        for (let day = 1; day <= count; day++) {
            const iso = isoDate(viewYear, viewMonth, day);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sfas-date-calendar__day';
            button.textContent = String(day);
            button.setAttribute('aria-label', new Date(viewYear, viewMonth - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
            button.disabled = iso < minimum || iso > maximum;
            if (iso === activeInput.value) button.classList.add('is-selected');
            button.addEventListener('click', () => {
                const input = activeInput;
                input.value = iso;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                close(true);
            });
            fragment.appendChild(button);
        }
        days.replaceChildren(fragment);
        popup.querySelector('[data-direction="-1"]').disabled = isoDate(viewYear, viewMonth, 1).slice(0, 7) <= minimum.slice(0, 7);
        popup.querySelector('[data-direction="1"]').disabled = isoDate(viewYear, viewMonth, 1).slice(0, 7) >= maximum.slice(0, 7);
        position();
    };
    const open = (input) => {
        if (activeInput === input) { close(); return; }
        close();
        activeInput = input;
        const today = new Date();
        const fallbackYear = isBirthDate(input) ? today.getFullYear() - 20 : today.getFullYear();
        const fallback = isoDate(fallbackYear, today.getMonth() + 1, 1);
        const { minimum, maximum } = limits(input);
        const selected = input.value || (fallback < minimum ? minimum : (fallback > maximum ? maximum : fallback));
        viewYear = Number(selected.slice(0, 4));
        viewMonth = Number(selected.slice(5, 7));
        popup.setAttribute('aria-label', `Choose ${labelFor(input)}`);
        popup.hidden = false;
        triggers.get(input)?.setAttribute('aria-expanded', 'true');
        render();
    };

    for (const button of popup.querySelectorAll('[data-direction]')) {
        button.addEventListener('click', () => {
            const next = new Date(viewYear, viewMonth - 1 + Number(button.dataset.direction), 1);
            viewYear = next.getFullYear();
            viewMonth = next.getMonth() + 1;
            render();
        });
    }
    monthSelect.addEventListener('change', () => { viewMonth = Number(monthSelect.value); render(); });
    yearSelect.addEventListener('change', () => { viewYear = Number(yearSelect.value); render(); });
    popup.querySelector('.sfas-date-calendar__clear').addEventListener('click', () => {
        const input = activeInput;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close(true);
    });
    document.addEventListener('pointerdown', (event) => {
        if (activeInput && !popup.contains(event.target) && !triggers.get(activeInput)?.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (activeInput && event.key === 'Escape') { event.preventDefault(); close(true); }
    });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);

    const enhance = (input) => {
        if (enhanced.has(input)) return;
        enhanced.add(input);
        const host = document.createElement('span');
        host.className = 'sfas-date-field';
        input.before(host);
        host.appendChild(input);
        input.classList.add('sfas-date-native');
        input.tabIndex = -1;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = `form-control sfas-date-trigger${input.classList.contains('form-control-sm') ? ' form-control-sm' : ''}`;
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', `Choose ${labelFor(input)}`);
        trigger.innerHTML = '<span>Select date</span><i class="bi bi-calendar3" aria-hidden="true"></i>';
        host.appendChild(trigger);
        triggers.set(input, trigger);
        trigger.addEventListener('click', () => open(input));
        Object.defineProperty(input, 'value', {
            configurable: true,
            get() { return nativeValue.get.call(this); },
            set(value) { nativeValue.set.call(this, value); display(this); }
        });
        input.addEventListener('input', () => display(input));
        input.addEventListener('change', () => display(input));
        input.addEventListener('focus', () => trigger.focus());
        input.addEventListener('invalid', (event) => {
            event.preventDefault();
            trigger.classList.add('is-invalid');
            trigger.focus();
        });
        input.form?.addEventListener('reset', () => setTimeout(() => display(input), 0));
        new MutationObserver(() => display(input)).observe(input, {
            attributes: true, attributeFilter: ['disabled', 'min', 'max', 'class', 'value']
        });
        display(input);
    };
    document.querySelectorAll('input[type="date"]').forEach(enhance);
    new MutationObserver((changes) => {
        if (activeInput && !activeInput.isConnected) close();
        for (const change of changes) {
            for (const node of change.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches('input[type="date"]')) enhance(node);
                node.querySelectorAll('input[type="date"]').forEach(enhance);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}

document.addEventListener('DOMContentLoaded', () => {
    installRenamedApiRouteAliases();
    normalizeSwappedPortalLinks();
    installCleanNavigationLinks();
    normalizeCsdlSidebar();
    initLayout();
    initStudentMobileBottomNav();
    initFinanceMobileBottomNav();
    initAssessmentMobileBottomNav();
    initCooMobileBottomNav();
    initBranchAdminMobileBottomNav();
    initCsdlMobileBottomNav();
    initPortalPageHeadDate();
    installDateCalendars();
    loadSystemSettings();
});

export { initLayout, loadSystemSettings };
