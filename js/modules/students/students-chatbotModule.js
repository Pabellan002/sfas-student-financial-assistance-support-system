import ApiService from '../../services/services-apiService.js';

const adviserAvatarUrl = new URL('../../../assets/images/ask-sfas-adviser.png', import.meta.url).href;

function createAdviserAvatar() {
    const image = document.createElement('img');
    image.src = adviserAvatarUrl;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    return image;
}

class StudentsChatbotModule {
    constructor() {
        this.chatbotButton = null;
        this.chatbotWindow = null;
        this.chatbotCloseBtn = null;
        this.chatbotIntro = null;
        this.chatbotConversation = null;
        this.chatbotStartBtn = null;
        this.chatbotGreeting = null;
        this.chatbotMessages = null;
        this.chatbotInput = null;
        this.chatbotSendBtn = null;
        this.isOpen = false;
        this.hasStarted = false;
        this.messages = [];
        this.isTyping = false;
        this.historyKey = null;
        this.studentName = '';
    }

    async init() {
        this.setupElements();
        await this.setupHistory();
        this.setupEventListeners();
        this.loadChatHistory();
    }

    async setupHistory() {
        // A verified account scopes history; never restore another student's messages.
        try {
            localStorage.removeItem('chatbot_history');
        } catch (_) {}
        try {
            const session = await ApiService.get('/auth/auth-check-session.php');
            const id = Number(session?.user?.id);
            if (session?.success && (session.authenticated === true || session.active === true)
                && session.user?.type === 'student' && Number.isSafeInteger(id) && id > 0) {
                this.historyKey = `sfas_chatbot_history:${id}`;
                this.studentName = String(session.user.name || '');
            }
        } catch (error) {
            // Help remains usable when session-storage initialization is unavailable.
            console.warn('Ask SFAS history is unavailable for this page.');
        }
    }

    setupElements() {
        this.chatbotButton = document.getElementById('chatbotButton');
        this.chatbotWindow = document.getElementById('chatbotWindow');
        this.chatbotCloseBtn = document.getElementById('chatbotCloseBtn');
        this.chatbotIntro = document.getElementById('chatbotIntro');
        this.chatbotConversation = document.getElementById('chatbotConversation');
        this.chatbotStartBtn = document.getElementById('chatbotStartBtn');
        this.chatbotGreeting = document.getElementById('chatbotGreeting');
        this.chatbotMessages = document.getElementById('chatbotMessages');
        this.chatbotInput = document.getElementById('chatbotInput');
        this.chatbotSendBtn = document.getElementById('chatbotSendBtn');
    }

    setupEventListeners() {
        document.addEventListener('pointerdown', (event) => {
            if (!this.isOpen) return;
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (this.chatbotWindow?.contains(target) || this.chatbotButton?.contains(target)) return;
            this.closeChatbot();
        }, true);

        if (this.chatbotButton) {
            this.chatbotButton.addEventListener('click', () => this.toggleChatbot());
        }

        if (this.chatbotCloseBtn) {
            this.chatbotCloseBtn.addEventListener('click', () => {
                this.closeChatbot();
                this.chatbotButton?.focus();
            });
        }

        this.chatbotStartBtn?.addEventListener('click', () => this.startConversation());

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.isOpen) {
                this.closeChatbot();
                this.chatbotButton?.focus();
            }
        });

        if (this.chatbotSendBtn) {
            this.chatbotSendBtn.addEventListener('click', () => this.sendMessage());
        }

        if (this.chatbotInput) {
            this.chatbotInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
        }
    }

    toggleChatbot() {
        if (this.isOpen) {
            this.closeChatbot();
        } else {
            this.openChatbot();
        }
    }

    openChatbot() {
        if (this.chatbotWindow) {
            this.updateGreeting();
            this.chatbotIntro?.classList.toggle('d-none', this.hasStarted);
            this.chatbotConversation?.classList.toggle('d-none', !this.hasStarted);
            this.chatbotWindow.classList.remove('d-none');
            this.isOpen = true;
            this.chatbotButton?.setAttribute('aria-expanded', 'true');
            this.chatbotButton?.setAttribute('aria-label', 'Close Ask SFAS');
            (this.hasStarted ? this.chatbotInput : this.chatbotStartBtn)?.focus();
            this.scrollToBottom();
        }
    }

    updateGreeting() {
        if (!this.chatbotGreeting) return;
        const profileName = document.getElementById('profileNameDesktop')?.textContent?.trim() || this.studentName;
        const firstName = profileName && profileName !== 'Student Name'
            ? profileName.split(/\s+/)[0]
            : '';
        const displayName = firstName
            ? firstName.charAt(0).toLocaleUpperCase() + firstName.slice(1).toLocaleLowerCase()
            : 'there';
        this.chatbotGreeting.textContent = `Hi, ${displayName}!`;
    }

    startConversation() {
        this.hasStarted = true;
        this.chatbotIntro?.classList.add('d-none');
        this.chatbotConversation?.classList.remove('d-none');
        this.chatbotInput?.focus();
        this.scrollToBottom();
        this.saveChatHistory();
    }

    closeChatbot() {
        if (this.chatbotWindow) {
            this.chatbotWindow.classList.add('d-none');
            this.isOpen = false;
            this.chatbotButton?.setAttribute('aria-expanded', 'false');
            this.chatbotButton?.setAttribute('aria-label', 'Open Ask SFAS');
        }
    }

    async sendMessage() {
        const message = this.chatbotInput?.value.trim();
        if (!message || this.isTyping) return;

        // Add user message to UI
        this.addMessage(message, 'user');
        this.chatbotInput.value = '';
        this.chatbotInput.disabled = true;
        this.chatbotSendBtn.disabled = true;

        // Show typing indicator
        this.showTypingIndicator();

        try {
            const response = await ApiService.post('/students/students-chatbot.php', {
                message: message
            });

            this.hideTypingIndicator();

            if (response && response.success) {
                this.addMessage(response.response, 'bot');
            } else {
                this.addMessage(
                    'I apologize, but I encountered an error. Please try again or contact support for assistance.',
                    'bot'
                );
            }
        } catch (error) {
            this.hideTypingIndicator();
            console.error('Chatbot error:', error);
            
            let errorMessage = 'I apologize, but I\'m having trouble processing your request. ';
            if (error.response?.status === 401) {
                errorMessage += 'Please make sure you\'re logged in and try again.';
            } else if (error.response?.status === 429) {
                errorMessage += 'Too many requests. Please wait a moment and try again.';
            } else {
                errorMessage += 'Please try again later or contact support.';
            }
            
            this.addMessage(errorMessage, 'bot');
        } finally {
            this.chatbotInput.disabled = false;
            this.chatbotSendBtn.disabled = false;
            if (this.isOpen) this.chatbotInput?.focus();
        }
    }

    addMessage(text, sender, { timestamp = new Date().toISOString(), persist = true } = {}) {
        if (!this.chatbotMessages) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${sender}-message`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        if (sender === 'bot') {
            avatar.appendChild(createAdviserAvatar());
        } else {
            avatar.innerHTML = '<i class="bi bi-person-fill"></i>';
        }

        const content = document.createElement('div');
        content.className = 'message-content';

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        
        // Convert text to HTML (handle line breaks and basic formatting)
        const formattedText = this.formatMessage(text);
        bubble.innerHTML = formattedText;

        const time = document.createElement('small');
        time.className = 'message-time';
        time.textContent = this.getCurrentTime(timestamp);

        content.appendChild(bubble);
        content.appendChild(time);
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(content);

        this.chatbotMessages.appendChild(messageDiv);
        this.scrollToBottom();

        // Store message in history
        this.messages.push({ text, sender, timestamp });
        this.messages = this.messages.slice(-50);
        if (persist) this.saveChatHistory();
    }

    formatMessage(text) {
        const escaped = this.escapeHtml(String(text ?? ''));

        // Convert line breaks to <br>
        let html = escaped.replace(/\n/g, '<br>');

        // Convert URLs to safe links after escaping.
        html = html.replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
        );

        // Lightweight markdown formatting on already-escaped content.
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

        // Convert numbered lists (1. item)
        html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
        if (html.includes('<li>')) {
            html = '<ol>' + html + '</ol>';
            html = html.replace(/<\/ol>\s*<ol>/g, '');
        }

        // Convert bullet points (- item)
        html = html.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>');
        if (html.includes('<li>') && !html.includes('<ol>')) {
            html = '<ul>' + html + '</ul>';
            html = html.replace(/<\/ul>\s*<ul>/g, '');
        }

        return html;
    }

    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    showTypingIndicator() {
        if (!this.chatbotMessages) return;
        this.isTyping = true;

        const typingDiv = document.createElement('div');
        typingDiv.className = 'chat-message bot-message';
        typingDiv.id = 'typingIndicator';

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.appendChild(createAdviserAvatar());

        const content = document.createElement('div');
        content.className = 'message-content';

        const typingBubble = document.createElement('div');
        typingBubble.className = 'typing-indicator';
        typingBubble.innerHTML = `
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
        `;

        content.appendChild(typingBubble);
        typingDiv.appendChild(avatar);
        typingDiv.appendChild(content);
        this.chatbotMessages.appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.remove();
        }
        this.isTyping = false;
    }

    scrollToBottom() {
        if (this.chatbotMessages) {
            this.chatbotMessages.scrollTop = this.chatbotMessages.scrollHeight;
        }
    }

    getCurrentTime(value = new Date()) {
        const now = new Date(value);
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    saveChatHistory() {
        if (!this.historyKey) return;
        try {
            const history = {
                version: 2,
                started: this.hasStarted,
                messages: this.messages.slice(-50),
                lastUpdated: new Date().toISOString()
            };
            sessionStorage.setItem(this.historyKey, JSON.stringify(history));
        } catch (error) {
            console.error('Error saving chat history:', error);
        }
    }

    loadChatHistory() {
        if (!this.historyKey) return;
        try {
            const stored = sessionStorage.getItem(this.historyKey);
            if (!stored) return;
            const history = JSON.parse(stored);
            const age = Date.now() - Date.parse(history.lastUpdated);
            if (history.version !== 2 || !Array.isArray(history.messages)
                || !Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) {
                sessionStorage.removeItem(this.historyKey);
                return;
            }
            const messages = history.messages.filter((message) => message
                && ['user', 'bot'].includes(message.sender) && typeof message.text === 'string'
                && message.text.length <= 10000 && Number.isFinite(Date.parse(message.timestamp))).slice(-50);
            this.hasStarted = history.started === true || messages.length > 0;
            if (!messages.length || !this.chatbotMessages) return;
            this.chatbotMessages.replaceChildren();
            this.messages = [];
            messages.forEach((message) => this.addMessage(message.text, message.sender,
                { timestamp: message.timestamp, persist: false }));
        } catch (error) {
            console.error('Error loading chat history:', error);
        }
    }
}

export default StudentsChatbotModule;

