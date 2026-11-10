export const PORTAL_NOTIFICATIONS_PAGE_SIZE = 20;

export function isPortalNotificationsPage(slug) {
    return window.location.pathname.includes(slug);
}

export async function initPortalNotificationsPage({
    fetchPage,
    bindItem,
    getEmptyHtml,
    pageSize = PORTAL_NOTIFICATIONS_PAGE_SIZE,
    onAfterLoad,
}) {
    const listEl = document.getElementById('notificationsPageList');
    if (!listEl) return { pagePagination: { page: 1, perPage: pageSize, total: 0, totalPages: 1 } };

    let pagePagination = { page: 1, perPage: pageSize, total: 0, totalPages: 1 };

    const updateFooter = () => {
        const summaryEl = document.getElementById('notificationsPageSummary');
        const loadMoreBtn = document.getElementById('notificationsPageLoadMore');
        const markAllBtn = document.getElementById('notificationsPageMarkAllBtn');

        if (summaryEl) {
            const { total, page, totalPages } = pagePagination;
            summaryEl.textContent = total > 0 ? `Showing page ${page} of ${totalPages} · ${total} total` : '';
        }

        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('d-none', pagePagination.page >= pagePagination.totalPages);
            loadMoreBtn.disabled = false;
        }

        if (markAllBtn) {
            markAllBtn.disabled = false;
        }
    };

    const loadPage = async (page = 1, append = false) => {
        if (!append) {
            listEl.innerHTML = `
                <div class="notifications-page-loading text-center py-5">
                    <div class="spinner-border text-secondary" role="status"><span class="visually-hidden">Loading…</span></div>
                    <p class="mt-3 text-muted small mb-0">Loading notifications…</p>
                </div>`;
        }

        const response = await fetchPage(page, pageSize);
        if (!response?.success) {
            listEl.innerHTML = '<div class="notification-empty">Unable to load notifications.</div>';
            return response;
        }

        const items = response.notifications || [];
        pagePagination = response.pagination || pagePagination;

        if (items.length === 0 && page === 1) {
            listEl.innerHTML = getEmptyHtml();
            updateFooter();
            if (typeof onAfterLoad === 'function') {
                onAfterLoad(response);
            }
            return response;
        }

        const html = items.map((item) => bindItem.render(item)).join('');
        if (append) {
            listEl.insertAdjacentHTML('beforeend', html);
        } else {
            listEl.innerHTML = html;
        }

        bindItem.attach(listEl);
        updateFooter();
        if (typeof onAfterLoad === 'function') {
            onAfterLoad(response);
        }
        return response;
    };

    const markAllBtn = document.getElementById('notificationsPageMarkAllBtn');
    if (markAllBtn && bindItem.onMarkAll) {
        markAllBtn.addEventListener('click', async () => {
            markAllBtn.disabled = true;
            await bindItem.onMarkAll();
            await loadPage(1, false);
        });
    }

    const loadMoreBtn = document.getElementById('notificationsPageLoadMore');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', async () => {
            const nextPage = pagePagination.page + 1;
            if (nextPage > pagePagination.totalPages) return;
            loadMoreBtn.disabled = true;
            await loadPage(nextPage, true);
        });
    }

    await loadPage(1, false);
    return { loadPage, pagePagination };
}
