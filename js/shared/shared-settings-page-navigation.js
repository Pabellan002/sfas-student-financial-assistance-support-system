function sectionKey(label) {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function makeSectionLabel(text, isGridItem = false) {
    const label = document.createElement('div');
    label.className = (isGridItem ? 'col-12 ' : '') + 'settings-contact-section-label';
    label.textContent = text;
    return label;
}

function enhanceContactForm(entry) {
    if (entry.key !== 'contact-information') return;

    const form = entry.item.querySelector('form');
    const image = form?.querySelector('#profileImagePreview');
    if (!form || !image) return;

    form.classList.add('settings-contact-form');
    const photoBlock = image.closest('.mb-4, .col-12');
    if (photoBlock) {
        photoBlock.classList.add('settings-contact-profile-hero');
    }

    const fieldsRow = photoBlock?.parentElement?.classList.contains('row')
        ? photoBlock.parentElement
        : form.querySelector('.row');
    const personalAnchor = photoBlock || fieldsRow?.firstElementChild;
    if (personalAnchor && !form.querySelector('.settings-contact-section-label--personal')) {
        const personalLabel = makeSectionLabel('Personal details', fieldsRow === personalAnchor.parentElement);
        personalLabel.classList.add('settings-contact-section-label--personal');
        personalAnchor.insertAdjacentElement('afterend', personalLabel);
    }

    const contactLabel = [...form.querySelectorAll('label')].find((label) =>
        label.textContent.trim().toLowerCase().startsWith('contact number')
    );
    const contactField = contactLabel?.closest('.col-12, .col-md-6, .col-md-6.col-12');
    if (contactField && !form.querySelector('.settings-contact-section-label--contact')) {
        const label = makeSectionLabel('Contact details', contactField.parentElement?.classList.contains('row'));
        label.classList.add('settings-contact-section-label--contact');
        contactField.insertAdjacentElement('beforebegin', label);
    }
}

/**
 * Turns an existing settings accordion into a Settings home list and
 * focused section pages using the ?section= query parameter.
 */
export function initSettingsPageNavigation(accordionId) {
    const accordion = document.getElementById(accordionId);
    if (!accordion) return null;

    const items = [...accordion.querySelectorAll(':scope > .accordion-item')].map((item) => {
        const button = item.querySelector('.accordion-button');
        const collapse = item.querySelector('.accordion-collapse');
        const label = button?.textContent.trim() || 'Settings';
        return {
            item,
            button,
            collapse,
            label,
            key: sectionKey(label),
            iconClass: button?.querySelector('i')?.className || 'bi bi-gear'
        };
    }).filter((entry) => entry.key && entry.collapse);

    if (!items.length) return null;

    const cardBody = accordion.parentElement;
    const activeKey = new URLSearchParams(window.location.search).get('section');
    const active = items.find((entry) => entry.key === activeKey);
    const menu = document.createElement('div');
    menu.className = 'settings-page-menu row g-3';

    items.forEach((entry) => {
        const column = document.createElement('div');
        column.className = 'col-12';

        const link = document.createElement('a');
        link.className = 'settings-page-menu__item';
        link.href = window.location.pathname + '?section=' + encodeURIComponent(entry.key);

        const icon = document.createElement('span');
        icon.className = 'settings-page-menu__icon';
        const iconElement = document.createElement('i');
        iconElement.className = entry.iconClass;
        icon.append(iconElement);

        const copy = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = entry.label;
        const description = document.createElement('small');
        description.textContent = 'Open ' + entry.label.toLowerCase() + '.';
        copy.append(title, description);

        const arrow = document.createElement('i');
        arrow.className = 'bi bi-chevron-right settings-page-menu__arrow';
        link.append(icon, copy, arrow);
        column.append(link);
        menu.append(column);
    });

    const back = document.createElement('div');
    back.className = 'settings-page-back';
    const backLink = document.createElement('a');
    backLink.href = window.location.pathname;
    backLink.innerHTML = '<i class="bi bi-arrow-left me-1"></i>Back';
    back.append(backLink);
    cardBody.insertBefore(menu, accordion);
    cardBody.insertBefore(back, accordion);

    if (!active) {
        back.classList.add('d-none');
        accordion.classList.add('d-none');
        accordion.hidden = false;
        return null;
    }

    menu.classList.add('d-none');
    accordion.classList.remove('d-none');
    accordion.classList.add('settings-page-focus');
    document.querySelector('.portal-settings-logout-panel')?.classList.add('d-none');

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = active.label;

    items.forEach((entry) => {
        const selected = entry === active;
        entry.item.classList.toggle('d-none', !selected);
        if (!selected) return;

        entry.collapse.classList.add('show');
        entry.button?.classList.remove('collapsed');
        entry.button?.setAttribute('aria-expanded', 'true');
        enhanceContactForm(entry);
    });

    accordion.hidden = false;
    return active.collapse;
}

export function announceSettingsPageShown(collapse) {
    collapse?.dispatchEvent(new Event('shown.bs.collapse'));
}
