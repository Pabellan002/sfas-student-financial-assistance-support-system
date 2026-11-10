import StudentsSettingsModule from '../modules/students/students-settingsModule.js?v=20261007-student-pagination';
import StudentsNotificationsModule from '../modules/students/students-notificationsModule.js';
import { initSettingsExtras } from '../shared/shared-settings-extras.js';

function configureSettingsPageView() {
    const labels = {
        profile: 'Profile & contact',
        password: 'Change password',
        activity: 'Activity log',
        faq: 'FAQs'
    };
    const section = new URLSearchParams(window.location.search).get('section');
    const menu = document.getElementById('studentSettingsMenu');
    if (!Object.prototype.hasOwnProperty.call(labels, section)) {
        if (menu) menu.hidden = false;
        return null;
    }
    const back = document.getElementById('studentSettingsBack');
    const accordion = document.getElementById('studentSettingsAccordion');
    menu?.classList.add('d-none');
    back?.classList.remove('d-none');
    accordion?.classList.remove('d-none');
    accordion?.classList.add('settings-page-focus');
    document.getElementById('pageTitle').textContent = labels[section];
    document.querySelector('.portal-settings-logout-panel')?.classList.add('d-none');

    document.querySelectorAll('[data-settings-section]').forEach((item) => {
        const selected = item.dataset.settingsSection === section;
        item.classList.toggle('d-none', !selected);
        if (!selected) return;

        item.querySelector('.accordion-collapse')?.classList.add('show');
        item.querySelector('.accordion-button')?.classList.remove('collapsed');
    });

    return section;
}

document.addEventListener('DOMContentLoaded', async () => {
    const activeSection = configureSettingsPageView();
    initSettingsExtras('student');
    const module = new StudentsSettingsModule();
    await module.init();

    if (activeSection === 'activity') {
        document.getElementById('settingsCollapseActivity')?.dispatchEvent(new Event('shown.bs.collapse'));
    }
    
    // Initialize real-time notifications
    const notificationsModule = new StudentsNotificationsModule();
    notificationsModule.init();
    window.studentsNotificationsModule = notificationsModule;
});
