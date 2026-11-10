/**
 * Row action menus use <details> + a panel inside overflow-x:auto tables. Browsers treat
 * that as a scroll container and clip absolutely positioned children, which forces an
 * inner vertical scrollbar. Pin open menus to the viewport (position:fixed) instead.
 *
 * Do not listen for scroll on table/.table-responsive — wheel/trackpad scrolling fires
 * scroll there and would close the menu before the user can click Delete (etc.).
 */
let bound = false;
let windowScrollBound = false;

function clearFixedMenu(menu) {
    if (!menu) return;
    menu.style.position = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.left = '';
    menu.style.bottom = '';
    menu.style.zIndex = '';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
}

function detachWindowScrollClose() {
    if (windowScrollBound) {
        window.removeEventListener('scroll', closeOpenActionMenus);
        windowScrollBound = false;
    }
}

function closeOpenActionMenus() {
    document.querySelectorAll('details.action-dd[open]').forEach((dd) => {
        clearFixedMenu(dd.querySelector(':scope > .action-dd-menu'));
        dd.removeAttribute('open');
    });
    detachWindowScrollClose();
}

function attachWindowScrollClose() {
    detachWindowScrollClose();
    window.addEventListener('scroll', closeOpenActionMenus, { passive: true });
    windowScrollBound = true;
}

function positionFixedMenu(details) {
    const summary = details.querySelector(':scope > summary');
    const menu = details.querySelector(':scope > .action-dd-menu');
    if (!summary || !menu) return;

    const rect = summary.getBoundingClientRect();
    const gap = 6;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    menu.style.position = 'fixed';
    menu.style.zIndex = '10050';
    menu.style.left = 'auto';
    menu.style.right = `${Math.max(0, vw - rect.right)}px`;
    menu.style.bottom = 'auto';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';

    const topBelow = rect.bottom + gap;
    const spaceBelow = vh - topBelow - pad;
    const spaceAbove = rect.top - pad - gap;
    const naturalH = menu.offsetHeight;

    if (naturalH <= spaceBelow) {
        menu.style.top = `${topBelow}px`;
    } else if (naturalH <= spaceAbove) {
        menu.style.top = `${rect.top - gap - naturalH}px`;
    } else if (spaceBelow >= spaceAbove) {
        menu.style.top = `${topBelow}px`;
        menu.style.maxHeight = `${Math.max(120, spaceBelow)}px`;
        menu.style.overflowY = 'auto';
    } else {
        const h = Math.max(120, spaceAbove);
        menu.style.top = `${Math.max(pad, rect.top - gap - h)}px`;
        menu.style.maxHeight = `${h}px`;
        menu.style.overflowY = 'auto';
    }

    const mw = menu.offsetWidth;
    const rightPx = parseFloat(menu.style.right) || 0;
    const leftEdge = vw - rightPx - mw;
    if (leftEdge < pad) {
        menu.style.right = 'auto';
        menu.style.left = `${pad}px`;
    }
}

export function initMasterfilesActionDdViewport() {
    if (bound) return;
    bound = true;

    document.addEventListener(
        'toggle',
        (e) => {
            const t = e.target;
            if (!(t instanceof HTMLDetailsElement) || !t.classList.contains('action-dd')) return;

            const menu = t.querySelector(':scope > .action-dd-menu');
            if (!menu) return;

            if (t.open) {
                document.querySelectorAll('details.action-dd[open]').forEach((other) => {
                    if (other !== t) {
                        clearFixedMenu(other.querySelector(':scope > .action-dd-menu'));
                        other.removeAttribute('open');
                    }
                });
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        positionFixedMenu(t);
                        attachWindowScrollClose();
                    });
                });
            } else {
                clearFixedMenu(menu);
                detachWindowScrollClose();
            }
        },
        true
    );

    window.addEventListener('resize', closeOpenActionMenus);
}
