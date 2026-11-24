import { apiFetch, escapeHtml, getLocalDateStr } from './api.js';

const toastStack = document.getElementById('toast-stack');
const shownIdsThisRun = new Set();

export function showToast({ title, body, variant = 'info', autoCloseMs = 10000, actions = [] }) {
  const card = document.createElement('div');
  card.className = `toast-card ${variant}`;
  card.innerHTML = `
    <h4>${escapeHtml(title)}</h4>
    <p>${escapeHtml(body)}</p>
    <div class="toast-actions"></div>
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

/**
 * Evalúa tareas próximas a vencer (< 2 horas) y resumen del día al iniciar sesión (HU-25, HU-27, HU-28).
 */
export function evaluateTaskAlerts(tasks, isLoginSummary = false) {
  const today = getLocalDateStr();
  const nowMs = Date.now();
  const pendingToday = tasks.filter((t) => !t.completed && t.due_at.startsWith(today));

  if (isLoginSummary && pendingToday.length > 0) {
    showToast({
      title: `Resumen de hoy (${pendingToday.length} entregas)`,
      body: `Tienes ${pendingToday.length} ${pendingToday.length === 1 ? 'tarea pendiente programada' : 'tareas pendientes programadas'} para hoy. ¡Mantén tu racha activa!`,
      variant: 'info',
      autoCloseMs: 10000
    });
  }

  for (const task of tasks) {
    if (task.completed) continue;
    if (task.dismissed_date === today) continue;
    if (task.snoozed_until && nowMs < task.snoozed_until) continue;
    if (shownIdsThisRun.has(task.id)) continue;

    const dueMs = new Date(task.due_at).getTime();
    if (Number.isNaN(dueMs)) continue;
    const diffMs = dueMs - nowMs;

    // Aviso si vence dentro de las próximas 2 horas (HU-25 Escenario 1)
    if (diffMs > 0 && diffMs <= 2 * 60 * 60 * 1000) {
      shownIdsThisRun.add(task.id);
      const minsLeft = Math.max(1, Math.round(diffMs / 60000));
      showToast({
        title: `⏰ Vence pronto: ${task.title}`,
        body: `${task.subject_name} · Entrega límite a las ${task.due_at.slice(11, 16)} (faltan ~${minsLeft} min).`,
        variant: 'warning',
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
            label: 'Entendido / Descartar',
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
