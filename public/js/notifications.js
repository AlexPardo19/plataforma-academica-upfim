import { apiFetch, escapeHtml, getLocalDateStr, getLocalDateTimeStr } from './api.js';
import { iconSvg } from './icons.js';

const toastStack = document.getElementById('toast-stack');
const shownIdsThisRun = new Set();

const VARIANT_ICON = {
  info: 'info',
  success: 'checkCircle',
  warning: 'clock',
  danger: 'alert'
};

export function showToast({ title, body, variant = 'info', icon = '', autoCloseMs = 10000, actions = [] }) {
  const iconName = icon || VARIANT_ICON[variant] || 'info';
  const card = document.createElement('div');
  card.className = `toast-card ${variant}`;
  card.innerHTML = `
    <span class="toast-icon-badge">${iconSvg(iconName, { size: 16 })}</span>
    <div class="toast-content">
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(body)}</p>
      <div class="toast-actions"></div>
    </div>
  `;

  const actionsEl = card.querySelector('.toast-actions');
  for (const act of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn small ${act.style || 'ghost'}`;
    btn.textContent = act.label;
    btn.addEventListener('click', async () => {
      if (act.onClick) await act.onClick();
      card.remove();
    });
    actionsEl.appendChild(btn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn small ghost';
  closeBtn.textContent = 'Cerrar';
  closeBtn.addEventListener('click', () => card.remove());
  actionsEl.appendChild(closeBtn);

  toastStack.appendChild(card);

  if (autoCloseMs > 0) {
    setTimeout(() => {
      if (card.isConnected) card.remove();
    }, autoCloseMs);
  }
}

function localDateTimeToEpochMinutes(localDt) {
  const m = String(localDt || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Math.floor(utcMs / 60000);
}

/**
 * Evalúa tareas próximas a vencer (< 2 horas), tareas vencidas pendientes y resumen del día (HU-25, HU-27, HU-28).
 */
export function evaluateTaskAlerts(tasks, isLoginSummary = false, serverNowLocal = '') {
  const today = getLocalDateStr();
  const nowLocal = serverNowLocal || getLocalDateTimeStr();
  const nowEpochMin = localDateTimeToEpochMinutes(nowLocal);
  const nowMs = Date.now();

  const pendingToday = tasks.filter((t) => !t.completed && t.due_at.startsWith(today));
  const overdueTasks = tasks.filter((t) => !t.completed && t.due_at < nowLocal);

  if (isLoginSummary && pendingToday.length > 0) {
    showToast({
      title: `Resumen de hoy (${pendingToday.length} entregas)`,
      body: `Tienes ${pendingToday.length} ${pendingToday.length === 1 ? 'tarea pendiente programada' : 'tareas pendientes programadas'} para hoy.`,
      variant: 'info',
      icon: 'calendar',
      autoCloseMs: 10000
    });
  }

  if (isLoginSummary && overdueTasks.length > 0) {
    showToast({
      title: `${overdueTasks.length} ${overdueTasks.length === 1 ? 'tarea vencida sin entregar' : 'tareas vencidas sin entregar'}`,
      body: 'Revisa las tarjetas marcadas como vencidas para regularizar tus actividades pendientes.',
      variant: 'danger',
      icon: 'alert',
      autoCloseMs: 11000
    });
  }

  for (const task of tasks) {
    if (task.completed) continue;
    if (task.dismissed_date === today) continue;
    if (task.snoozed_until && nowMs < task.snoozed_until) continue;
    if (shownIdsThisRun.has(task.id)) continue;

    const dueEpochMin = localDateTimeToEpochMinutes(task.due_at);
    if (Number.isNaN(dueEpochMin) || Number.isNaN(nowEpochMin)) continue;
    const minsLeft = dueEpochMin - nowEpochMin;

    // Aviso si vence dentro de las próximas 2 horas (HU-25 Escenario 1)
    if (minsLeft > 0 && minsLeft <= 120) {
      shownIdsThisRun.add(task.id);
      showToast({
        title: `Vence pronto: ${task.title}`,
        body: `${task.subject_name} · Entrega límite a las ${task.due_at.slice(11, 16)} (faltan ~${minsLeft} min).`,
        variant: 'warning',
        icon: 'clock',
        autoCloseMs: 10000,
        actions: [
          {
            label: 'Posponer 1 hr',
            style: 'secondary',
            onClick: async () => {
              await apiFetch(`/api/tasks/${task.id}/notification`, {
                method: 'POST',
                body: { action: 'snooze' }
              });
            }
          },
          {
            label: 'Entendido',
            style: 'primary',
            onClick: async () => {
              await apiFetch(`/api/tasks/${task.id}/notification`, {
                method: 'POST',
                body: { action: 'dismiss' }
              });
            }
          }
        ]
      });
    }
  }
}

export function resetShownAlerts() {
  shownIdsThisRun.clear();
}
