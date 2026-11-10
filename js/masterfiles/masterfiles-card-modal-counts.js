document.addEventListener('shown.bs.modal', (event) => {
    const modal = event.target;
    if (!modal.classList.contains('masterfile-card-modal')) return;

    const output = modal.querySelector('[data-card-modal-count]');
    const rows = [...modal.querySelectorAll('tbody tr')];
    if (!output) return;

    const records = rows.filter((row) => !row.querySelector('td[colspan]')).length;
    output.textContent = records === 0
        ? 'No records'
        : records === 1
            ? 'Showing 1 record'
            : `Showing all ${records} records`;
});
