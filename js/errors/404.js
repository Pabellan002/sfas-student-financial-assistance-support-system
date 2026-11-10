(() => {
    'use strict';

    const homeUrl = new URL('../../', document.currentScript.src).pathname;
    const homeLink = document.querySelector('.btn-pill');
    const goBackLink = document.getElementById('go-back');

    homeLink.href = homeUrl;

    goBackLink.addEventListener('click', (event) => {
        event.preventDefault();
        try {
            const previous = new URL(document.referrer);
            if (history.length > 1 && previous.href !== location.href &&
                !(previous.origin === location.origin && previous.pathname.endsWith('/views/errors/404.html'))) {
                history.back();
                return;
            }
        } catch (_) {}
        location.assign(homeUrl);
    });
})();
