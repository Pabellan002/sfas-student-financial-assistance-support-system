import ApiService from '../../services/services-apiService.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]));

class StudentsLoanChatModule {
    constructor() {
        this.conversations = [];
        this.loanId = 0;
        this.officeType = '';
        this.lastMessageId = 0;
        this.pollTimer = null;
        this.typingHeartbeatTimer = null;
        this.typingStopTimer = null;
        this.typingActive = false;
        this.conversationRefreshCounter = 0;
        this.searchQuery = '';
        this.renderedMessageIds = new Set();
        this.sendInFlight = false;
    }

    async init() {
        const input = document.getElementById('studentChatInput');
        document.getElementById('studentChatForm')?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.sendMessage();
        });
        document.getElementById('studentChatSearch')?.addEventListener('input', (event) => {
            this.searchQuery = event.target.value.trim().toLowerCase();
            this.renderConversations();
        });
        document.getElementById('studentChatBackBtn')?.addEventListener('click', () => {
            document.getElementById('studentLoanChatApp')?.classList.remove('is-thread-open');
        });
        input?.addEventListener('input', () => {
            this.updateComposer();
            this.handleTypingInput();
        });
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                document.getElementById('studentChatForm')?.requestSubmit();
            }
        });
        window.addEventListener('beforeunload', () => this.stopPolling());
        await this.loadConversations();

        const requestedLoanId = Number(new URLSearchParams(window.location.search).get('loanId')) || 0;
        const requestedOffice = new URLSearchParams(window.location.search).get('officeType') || '';
        const initial = this.conversations.find((item) => Number(item.loan_id) === requestedLoanId && (!requestedOffice || item.office_type === requestedOffice)) || this.conversations[0];
        if (initial) await this.selectConversation(Number(initial.loan_id), initial.office_type);
    }

    errorMessage(error, fallback) {
        return error?.response?.data?.message || error?.message || fallback;
    }

    async loadConversations(silent = false) {
        try {
            const response = await ApiService.get('/shared/shared-loan-chat.php', { action: 'conversations' });
            if (!response?.success) throw new Error(response?.message || 'Unable to load conversations.');
            this.conversations = response.conversations || [];
            this.renderConversations();
            if (this.loanId) {
                const activeConversation = this.conversations.find((item) => Number(item.loan_id) === this.loanId && item.office_type === this.officeType);
                const title = document.getElementById('studentChatTitle');
                if (title && activeConversation) title.textContent = activeConversation.office_name || 'Loan Support';
            }
        } catch (error) {
            if (!silent) {
                const container = document.getElementById('studentChatConversations');
                if (container) container.innerHTML = `<div class="loan-chat-empty py-5 text-danger">${escapeHtml(this.errorMessage(error, 'Unable to load conversations.'))}</div>`;
            }
        }
    }

    renderConversations() {
        const container = document.getElementById('studentChatConversations');
        if (!container) return;
        if (!this.conversations.length) {
            container.innerHTML = `<div class="loan-chat-empty-state">
                <div class="loan-chat-empty-state__icon"><i class="bi bi-chat-square-dots"></i></div>
                <h3>No conversations yet</h3>
                <p>A loan conversation will appear here when a loan office sends you a message.</p>
            </div>`;
            return;
        }

        const filtered = this.conversations.filter((item) => {
            if (!this.searchQuery) return true;
            return String(item.loan_application_no || item.loan_id || '').toLowerCase().includes(this.searchQuery)
                || String(item.loan_status_name || '').toLowerCase().includes(this.searchQuery)
                || String(item.office_name || '').toLowerCase().includes(this.searchQuery);
        });
        if (!filtered.length) {
            container.innerHTML = `<div class="loan-chat-empty-state"><div class="loan-chat-empty-state__icon"><i class="bi bi-search"></i></div><h3>No matching loan</h3><p>Try another loan number or status.</p></div>`;
            return;
        }

        container.innerHTML = filtered.map((item) => {
            const active = Number(item.loan_id) === this.loanId && item.office_type === this.officeType;
            const unread = Number(item.unread_count) || 0;
            const preview = item.last_message || 'No messages yet';
            return `<button type="button" class="loan-chat-conversation${active ? ' is-active' : ''}" data-loan-id="${Number(item.loan_id)}" data-office-type="${escapeHtml(item.office_type)}">
                <span class="loan-chat-conversation-avatar"><i class="bi bi-file-earmark-text"></i></span>
                <span class="loan-chat-conversation-main">
                    <span class="loan-chat-conversation-title">${escapeHtml(item.office_name || 'Loan Office')} · ${escapeHtml(item.loan_application_no || `Loan #${item.loan_id}`)}</span>
                    <span class="loan-chat-conversation-preview">${escapeHtml(preview)}</span>
                    <span class="loan-chat-conversation-status">${escapeHtml(item.loan_status_name || 'Application')}</span>
                </span>
                <span class="loan-chat-conversation-meta">
                    <span class="loan-chat-conversation-time">${escapeHtml(this.formatConversationTime(item.last_message_at))}</span>
                    ${unread ? `<span class="loan-chat-unread">${unread > 99 ? '99+' : unread}</span>` : '<span></span>'}
                </span>
            </button>`;
        }).join('');

        container.querySelectorAll('[data-loan-id]').forEach((button) => {
            button.addEventListener('click', () => this.selectConversation(Number(button.dataset.loanId), button.dataset.officeType));
        });
    }

    async selectConversation(loanId, officeType) {
        if (!loanId || !officeType) return;
        this.stopPolling();
        this.loanId = loanId;
        this.officeType = officeType;
        this.lastMessageId = 0;
        this.renderedMessageIds.clear();
        this.renderConversations();

        const conversation = this.conversations.find((item) => Number(item.loan_id) === loanId && item.office_type === officeType);
        const input = document.getElementById('studentChatInput');
        const sendButton = document.getElementById('studentChatSendBtn');
        if (input) input.disabled = false;
        if (sendButton) sendButton.disabled = false;
        document.getElementById('studentChatTitle').textContent = conversation?.office_name || 'Loan Support';
        document.getElementById('studentChatSubtitle').innerHTML = `<span class="loan-chat-online-dot"></span>${escapeHtml(conversation?.loan_application_no || `Loan #${loanId}`)} · ${escapeHtml(conversation?.loan_status_name || 'Application')}`;
        document.getElementById('studentLoanChatApp')?.classList.add('is-thread-open');
        this.updateComposer();

        await this.loadMessages();
        this.pollTimer = window.setInterval(() => this.loadMessages(true), 1200);
        input?.focus();
    }

    async loadMessages(silent = false) {
        const requestedLoanId = this.loanId;
        const requestedOfficeType = this.officeType;
        if (!requestedLoanId) return;
        const conversation = this.conversations.find((item) => Number(item.loan_id) === requestedLoanId && item.office_type === requestedOfficeType);
        try {
            const response = await ApiService.get('/shared/shared-loan-chat.php', {
                action: 'messages', loanId: requestedLoanId, officeType: requestedOfficeType, afterId: this.lastMessageId
            });
            if (!response?.success) throw new Error(response?.message || 'Unable to load messages.');
            if (requestedLoanId !== this.loanId || requestedOfficeType !== this.officeType) return;

            const messages = response.messages || [];
            const container = document.getElementById('studentChatMessages');
            if (!container) return;
            if (this.lastMessageId === 0) container.innerHTML = '';
            container.querySelector('.loan-chat-typing')?.remove();
            if (messages.length && container.querySelector('.loan-chat-welcome-state')) container.innerHTML = '';
            messages.forEach((message) => {
                const messageId = Number(message.id) || 0;
                if (messageId && this.renderedMessageIds.has(messageId)) return;
                const wrapper = document.createElement('div');
                wrapper.className = `loan-chat-message ${message.is_mine ? 'is-mine' : 'is-other'}`;
                wrapper.innerHTML = `<div class="loan-chat-bubble"><div>${escapeHtml(message.body)}</div><small class="loan-chat-meta">${message.is_mine ? 'You' : escapeHtml(message.sender_label || 'Loan Office')} · ${escapeHtml(this.formatDate(message.created_at))}</small></div>`;
                container.appendChild(wrapper);
                if (messageId) this.renderedMessageIds.add(messageId);
                this.lastMessageId = Math.max(this.lastMessageId, messageId);
            });
            const typingOffice = response.other_typing_label || conversation?.office_name || 'Loan Office';
            this.renderTypingIndicator(container, Boolean(response.other_is_typing), `${typingOffice} is typing`);
            if (!container.querySelector('.loan-chat-message') && !container.querySelector('.loan-chat-typing')) container.innerHTML = `<div class="loan-chat-welcome-state"><div class="loan-chat-welcome-icon"><i class="bi bi-chat-heart"></i></div><h3>Start the conversation</h3><p>Ask the loan office about payment options, loan requirements, or an appeal request.</p></div>`;
            if (messages.length || response.other_is_typing) {
                container.scrollTop = container.scrollHeight;
            }
            if (messages.length) {
                await this.markRead(requestedLoanId, requestedOfficeType);
                this.conversationRefreshCounter = 0;
                await this.loadConversations(true);
            } else if (++this.conversationRefreshCounter >= 10) {
                this.conversationRefreshCounter = 0;
                await this.loadConversations(true);
            }
        } catch (error) {
            if (!silent) {
                const container = document.getElementById('studentChatMessages');
                if (container) container.innerHTML = `<div class="loan-chat-empty text-danger">${escapeHtml(this.errorMessage(error, 'Unable to load messages.'))}</div>`;
            }
        }
    }

    async markRead(loanId, officeType) {
        const data = new FormData();
        data.append('action', 'mark_read');
        data.append('loanId', String(loanId));
        data.append('officeType', officeType);
        try {
            const response = await ApiService.postFormData('/shared/shared-loan-chat.php', data);
            if (response?.success) window.dispatchEvent(new Event('sidebar-live-counts:refresh'));
        } catch (_) {}
    }

    async sendMessage() {
        const input = document.getElementById('studentChatInput');
        const sendButton = document.getElementById('studentChatSendBtn');
        const message = input?.value.trim() || '';
        if (!this.loanId || !message || this.sendInFlight) return;

        this.sendInFlight = true;
        this.stopTyping();
        input.disabled = true;
        sendButton.disabled = true;
        try {
            const data = new FormData();
            data.append('action', 'send');
            data.append('loanId', String(this.loanId));
            data.append('officeType', this.officeType);
            data.append('message', message);
            const response = await ApiService.postFormData('/shared/shared-loan-chat.php', data);
            if (!response?.success) throw new Error(response?.message || 'Message was not sent.');
            input.value = '';
            this.updateComposer();
            await this.loadMessages();
        } catch (error) {
            Swal.fire({ icon: 'error', title: 'Message not sent', text: this.errorMessage(error, 'Please try again.') });
        } finally {
            this.sendInFlight = false;
            input.disabled = false;
            sendButton.disabled = false;
            input.focus();
        }
    }

    formatDate(value) {
        const date = new Date(String(value || '').replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
    }

    formatConversationTime(value) {
        if (!value) return '';
        const date = new Date(String(value).replace(' ', 'T'));
        if (Number.isNaN(date.getTime())) return '';
        const today = new Date();
        if (date.toDateString() === today.toDateString()) {
            return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    updateComposer() {
        const input = document.getElementById('studentChatInput');
        const counter = document.getElementById('studentChatCharacterCount');
        if (!input) return;
        if (counter) counter.textContent = `${input.value.length}/2000`;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 115)}px`;
    }

    renderTypingIndicator(container, isTyping, label) {
        container.querySelector('.loan-chat-typing')?.remove();
        if (!isTyping) return;
        container.querySelector('.loan-chat-welcome-state')?.remove();
        const indicator = document.createElement('div');
        indicator.className = 'loan-chat-typing';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-label', label);
        indicator.innerHTML = `<span class="loan-chat-typing__bubble" aria-hidden="true"><span class="loan-chat-typing__dot"></span><span class="loan-chat-typing__dot"></span><span class="loan-chat-typing__dot"></span></span><span class="loan-chat-typing__label">${escapeHtml(label)}</span>`;
        container.appendChild(indicator);
    }

    handleTypingInput() {
        const input = document.getElementById('studentChatInput');
        if (!this.loanId || !input?.value.trim()) {
            this.stopTyping();
            return;
        }
        if (!this.typingActive) {
            this.typingActive = true;
            this.sendTypingState(true);
            this.typingHeartbeatTimer = window.setInterval(() => this.sendTypingState(true), 1500);
        }
        if (this.typingStopTimer) window.clearTimeout(this.typingStopTimer);
        this.typingStopTimer = window.setTimeout(() => this.stopTyping(), 1800);
    }

    sendTypingState(isTyping, loanId = this.loanId, officeType = this.officeType) {
        if (!loanId) return;
        const data = new FormData();
        data.append('action', 'typing');
        data.append('loanId', String(loanId));
        data.append('officeType', officeType);
        data.append('isTyping', isTyping ? '1' : '0');
        ApiService.postFormData('/shared/shared-loan-chat.php', data).catch(() => {});
    }

    stopTyping(loanId = this.loanId, officeType = this.officeType) {
        if (this.typingHeartbeatTimer) window.clearInterval(this.typingHeartbeatTimer);
        if (this.typingStopTimer) window.clearTimeout(this.typingStopTimer);
        this.typingHeartbeatTimer = null;
        this.typingStopTimer = null;
        if (this.typingActive) this.sendTypingState(false, loanId, officeType);
        this.typingActive = false;
    }

    stopPolling() {
        this.stopTyping();
        if (this.pollTimer) window.clearInterval(this.pollTimer);
        this.pollTimer = null;
    }
}

export default StudentsLoanChatModule;
