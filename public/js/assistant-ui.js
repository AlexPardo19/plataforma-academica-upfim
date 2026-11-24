import { apiFetch, escapeHtml } from './api.js';

const shell = document.getElementById('assistant-shell');
const fab = document.getElementById('assistant-fab');
const win = document.getElementById('assistant-window');
const minBtn = document.getElementById('assistant-min-btn');
const clearBtn = document.getElementById('assistant-clear-btn');
const messagesEl = document.getElementById('assistant-messages');
const form = document.getElementById('assistant-form');
const input = document.getElementById('assistant-input');

function formatAssistantContent(text) {
  const safe = escapeHtml(text);
  return safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMessages(messages) {
  messagesEl.innerHTML = messages
    .map((m) => `<div class="bubble ${m.sender}">${formatAssistantContent(m.content)}</div>`)
    .join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

export async function loadAssistantHistory() {
  shell.classList.remove('hidden');
  try {
    const data = await apiFetch('/api/assistant/messages');
    renderMessages(data.messages || []);
  } catch {
    // Silencioso
  }
}

export function hideAssistantWidget() {
  shell.classList.add('hidden');
  win.classList.add('hidden');
  fab.classList.remove('hidden');
}

async function sendAssistantQuestion(text) {
  const clean = text.trim();
  if (!clean) return;

  const tempBubble = document.createElement('div');
  tempBubble.className = 'bubble user';
  tempBubble.textContent = clean;
  messagesEl.appendChild(tempBubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  input.value = '';

  try {
    await apiFetch('/api/assistant/messages', {
      method: 'POST',
      body: { content: clean }
    });
    const data = await apiFetch('/api/assistant/messages');
    renderMessages(data.messages || []);
  } catch (err) {
    const errBubble = document.createElement('div');
    errBubble.className = 'bubble assistant';
    errBubble.textContent = `No se pudo procesar tu mensaje: ${err.message}`;
    messagesEl.appendChild(errBubble);
  }
}

export function initAssistantHandlers() {
  fab.addEventListener('click', () => {
    fab.classList.add('hidden');
    win.classList.remove('hidden');
    loadAssistantHistory();
    input.focus();
  });

  minBtn.addEventListener('click', () => {
    win.classList.add('hidden');
    fab.classList.remove('hidden');
  });

  clearBtn.addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/assistant/messages', { method: 'DELETE' });
      renderMessages(data.messages || []);
    } catch {
      // Ignorar
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendAssistantQuestion(input.value);
  });

  document.querySelectorAll('[data-quick-ask]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendAssistantQuestion(btn.dataset.quickAsk || '');
    });
  });
}
