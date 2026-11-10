import ApiService from '../services/services-apiService.js';
import { escapeHtml } from './shared-escape.js';

export default class StaffLoanChatController {
    constructor({ hasPermission, getLoans }) {
        this.hasPermission = hasPermission;
        this.getLoans = getLoans;
        this.loanId = 0;
        this.lastMessageId = 0;
        this.pollTimer = null;
        this.typingHeartbeatTimer = null;
        this.typingStopTimer = null;
        this.typingActive = false;
        this.renderedMessageIds = new Set();
        this.sendInFlight = false;
        this.bound = false;
    }

    bind() {
        if (this.bound) return;
        this.bound = true;
        const form = document.getElementById('loanChatForm');
        const input = document.getElementById('loanChatInput');
        form?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.sendMessage();
        });
        input?.addEventListener('input', () => this.handleTyping());
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                form?.requestSubmit();
            }
        });
        document.getElementById('loanChatModal')?.addEventListener('hidden.bs.modal', () => this.stop());
        const chatLoan = Number(new URLSearchParams(window.location.search).get('chatLoan')) || 0;
        if (chatLoan && this.hasPermission()) {
            const url = new URL(window.location.href);
            url.searchParams.delete('chatLoan');
            window.history.replaceState({}, '', url.pathname + url.search + url.hash);
            this.open(chatLoan);
        }
    }

    async open(loanId) {
        if (!this.hasPermission() || !loanId) return;
        this.bind();
        this.stop();
        this.loanId = Number(loanId);
        this.lastMessageId = 0;
        this.renderedMessageIds.clear();
        const loan = this.getLoans().find((item) => Number(item.loan_id || item.loanId || item.id) === this.loanId);
        const subtitle = document.getElementById('loanChatSubtitle');
        if (subtitle) subtitle.textContent = loan
            ? `${loan.name || loan.student_name || loan.studentName || 'Student'} · ${loan.applicationNo || loan.loan_application_no || ''}`
            : `Loan #${this.loanId}`;
        const messages = document.getElementById('loanChatMessages');
        if (messages) messages.innerHTML = '<div class="loan-chat-empty">Loading conversation...</div>';
        const modal = document.getElementById('loanChatModal');
        if (!modal) return;
        bootstrap.Modal.getOrCreateInstance(modal).show();
        await this.loadMessages();
        this.pollTimer = window.setInterval(() => this.loadMessages(true), 1200);
        document.getElementById('loanChatInput')?.focus();
    }

    async loadMessages(silent = false) {
        if (!this.hasPermission() || !this.loanId) return;
        const requestedLoanId = this.loanId;
        try {
            const response = await ApiService.get('/shared/shared-loan-chat.php', {
                action: 'messages', loanId: requestedLoanId, afterId: this.lastMessageId
            });
            if (!response?.success) throw new Error(response?.message || 'Failed to load messages.');
            if (requestedLoanId !== this.loanId) return;
            const subtitle = document.getElementById('loanChatSubtitle');
            if (subtitle && response.loan) subtitle.textContent = `${response.loan.student_name || 'Student'} · ${response.loan.loan_application_no || ''}`;
            const container = document.getElementById('loanChatMessages');
            if (!container) return;
            if (this.lastMessageId === 0) container.innerHTML = '';
            container.querySelector('.loan-chat-typing')?.remove();
            if ((response.messages || []).length && container.querySelector('.loan-chat-empty')) container.innerHTML = '';
            (response.messages || []).forEach((message) => {
                const messageId = Number(message.id) || 0;
                if (messageId && this.renderedMessageIds.has(messageId)) return;
                const wrapper = document.createElement('div');
                wrapper.className = `loan-chat-message ${message.is_mine ? 'is-mine' : 'is-other'}`;
                const time = new Date(String(message.created_at || '').replace(' ', 'T')).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                });
                const sender = message.is_mine ? 'You' : (message.sender_label || (message.sender_type === 'student' ? 'Student' : 'Loan Office'));
                wrapper.innerHTML = `<div class="loan-chat-bubble"><div>${escapeHtml(message.body)}</div><span class="loan-chat-meta">${escapeHtml(sender)} · ${escapeHtml(time)}</span></div>`;
                container.appendChild(wrapper);
                if (messageId) this.renderedMessageIds.add(messageId);
                this.lastMessageId = Math.max(this.lastMessageId, messageId);
            });
            this.renderTyping(container, Boolean(response.other_is_typing), response.other_typing_label || 'Student');
            if (!container.querySelector('.loan-chat-message') && !container.querySelector('.loan-chat-typing')) {
                container.innerHTML = '<div class="loan-chat-empty">Start the conversation about this loan.</div>';
            }
            if ((response.messages || []).length || response.other_is_typing) container.scrollTop = container.scrollHeight;
            const readData = new FormData();
            readData.append('action', 'mark_read');
            readData.append('loanId', String(this.loanId));
            ApiService.postFormData('/shared/shared-loan-chat.php', readData).catch(() => {});
        } catch (error) {
            if (!silent) {
                const container = document.getElementById('loanChatMessages');
                if (container) container.innerHTML = `<div class="loan-chat-empty text-danger">${escapeHtml(error.message || 'Failed to load conversation.')}</div>`;
            }
        }
    }

    async sendMessage() {
        if (!this.hasPermission()) return;
        const input = document.getElementById('loanChatInput');
        const submit = document.querySelector('#loanChatForm button[type="submit"]');
        const message = input?.value.trim() || '';
        if (!this.loanId || !message || this.sendInFlight) return;
        this.sendInFlight = true;
        this.stopTyping();
        if (input) input.disabled = true;
        if (submit) submit.disabled = true;
        try {
            const data = new FormData();
            data.append('action', 'send');
            data.append('loanId', String(this.loanId));
            data.append('message', message);
            const response = await ApiService.postFormData('/shared/shared-loan-chat.php', data);
            if (!response?.success) throw new Error(response?.message || 'Message was not sent.');
            if (input) input.value = '';
            await this.loadMessages();
        } catch (error) {
            window.Swal?.fire({ icon: 'error', title: 'Message not sent', text: error.message || 'Please try again.' });
        } finally {
            this.sendInFlight = false;
            if (input) { input.disabled = false; input.focus(); }
            if (submit) submit.disabled = false;
        }
    }

    renderTyping(container, isTyping, senderLabel) {
        container.querySelector('.loan-chat-typing')?.remove();
        if (!isTyping) return;
        container.querySelector('.loan-chat-empty')?.remove();
        const label = `${senderLabel} is typing`;
        const indicator = document.createElement('div');
        indicator.className = 'loan-chat-typing';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-label', label);
        indicator.innerHTML = `<span class="loan-chat-typing__bubble" aria-hidden="true"><span class="loan-chat-typing__dot"></span><span class="loan-chat-typing__dot"></span><span class="loan-chat-typing__dot"></span></span><span class="loan-chat-typing__label">${escapeHtml(label)}</span>`;
        container.appendChild(indicator);
    }

    handleTyping() {
        const input = document.getElementById('loanChatInput');
        if (!this.loanId || !input?.value.trim()) return this.stopTyping();
        if (!this.typingActive) {
            this.typingActive = true;
            this.sendTyping(true);
            this.typingHeartbeatTimer = window.setInterval(() => this.sendTyping(true), 1500);
        }
        if (this.typingStopTimer) window.clearTimeout(this.typingStopTimer);
        this.typingStopTimer = window.setTimeout(() => this.stopTyping(), 1800);
    }

    sendTyping(isTyping, loanId = this.loanId) {
        if (!this.hasPermission() || !loanId) return;
        const data = new FormData();
        data.append('action', 'typing');
        data.append('loanId', String(loanId));
        data.append('isTyping', isTyping ? '1' : '0');
        ApiService.postFormData('/shared/shared-loan-chat.php', data).catch(() => {});
    }

    stopTyping(loanId = this.loanId) {
        if (this.typingHeartbeatTimer) window.clearInterval(this.typingHeartbeatTimer);
        if (this.typingStopTimer) window.clearTimeout(this.typingStopTimer);
        this.typingHeartbeatTimer = null;
        this.typingStopTimer = null;
        if (this.typingActive) this.sendTyping(false, loanId);
        this.typingActive = false;
    }

    stop() {
        this.stopTyping();
        if (this.pollTimer) window.clearInterval(this.pollTimer);
        this.pollTimer = null;
    }
}
