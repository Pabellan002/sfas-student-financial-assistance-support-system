// Both session monitors can notice a newer login at the same time. Show one
// notice and wait for the user before leaving the current page.
export function showSessionReplacementNotice(loginPath) {
    if (window.__sessionReplacementNoticeShown) return;
    window.__sessionReplacementNoticeShown = true;

    const message = 'This account was signed in from another browser or device. Please sign in again if that was you.';
    const goToLogin = () => window.location.replace(loginPath);

    if (window.Swal?.fire) {
        window.Swal.fire({
            title: 'Signed in on another device',
            text: message,
            icon: 'info',
            confirmButtonText: 'Sign in again',
            confirmButtonColor: '#03600f',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showCloseButton: false,
        }).then(goToLogin, goToLogin);
    } else {
        window.alert(message);
        goToLogin();
    }
}
