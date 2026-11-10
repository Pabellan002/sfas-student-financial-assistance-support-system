import { STUDENT_PORTAL_FAQS, STAFF_PORTAL_FAQS, renderFaqContent } from './shared-portal-faqs.js';

export function initSettingsExtras(audience = 'staff') {
    const faqContainer = document.getElementById('settingsFaqContent');
    if (faqContainer) {
        const faqs = audience === 'student' ? STUDENT_PORTAL_FAQS : STAFF_PORTAL_FAQS;
        renderFaqContent(faqContainer, faqs);
    }
}
