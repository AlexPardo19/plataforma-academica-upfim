import { showToast } from './notifications.js';

const STORAGE_KEY = 'upfim_pomodoro_state';

const displayEl = document.getElementById('timer-display');
const taskLabelEl = document.getElementById('timer-task-label');
const startBtn = document.getElementById('timer-start-btn');
const pauseBtn = document.getElementById('timer-pause-btn');
const resetBtn = document.getElementById('timer-reset-btn');

let intervalId = null;
let state = {
  durationMs: 25 * 60 * 1000,
  remainingMs: 25 * 60 * 1000,
  running: false,
  targetEndMs: null,
  taskTitle: ''
};

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && typeof raw.remainingMs === 'number') {
      state = { ...state, ...raw };
      if (state.running && state.targetEndMs) {
        const diff = state.targetEndMs - Date.now();
        if (diff <= 0) {
          state.running = false;
          state.remainingMs = state.durationMs;
          state.targetEndMs = null;
        } else {
          state.remainingMs = diff;
        }
      }
    }
  } catch {
    // Ignorar estado corrupto
  }
}

function renderTimer() {
  const currentMs = state.running && state.targetEndMs
    ? Math.max(0, state.targetEndMs - Date.now())
    : state.remainingMs;

  const totalSec = Math.ceil(currentMs / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  displayEl.textContent = `${mins}:${secs}`;

  taskLabelEl.textContent = state.taskTitle
    ? `Enfocado en: ${state.taskTitle}`
    : 'Selecciona "Enfocar" en una tarea o inicia un bloque libre.';

  if (state.running) {
    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
  } else {
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
  }
}

function tick() {
  if (!state.running || !state.targetEndMs) return;
  const left = state.targetEndMs - Date.now();
  if (left <= 0) {
    clearInterval(intervalId);
    intervalId = null;
    state.running = false;
    state.targetEndMs = null;
    state.remainingMs = state.durationMs;
    saveState();
    renderTimer();
    showToast({
      title: '⏱️ Bloque de concentración completado',
      body: state.taskTitle
        ? `Terminaste tu sesión de enfoque en "${state.taskTitle}". ¡Toma un breve descanso!`
        : 'Finalizó tu temporizador de estudio.',
      variant: 'success',
      autoCloseMs: 10000
    });
    return;
  }
  renderTimer();
}

function ensureLoop() {
  if (intervalId) clearInterval(intervalId);
  if (state.running) {
    intervalId = setInterval(tick, 500);
  }
}

export function focusTaskInTimer(title) {
  state.taskTitle = title;
  state.running = false;
  state.targetEndMs = null;
  state.durationMs = 25 * 60 * 1000;
  state.remainingMs = state.durationMs;
  saveState();
  renderTimer();
}

export function initPomodoroTimer() {
  loadState();
  renderTimer();
  ensureLoop();

  document.querySelectorAll('[data-timer-mins]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = Number(btn.dataset.timerMins);
      state.running = false;
      state.targetEndMs = null;
      state.durationMs = mins * 60 * 1000;
      state.remainingMs = state.durationMs;
      saveState();
      ensureLoop();
      renderTimer();
    });
  });

  startBtn.addEventListener('click', () => {
    state.running = true;
    state.targetEndMs = Date.now() + state.remainingMs;
    saveState();
    ensureLoop();
    renderTimer();
  });

  pauseBtn.addEventListener('click', () => {
    if (state.running && state.targetEndMs) {
      state.remainingMs = Math.max(0, state.targetEndMs - Date.now());
    }
    state.running = false;
    state.targetEndMs = null;
    saveState();
    ensureLoop();
    renderTimer();
  });

  resetBtn.addEventListener('click', () => {
    state.running = false;
    state.targetEndMs = null;
    state.remainingMs = state.durationMs;
    saveState();
    ensureLoop();
    renderTimer();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}
