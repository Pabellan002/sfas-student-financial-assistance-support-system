import StudentsLoanChatModule from '../modules/students/students-loan-chatModule.js?v=20261008-unread-count';
import StudentsChatbotModule from '../modules/students/students-chatbotModule.js?v=20261020-student-ai-pages';
import StudentsNotificationsModule from '../modules/students/students-notificationsModule.js?v=20260927-office-threads';

document.addEventListener('DOMContentLoaded', () => {
    const assistant = new StudentsChatbotModule();
    assistant.init();
    window.studentsChatbotModule = assistant;

    const chat = new StudentsLoanChatModule();
    chat.init();
    window.studentsLoanChatModule = chat;

    const notifications = new StudentsNotificationsModule();
    notifications.init();
    window.studentsNotificationsModule = notifications;
});
