import StudentsDashboardModule from '../modules/students/students-dashboardModule.js?v=20261015-family-contact-edit';
import StudentsChatbotModule from '../modules/students/students-chatbotModule.js?v=20261020-student-ai-pages';
import StudentsNotificationsModule from '../modules/students/students-notificationsModule.js';

let studentsDashboardModule;
let studentsChatbotModule;
let studentsNotificationsModule;

document.addEventListener('DOMContentLoaded', () => {
    studentsDashboardModule = new StudentsDashboardModule();
    studentsDashboardModule.init();
    window.studentsDashboardModule = studentsDashboardModule;
    
    // Initialize chatbot
    studentsChatbotModule = new StudentsChatbotModule();
    studentsChatbotModule.init();
    window.studentsChatbotModule = studentsChatbotModule;
    
    // Initialize real-time notifications
    studentsNotificationsModule = new StudentsNotificationsModule();
    studentsNotificationsModule.init();
    window.studentsNotificationsModule = studentsNotificationsModule;
});
