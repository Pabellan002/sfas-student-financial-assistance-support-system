import StudentsLoansModule from '../modules/students/students-loansModule.js?v=20261007-student-pagination';
import StudentsChatbotModule from '../modules/students/students-chatbotModule.js?v=20261020-student-ai-pages';
import StudentsNotificationsModule from '../modules/students/students-notificationsModule.js';

let studentsLoansModule;
let studentsNotificationsModule;

document.addEventListener('DOMContentLoaded', () => {
    const assistant = new StudentsChatbotModule();
    assistant.init();
    window.studentsChatbotModule = assistant;

    studentsLoansModule = new StudentsLoansModule();
    studentsLoansModule.init();
    window.studentsLoansModule = studentsLoansModule;
    
    // Initialize real-time notifications
    studentsNotificationsModule = new StudentsNotificationsModule();
    studentsNotificationsModule.init();
    window.studentsNotificationsModule = studentsNotificationsModule;
});
