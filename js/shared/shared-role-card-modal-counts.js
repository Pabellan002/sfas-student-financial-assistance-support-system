(() => {
    const selector = '.cashier-card-modal, .coo-card-modal, .branch-card-modal';
    const isRecord = (row) => {
        const text = row.textContent.trim().toLowerCase();
        return row.querySelectorAll('td').length > 0
            && !row.querySelector('td[colspan]')
            && !/(loading|no data|no .*found|no records)/.test(text);
    };
    const setup = (modal) => {
        const footer = modal.querySelector('.modal-footer');
        if (!footer || footer.querySelector('[id$="Pagination"]')) return;
        let output = footer.querySelector('[data-card-modal-count]');
        if (!output) {
            output = document.createElement('span');
            output.dataset.cardModalCount = '';
            output.textContent = 'No records';
            footer.prepend(output);
        }
        const update = () => {
            const records = [...modal.querySelectorAll('tbody tr')].filter(isRecord).length;
            output.textContent = records === 0 ? 'No records' : records === 1 ? 'Showing 1 of 1 record' : `Showing ${records} of ${records} records`;
        };
        modal.addEventListener('shown.bs.modal', () => requestAnimationFrame(update));
        const observer = new MutationObserver(update);
        modal.querySelectorAll('tbody').forEach((body) => observer.observe(body, { childList: true, subtree: true, characterData: true }));
        update();
    };
    document.addEventListener('DOMContentLoaded', () => document.querySelectorAll(selector).forEach(setup));
})();
