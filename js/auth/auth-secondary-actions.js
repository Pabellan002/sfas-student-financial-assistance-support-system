// Arrange secondary account actions (Forgot Password & Register links)
// This script groups the links together in a responsive container
(() => {
    const arrangeSecondaryActions = () => {
        const links = Array.from(document.querySelectorAll('a'));
        const normalizedText = (element) =>
            element.textContent.replace(/\s+/g, ' ').trim().toLowerCase();

        const forgotLink = links.find((link) =>
            normalizedText(link).includes('forgot password')
        );
        const registerLink = links.find((link) =>
            normalizedText(link) === 'register'
        );

        if (!forgotLink || !registerLink || forgotLink.closest('.auth-secondary-actions')) {
            return;
        }

        const originalParents = new Set([
            forgotLink.parentElement,
            registerLink.parentElement
        ]);
        const actions = document.createElement('div');
        actions.className = 'auth-secondary-actions';
        actions.setAttribute('aria-label', 'Account access options');

        forgotLink.parentNode.insertBefore(actions, forgotLink);
        forgotLink.classList.add('auth-secondary-action', 'auth-secondary-action--forgot');
        registerLink.classList.add('auth-secondary-action', 'auth-secondary-action--register');
        actions.append(forgotLink, registerLink);

        originalParents.forEach((parent) => {
            if (
                parent &&
                parent !== actions &&
                parent !== actions.parentElement &&
                parent.children.length === 0 &&
                parent.textContent.trim() === ''
            ) {
                parent.remove();
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arrangeSecondaryActions);
    } else {
        arrangeSecondaryActions();
    }
})();
