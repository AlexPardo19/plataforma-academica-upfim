import { apiFetch, escapeHtml, formatTimeFromIso } from './api.js';

let currentUserId = null;
let activeContactId = null;

const modal = document.getElementById('chat-modal');
const contactsEl = document.getElementById('chat-contacts-list');
const headerEl = document.getElementById('chat-active-header');
const boxEl = document.getElementById('chat-messages-box');
const form = document.getElementById('chat-send-form');
const input = document.getElementById('chat-text-input');
const sendBtn = document.getElementById('chat-send-btn');
const unreadBadge = document.getElementById('chat-unread-badge');

export function setChatUserId(userId) {
  currentUserId = userId;
}

export function updateUnreadBadge(count) {
  const n = Number(count || 0);
  if (n > 0) {
    unreadBadge.textContent = `+${n}`;
    unreadBadge.classList.remove('hidden');
  } else {
    unreadBadge.textContent = '0';
    unreadBadge.classList.add('hidden');
  }
}

function renderMessages(messages) {
  if (!messages.length) {
    boxEl.innerHTML = '<div class="muted small-text">Aún no hay mensajes en esta conversación. Escribe el primero abajo.</div>';
    return;
  }
  boxEl.innerHTML = messages
    .map((m) => {
      const cls = m.senderId === currentUserId ? 'user' : 'other';
      return `
        <div class="bubble ${cls}">
          <div>${escapeHtml(m.content)}</div>
          <span class="msg-time">${escapeHtml(formatTimeFromIso(m.createdAt))}</span>
        </div>
      `;
    })
    .join('');
  boxEl.scrollTop = boxEl.scrollHeight;
}

async function selectContact(contactId) {
  activeContactId = Number(contactId);
  input.disabled = false;
  sendBtn.disabled = false;

  const data = await apiFetch(`/api/messages/${activeContactId}`);
  updateUnreadBadge(data.unreadMessages);
  headerEl.textContent = `${data.contact.name} (${data.contact.role === 'teacher' ? 'Docente' : data.contact.groupName || 'Estudiante'})`;
  renderMessages(data.messages || []);
  await loadContacts();
  input.focus();
}

async function loadContacts() {
  const data = await apiFetch('/api/messages/contacts');
  const contacts = data.contacts || [];
  if (!contacts.length) {
    contactsEl.innerHTML = '<div class="muted small-text">No hay contactos disponibles todavía.</div>';
    return;
  }

  contactsEl.innerHTML = contacts
    .map((c) => {
      const active = c.id === activeContactId ? 'active' : '';
      const sub = c.role === 'teacher' ? (c.subjectsLabel || 'Docente') : (c.groupName || 'Estudiante');
      const badge = c.unreadCount > 0 ? `<span class="badge danger">+${c.unreadCount}</span>` : '';
      return `
        <button type="button" class="contact-item ${active}" data-contact-id="${c.id}">
          <div>
            <strong>${escapeHtml(c.name)}</strong>
            <div class="small-text muted">${escapeHtml(sub)}</div>
          </div>
          ${badge}
        </button>
      `;
    })
    .join('');

  contactsEl.querySelectorAll('.contact-item').forEach((btn) => {
    btn.addEventListener('click', () => selectContact(btn.dataset.contactId));
  });
}

export async function openChatModal(preselectContactId = null) {
  modal.classList.remove('hidden');
  await loadContacts();
  if (preselectContactId) {
    await selectContact(preselectContactId);
  }
}

export async function handleIncomingPrivateMessage(payload) {
  updateUnreadBadge(payload.unreadMessages);
  const isModalOpen = !modal.classList.contains('hidden');
  if (isModalOpen && payload.message && payload.message.senderId === activeContactId) {
    await selectContact(activeContactId);
  } else if (isModalOpen) {
    await loadContacts();
  }
}

export function initChatHandlers() {
  document.getElementById('open-chat-btn').addEventListener('click', () => {
    openChatModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeContactId) return;
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    try {
      await apiFetch(`/api/messages/${activeContactId}`, {
        method: 'POST',
        body: { content: text }
      });
      await selectContact(activeContactId);
    } catch (err) {
      headerEl.textContent = `Error al enviar: ${err.message}`;
    }
  });
}
