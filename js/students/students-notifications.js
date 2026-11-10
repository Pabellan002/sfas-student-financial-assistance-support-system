import StudentsNotificationsModule from '../modules/students/students-notificationsModule.js';

document.addEventListener('DOMContentLoaded', () => {
    const notificationsModule = new StudentsNotificationsModule();
    notificationsModule.init();
    window.studentsNotificationsModule = notificationsModule;
});
