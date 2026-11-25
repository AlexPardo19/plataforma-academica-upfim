import {
  addDaysToDateStr,
  apiFetch,
  escapeHtml,
  formatShortDate,
  getLocalDateStr,
  getLocalDateTimeStr,
  getMondayOfWeek,
  sanitizeHexColor
} from './api.js';
import { iconSvg } from './icons.js';
import { evaluateTaskAlerts, showToast } from './notifications.js';
import { refreshStreakWidget } from './streak.js';
import { focusTaskInTimer } from './timer.js';
import { closeAllPopovers, enhanceColorPicker, initSubjectCombobox } from './ui.js';

const WEEKDAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const PRIORITY_META = {
  high: { label: 'Alta', cls: 'prio-high' },
  medium: { label: 'Media', cls: 'prio-medium' },
  low: { label: 'Baja', cls: 'prio-low' }
};

let viewMode = 'weekly'; // weekly | daily | history
let weekStart = getMondayOfWeek(getLocalDateStr());
let selectedDay = getLocalDateStr();
let filterSubject = 'ALL';
let searchTerm = '';
let sortOrder = 'due_at';
let historyMonth = '';
let cachedTasks = [];
let serverNowLocal = '';
let pendingDeleteId = null;

const tasksContainer = document.getElementById('tasks-container');
const pendingCounterPill = document.getElementById('pending-counter-pill');
const pendingBadge = document.getElementById('pending-badge');
const subjectFilterSelect = document.getElementById('subject-filter-select');
const searchInput = document.getElementById('task-search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const sortSelect = document.getElementById('sort-select');
const weekNav = document.getElementById('week-nav');
const weekRangeLabel = document.getElementById('week-range-label');
const historyMonthWrap = document.getElementById('history-month-wrap');
const historyMonthInput = document.getElementById('history-month-input');

// Modal Tarea
const taskModal = document.getElementById('task-modal');
const taskModalTitle = document.getElementById('task-modal-title');
const taskForm = document.getElementById('task-form');
const taskFormError = document.getElementById('task-form-error');
const editIdInput = document.getElementById('task-edit-id');
const titleInput = document.getElementById('task-title-input');
const subjectInput = document.getElementById('task-subject-input');
const colorInput = document.getElementById('task-color-input');
const dueInput = document.getElementById('task-due-input');
const priorityInput = document.getElementById('task-priority-input');
const descInput = document.getElementById('task-desc-input');

// Modal Confirmación Borrado
const deleteModal = document.getElementById('delete-modal');
const deleteTaskName = document.getElementById('delete-task-name');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

let knownSubjects = [];

async function loadStudentSubjects() {
  const res = await apiFetch('/api/subjects/student');
  knownSubjects = res.subjects || [];

  const currentVal = subjectFilterSelect.value || 'ALL';
  subjectFilterSelect.innerHTML =
    '<option value="ALL">Todas las materias</option>' +
    knownSubjects
      .map(
        (s) =>
          `<option value="${escapeHtml(s.name)}" data-dot-color="${sanitizeHexColor(s.color)}">${escapeHtml(s.name)}</option>`
      )
      .join('');
  subjectFilterSelect.value = knownSubjects.some((s) => s.name === currentVal) ? currentVal : 'ALL';
}

function renderTaskCard(task) {
  const prio = PRIORITY_META[task.priority] || PRIORITY_META.medium;
  const safeColor = sanitizeHexColor(task.subject_color);
  const dueTime = task.due_at.slice(11, 16);
  const dueDate = task.due_at.slice(0, 10);
  const hasNotes = Boolean(task.description && task.description.trim());
  const nowRef = serverNowLocal || getLocalDateTimeStr();
  const isOverdue = !task.completed && task.due_at < nowRef;

  return `
    <article class="task-card ${task.completed ? 'completed' : ''} ${isOverdue ? 'overdue' : ''}" style="border-left-color:${safeColor}" data-task-id="${task.id}">
      <div class="task-top">
        <input type="checkbox" class="task-check" ${task.completed ? 'checked' : ''} data-toggle-task="${task.id}" aria-label="Marcar como completada" />
        <div class="task-title">${escapeHtml(task.title)}</div>
      </div>
      <div class="task-badges">
        <button type="button" class="subject-tag" style="background:${safeColor}" data-filter-subject="${escapeHtml(task.subject_name)}">
          ${escapeHtml(task.subject_name)}
        </button>
        <span class="prio-tag ${prio.cls}">${prio.label}</span>
        ${isOverdue ? `<span class="prio-tag prio-overdue">${iconSvg('alert', { size: 11 })}<span>Vencida</span></span>` : ''}
      </div>
      <div class="task-meta">
        <span class="task-meta-time">${iconSvg('clock', { size: 13 })}<span>${escapeHtml(dueDate)} · ${escapeHtml(dueTime)}</span></span>
        ${task.points_awarded > 0 ? `<span class="task-pts-pill">+${Number(task.points_awarded)} pts</span>` : ''}
      </div>
      ${
        hasNotes
          ? `<div class="task-notes hidden" id="notes-${task.id}">${escapeHtml(task.description)}</div>`
          : ''
      }
      <div class="task-actions">
        ${hasNotes ? `<button type="button" class="mini-action" data-expand-notes="${task.id}">${iconSvg('notes', { size: 12 })}<span>Notas</span></button>` : ''}
        ${!task.completed ? `<button type="button" class="mini-action" data-focus-task="${task.id}">${iconSvg('play', { size: 11 })}<span>Enfocar</span></button>` : ''}
        <button type="button" class="mini-action" data-edit-task="${task.id}">${iconSvg('edit', { size: 12 })}<span>Editar</span></button>
        <button type="button" class="mini-action del" data-delete-task="${task.id}">${iconSvg('trash', { size: 12 })}<span>Eliminar</span></button>
      </div>
    </article>
  `;
}

function attachCardEvents() {
  tasksContainer.querySelectorAll('[data-toggle-task]').forEach((chk) => {
    chk.addEventListener('change', async () => {
      const id = Number(chk.dataset.toggleTask);
      try {
        const res = await apiFetch(`/api/tasks/${id}/toggle`, { method: 'PATCH' });
        await refreshStreakWidget();
        if (res.pointsDelta > 0) {
          showToast({
            title: 'Entrega a tiempo',
            body: `Sumaste +${res.pointsDelta} puntos de racha (Total: ${res.streakPoints} pts).`,
            variant: 'success',
            icon: 'award',
            autoCloseMs: 6000
          });
        }
        await loadStudentTasks();
      } catch (err) {
        showToast({ title: 'Error al actualizar tarea', body: err.message, variant: 'danger', autoCloseMs: 6000 });
        await loadStudentTasks();
      }
    });
  });

  tasksContainer.querySelectorAll('[data-filter-subject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filterSubject = btn.dataset.filterSubject;
      subjectFilterSelect.value = filterSubject;
      loadStudentTasks();
    });
  });

  tasksContainer.querySelectorAll('[data-expand-notes]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(`notes-${btn.dataset.expandNotes}`)?.classList.toggle('hidden');
    });
  });

  tasksContainer.querySelectorAll('[data-focus-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = cachedTasks.find((t) => t.id === Number(btn.dataset.focusTask));
      if (task) focusTaskInTimer(task.title);
    });
  });

  tasksContainer.querySelectorAll('[data-edit-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = cachedTasks.find((t) => t.id === Number(btn.dataset.editTask));
      if (task) openTaskModal(task);
    });
  });

  tasksContainer.querySelectorAll('[data-delete-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = cachedTasks.find((t) => t.id === Number(btn.dataset.deleteTask));
      if (!task) return;
      pendingDeleteId = task.id;
      deleteTaskName.textContent = `"${task.title}"`;
      deleteModal.classList.remove('hidden');
    });
  });
}

function renderTasksView() {
  const today = getLocalDateStr();

  if (searchTerm && cachedTasks.length === 0) {
    tasksContainer.innerHTML = `<div class="empty-state">No se encontraron tareas con esa palabra clave ("${escapeHtml(searchTerm)}").</div>`;
    return;
  }

  if (viewMode === 'history') {
    const completed = cachedTasks.filter((t) => t.completed);
    if (completed.length === 0) {
      tasksContainer.innerHTML = '<div class="empty-state">Aún no hay tareas completadas en el periodo seleccionado.</div>';
      return;
    }
    tasksContainer.innerHTML = `<div class="cards-3">${completed.map(renderTaskCard).join('')}</div>`;
    attachCardEvents();
    return;
  }

  if (viewMode === 'daily') {
    const dayTasks = cachedTasks.filter((t) => t.due_at.startsWith(selectedDay));
    tasksContainer.innerHTML = `
      <div class="card" style="padding:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
          <h3 style="margin:0; font-size:1.05rem;">Vista diaria — ${escapeHtml(selectedDay)}</h3>
          <input type="date" id="daily-date-picker" value="${escapeHtml(selectedDay)}" style="width:auto;" />
        </div>
        ${
          dayTasks.length === 0
            ? '<div class="empty-state">No tienes tareas programadas para este día.</div>'
            : `<div class="cards-3">${dayTasks.map(renderTaskCard).join('')}</div>`
        }
      </div>
    `;
    document.getElementById('daily-date-picker').addEventListener('change', (e) => {
      if (e.target.value) {
        selectedDay = e.target.value;
        renderTasksView();
      }
    });
    attachCardEvents();
    return;
  }

  // Vista Semanal (7 columnas de Lunes a Domingo - HU-19)
  const endOfWeek = addDaysToDateStr(weekStart, 6);
  weekRangeLabel.textContent = `${formatShortDate(weekStart)} – ${formatShortDate(endOfWeek)}`;

  const colsHtml = Array.from({ length: 7 }, (_, i) => {
    const dateStr = addDaysToDateStr(weekStart, i);
    const isToday = dateStr === today;
    const dayTasks = cachedTasks.filter((t) => t.due_at.startsWith(dateStr));
    return `
      <div class="day-col ${isToday ? 'is-today' : ''}">
        <div class="day-header">
          <strong>${WEEKDAY_NAMES[i]}${isToday ? ' · Hoy' : ''}</strong>
          <small>${formatShortDate(dateStr)}</small>
        </div>
        ${
          dayTasks.length === 0
            ? '<div class="small-text muted" style="padding:8px 2px;">Sin entregas</div>'
            : dayTasks.map(renderTaskCard).join('')
        }
      </div>
    `;
  }).join('');

  tasksContainer.innerHTML = `<div class="weekly-grid">${colsHtml}</div>`;
  attachCardEvents();
}

export async function loadStudentTasks(isLoginSummary = false) {
  await loadStudentSubjects();
  const params = new URLSearchParams();
  if (filterSubject && filterSubject !== 'ALL') params.set('subject', filterSubject);
  if (searchTerm) params.set('search', searchTerm);
  params.set('sort', sortOrder);
  if (viewMode === 'history') {
    params.set('status', 'completed');
    if (historyMonth) params.set('month', historyMonth);
  }

  const data = await apiFetch(`/api/tasks?${params.toString()}`);
  cachedTasks = data.tasks || [];
  serverNowLocal = data.nowLocal || getLocalDateTimeStr();
  pendingCounterPill.classList.remove('hidden');
  pendingBadge.textContent = String(data.pendingCount ?? 0);

  renderTasksView();

  if (filterSubject === 'ALL' && !searchTerm && viewMode !== 'history') {
    evaluateTaskAlerts(cachedTasks, isLoginSummary, serverNowLocal);
  }
}

function openTaskModal(task = null) {
  taskFormError.classList.add('hidden');
  titleInput.classList.remove('field-invalid');
  subjectInput.classList.remove('field-invalid');
  dueInput.classList.remove('field-invalid');

  if (task) {
    taskModalTitle.textContent = 'Editar tarea académica';
    editIdInput.value = String(task.id);
    titleInput.value = task.title;
    subjectInput.value = task.subject_name;
    colorInput.value = sanitizeHexColor(task.subject_color);
    dueInput.value = task.due_at;
    priorityInput.value = task.priority;
    descInput.value = task.description || '';
    dueInput.disabled = Boolean(task.completed);
    priorityInput.disabled = Boolean(task.completed);
  } else {
    taskModalTitle.textContent = 'Nueva tarea académica';
    editIdInput.value = '';
    titleInput.value = '';
    subjectInput.value = knownSubjects[0]?.name || '';
    colorInput.value = sanitizeHexColor(knownSubjects[0]?.color);
    dueInput.value = `${getLocalDateStr()}T23:59`;
    priorityInput.value = 'medium';
    descInput.value = '';
    dueInput.disabled = false;
    priorityInput.disabled = false;
  }

  taskModal.classList.remove('hidden');
  titleInput.focus();
}

export function initStudentHandlers() {
  enhanceColorPicker(colorInput);
  initSubjectCombobox(
    subjectInput,
    () => knownSubjects,
    (chosen) => {
      if (chosen?.color) {
        colorInput.value = sanitizeHexColor(chosen.color);
      }
    }
  );

  document.getElementById('new-task-btn').addEventListener('click', () => openTaskModal());

  subjectInput.addEventListener('input', () => {
    const match = knownSubjects.find((s) => s.name.toLowerCase() === subjectInput.value.trim().toLowerCase());
    if (match) colorInput.value = sanitizeHexColor(match.color);
  });

  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    taskFormError.classList.add('hidden');
    titleInput.classList.remove('field-invalid');
    subjectInput.classList.remove('field-invalid');
    dueInput.classList.remove('field-invalid');

    const title = titleInput.value.trim();
    const subjectName = subjectInput.value.trim();
    const dueAt = dueInput.value.trim();

    let missing = false;
    if (!title) {
      titleInput.classList.add('field-invalid');
      missing = true;
    }
    if (!subjectName) {
      subjectInput.classList.add('field-invalid');
      missing = true;
    }
    if (!dueAt) {
      dueInput.classList.add('field-invalid');
      missing = true;
    }
    if (missing) {
      taskFormError.textContent = 'Completa los campos obligatorios marcados en rojo.';
      taskFormError.classList.remove('hidden');
      return;
    }

    const payload = {
      title,
      subjectName,
      subjectColor: sanitizeHexColor(colorInput.value),
      dueAt,
      priority: priorityInput.value,
      description: descInput.value.trim()
    };

    try {
      const editId = editIdInput.value;
      if (editId) {
        await apiFetch(`/api/tasks/${editId}`, { method: 'PUT', body: payload });
      } else {
        await apiFetch('/api/tasks', { method: 'POST', body: payload });
      }
      closeAllPopovers();
      taskModal.classList.add('hidden');
      await loadStudentTasks();
    } catch (err) {
      taskFormError.textContent = err.message;
      taskFormError.classList.remove('hidden');
    }
  });

  confirmDeleteBtn.addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    const res = await apiFetch(`/api/tasks/${pendingDeleteId}`, { method: 'DELETE' });
    pendingDeleteId = null;
    deleteModal.classList.add('hidden');
    if (res.revertedPoints > 0) {
      await refreshStreakWidget();
      showToast({
        title: 'Puntos ajustados',
        body: `Se descontaron -${res.revertedPoints} pts asociados a la entrega de hoy eliminada.`,
        variant: 'info',
        autoCloseMs: 6000
      });
    }
    await loadStudentTasks();
  });

  subjectFilterSelect.addEventListener('change', () => {
    filterSubject = subjectFilterSelect.value;
    loadStudentTasks();
  });

  sortSelect.addEventListener('change', () => {
    sortOrder = sortSelect.value;
    loadStudentTasks();
  });

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.trim();
    clearSearchBtn.classList.toggle('hidden', !searchTerm);
    loadStudentTasks();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchTerm = '';
    clearSearchBtn.classList.add('hidden');
    loadStudentTasks();
  });

  document.querySelectorAll('[data-view-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeAllPopovers();
      document.querySelectorAll('[data-view-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      viewMode = btn.dataset.viewMode;
      weekNav.classList.toggle('hidden', viewMode !== 'weekly');
      historyMonthWrap.classList.toggle('hidden', viewMode !== 'history');
      loadStudentTasks();
    });
  });

  document.getElementById('prev-week-btn').addEventListener('click', () => {
    weekStart = addDaysToDateStr(weekStart, -7);
    renderTasksView();
  });

  document.getElementById('next-week-btn').addEventListener('click', () => {
    weekStart = addDaysToDateStr(weekStart, 7);
    renderTasksView();
  });

  document.getElementById('today-week-btn').addEventListener('click', () => {
    weekStart = getMondayOfWeek(getLocalDateStr());
    renderTasksView();
  });

  historyMonthInput.addEventListener('change', () => {
    historyMonth = historyMonthInput.value;
    loadStudentTasks();
  });
}
