import {
  apiFetch,
  getStoredToken,
  setOnSessionExpired,
  setStoredToken
} from './api.js';
import { hideAssistantWidget, initAssistantHandlers, loadAssistantHistory } from './assistant-ui.js';
import { handleIncomingPrivateMessage, initChatHandlers, setChatUserId, updateUnreadBadge } from './chat.js';
import { resetShownAlerts, showToast } from './notifications.js';
import { initStreakHandlers, refreshStreakWidget, setStreakUserUpdateCallback } from './streak.js';
import { initStudentHandlers, loadStudentTasks } from './student.js';
import { initTeacherHandlers, loadTeacherPortal } from './teacher.js';
import { initPomodoroTimer } from './timer.js';
import { initTutorialHandlers, openTutorial } from './tutorial.js';

let currentUser = null;
let eventSource = null;

const networkBanner = document.getElementById('network-banner');
const topbar = document.getElementById('topbar');
const authView = document.getElementById('auth-view');
const studentView = document.getElementById('student-view');
const teacherView = document.getElementById('teacher-view');
const authAlert = document.getElementById('auth-alert');

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const recoverPanel = document.getElementById('recover-panel');
const regRoleSelect = document.getElementById('reg-role');
const regGroupWrap = document.getElementById('reg-group-wrap');
const regGroupSelect = document.getElementById('reg-group');

const userRoleBadge = document.getElementById('user-role-badge');
const userAvatarChip = document.getElementById('user-avatar-chip');
const userNameLabel = document.getElementById('user-name-label');
const studentGroupSubtitle = document.getElementById('student-group-subtitle');
const pendingCounterPill = document.getElementById('pending-counter-pill');
const streakWidgetWrap = document.getElementById('streak-widget-wrap');

const profileModal = document.getElementById('profile-modal');
const profileForm = document.getElementById('profile-form');
const profileAlert = document.getElementById('profile-alert');
const profName = document.getElementById('prof-name');
const profEmail = document.getElementById('prof-email');
const profAvatar = document.getElementById('prof-avatar');
const profGroup = document.getElementById('prof-group');
const profGroupWrap = document.getElementById('prof-group-wrap');

function showAuthAlert(msg, type = 'error') {
  authAlert.textContent = msg;
  authAlert.className = `alert ${type}`;
  authAlert.classList.remove('hidden');
}

function clearAuthAlert() {
  authAlert.classList.add('hidden');
}

function updateTopbarUser(user) {
  currentUser = user;
  userNameLabel.textContent = user.name;
  userRoleBadge.textContent =
    user.role === 'teacher'
      ? 'Portal Docente'
      : `Estudiante · Grupo ${user.groupName || 'Sin grupo'}`;

  if (user.avatarUrl) {
    userAvatarChip.innerHTML = `<img src="${user.avatarUrl}" alt="Foto" />`;
  } else {
    userAvatarChip.textContent = (user.name || 'U').charAt(0).toUpperCase();
  }

  if (user.role === 'student') {
    studentGroupSubtitle.textContent = `Grupo ${user.groupName || 'General'} · ${user.groupProgram || 'UPFIM'}`;
  }
}

function connectSse(token) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  eventSource.addEventListener('private_message', (ev) => {
    const payload = JSON.parse(ev.data);
    handleIncomingPrivateMessage(payload);
    showToast({
      title: `💬 Nuevo mensaje de ${payload.senderName}`,
      body: payload.message.content.slice(0, 90),
      variant: 'info',
      autoCloseMs: 7000
    });
  });
  eventSource.addEventListener('unread_update', (ev) => {
    const payload = JSON.parse(ev.data);
    updateUnreadBadge(payload.unreadMessages);
  });
}

function switchToAuthScreen(expiredMsg = '') {
  currentUser = null;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  resetShownAlerts();
  topbar.classList.add('hidden');
  studentView.classList.add('hidden');
  teacherView.classList.add('hidden');
  pendingCounterPill.classList.add('hidden');
  streakWidgetWrap.classList.add('hidden');
  hideAssistantWidget();
  authView.classList.remove('hidden');
  if (expiredMsg) showAuthAlert(expiredMsg, 'error');
}

async function enterAuthenticatedApp(user, { unreadMessages = 0, streakEvent = null, isFreshLogin = false } = {}) {
  updateTopbarUser(user);
  setChatUserId(user.id);
  updateUnreadBadge(unreadMessages);

  authView.classList.add('hidden');
  topbar.classList.remove('hidden');
  connectSse(getStoredToken());

  if (user.role === 'teacher') {
    studentView.classList.add('hidden');
    pendingCounterPill.classList.add('hidden');
    streakWidgetWrap.classList.add('hidden');
    hideAssistantWidget();
    teacherView.classList.remove('hidden');
    await loadTeacherPortal();
  } else {
    teacherView.classList.add('hidden');
    studentView.classList.remove('hidden');
    await refreshStreakWidget();
    await loadStudentTasks(isFreshLogin);
    await loadAssistantHistory();

    if (streakEvent && streakEvent.message) {
      showToast({
        title: streakEvent.status === 'reset' ? '🔄 Ciclo de racha reiniciado' : '🔥 Racha actualizada',
        body: streakEvent.message,
        variant: streakEvent.status === 'reset' ? 'warning' : 'success',
        autoCloseMs: 9000
      });
    }
  }

  // Tutorial emergente en primera sesión (HU-07)
  if (!user.tutorialCompleted) {
    openTutorial(user.role);
  }
}

async function loadGroupsCatalog() {
  try {
    const { groups } = await apiFetch('/api/groups');
    const html = (groups || [])
      .map((g) => `<option value="${g.id}">${g.name} — ${g.program}</option>`)
      .join('');
    regGroupSelect.innerHTML = html;
    profGroup.innerHTML = html;
  } catch {
    // Silencioso
  }
}

async function performLogin(email, password) {
  clearAuthAlert();
  const data = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  setStoredToken(data.token);
  await enterAuthenticatedApp(data.user, {
    unreadMessages: data.unreadMessages,
    streakEvent: data.streakEvent,
    isFreshLogin: true
  });
}

function initModalClosers() {
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeModal)?.classList.add('hidden');
    });
  });
}

function initAuthHandlers() {
  const tabs = document.querySelectorAll('[data-auth-tab]');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      clearAuthAlert();
      tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.authTab;
      loginForm.classList.toggle('hidden', target !== 'login');
      registerForm.classList.toggle('hidden', target !== 'register');
      recoverPanel.classList.toggle('hidden', target !== 'recover');
    });
  });

  regRoleSelect.addEventListener('change', () => {
    regGroupWrap.classList.toggle('hidden', regRoleSelect.value === 'teacher');
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await performLogin(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
      );
    } catch (err) {
      showAuthAlert(err.message, 'error');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlert();
    try {
      const role = regRoleSelect.value;
      const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: {
          name: document.getElementById('reg-name').value,
          email: document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
          role,
          groupId: role === 'student' ? Number(regGroupSelect.value) : null
        }
      });
      setStoredToken(data.token);
      await enterAuthenticatedApp(data.user, {
        unreadMessages: 0,
        streakEvent: data.streakEvent,
        isFreshLogin: true
      });
    } catch (err) {
      showAuthAlert(err.message, 'error');
    }
  });

  document.getElementById('demo-student-btn').addEventListener('click', async () => {
    try {
      await performLogin('estudiante@upfim.edu.mx', 'Demo1234!');
    } catch (err) {
      showAuthAlert(err.message, 'error');
    }
  });

  document.getElementById('demo-teacher-btn').addEventListener('click', async () => {
    try {
      await performLogin('daniel.hernandez@upfim.edu.mx', 'Demo1234!');
    } catch (err) {
      showAuthAlert(err.message, 'error');
    }
  });

  document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlert();
    try {
      const res = await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: document.getElementById('forgot-email').value }
      });
      showAuthAlert(res.message, 'success');
      const inbox = document.getElementById('demo-inbox-box');
      if (res.demoInbox) {
        inbox.classList.remove('hidden');
        document.getElementById('demo-inbox-note').textContent = res.demoInbox.note;
        document.getElementById('demo-reset-token').textContent = res.demoInbox.resetToken;
        document.getElementById('reset-token-input').value = res.demoInbox.resetToken;
      }
    } catch (err) {
      showAuthAlert(err.message, 'error');
    }
  });

  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlert();
    try {
      const res = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: {
          token: document.getElementById('reset-token-input').value,
          newPassword: document.getElementById('reset-new-password').value
        }
      });
      showAuthAlert(res.message, 'success');
      document.getElementById('demo-inbox-box').classList.add('hidden');
    } catch (err) {
      showAuthAlert(err.message, 'error');
    }
  });
}

function initProfileAndTopbarHandlers() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignorar si ya expiró
    }
    setStoredToken('');
    switchToAuthScreen();
  });

  document.getElementById('open-tutorial-btn').addEventListener('click', () => {
    openTutorial(currentUser?.role || 'student');
  });

  document.getElementById('open-profile-btn').addEventListener('click', () => {
    if (!currentUser) return;
    profileAlert.classList.add('hidden');
    profName.value = currentUser.name;
    profEmail.value = currentUser.email;
    profAvatar.value = currentUser.avatarUrl || '';
    profGroupWrap.classList.toggle('hidden', currentUser.role !== 'student');
    if (currentUser.groupId) profGroup.value = String(currentUser.groupId);
    profileModal.classList.remove('hidden');
  });

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    profileAlert.classList.add('hidden');
    try {
      const res = await apiFetch('/api/profile', {
        method: 'PUT',
        body: {
          name: profName.value,
          email: profEmail.value,
          avatarUrl: profAvatar.value,
          groupId: currentUser.role === 'student' ? Number(profGroup.value) : null
        }
      });
      updateTopbarUser(res.user);
      profileModal.classList.add('hidden');
      if (res.user.role === 'student') await loadStudentTasks();
      showToast({ title: 'Perfil actualizado', body: 'Tus datos personales se guardaron correctamente.', variant: 'success', autoCloseMs: 5000 });
    } catch (err) {
      profileAlert.className = 'alert error';
      profileAlert.textContent = err.message;
      profileAlert.classList.remove('hidden');
    }
  });
}

async function bootstrap() {
  window.addEventListener('online', () => networkBanner.classList.add('hidden'));
  window.addEventListener('offline', () => networkBanner.classList.remove('hidden'));
  if (!navigator.onLine) networkBanner.classList.remove('hidden');

  setOnSessionExpired((msg) => switchToAuthScreen(msg));
  setStreakUserUpdateCallback((user) => updateTopbarUser(user));

  initModalClosers();
  initAuthHandlers();
  initProfileAndTopbarHandlers();
  initTutorialHandlers();
  initStreakHandlers();
  initPomodoroTimer();
  initAssistantHandlers();
  initChatHandlers();
  initStudentHandlers();
  initTeacherHandlers();

  await loadGroupsCatalog();

  const token = getStoredToken();
  if (token) {
    try {
      const data = await apiFetch('/api/auth/me');
      await enterAuthenticatedApp(data.user, { unreadMessages: data.unreadMessages, isFreshLogin: false });
      return;
    } catch {
      setStoredToken('');
    }
  }
  switchToAuthScreen();
}

bootstrap();
