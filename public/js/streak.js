import { apiFetch, escapeHtml } from './api.js';
import { iconSvg } from './icons.js';

const THEME_ICON_BY_ID = {
  classic: 'flame',
  emerald: 'leaf',
  violet: 'zap',
  arctic: 'snowflake',
  golden: 'crown',
  cosmic: 'sparkles'
};

function resolveThemeIcon(theme) {
  return THEME_ICON_BY_ID[theme?.id] || theme?.icon || 'flame';
}

let cachedStreak = null;
let previewThemeId = 'classic';
let onUserUpdated = () => {};

const widgetWrap = document.getElementById('streak-widget-wrap');
const pillBtn = document.getElementById('streak-pill-btn');
const pillIcon = document.getElementById('streak-pill-icon');
const pillText = document.getElementById('streak-pill-text');
const pillPts = document.getElementById('streak-pill-pts');
const popover = document.getElementById('streak-popover');
const popThemeName = document.getElementById('popover-theme-name');
const popThemeBadge = document.getElementById('popover-theme-badge');
const popDays = document.getElementById('pop-streak-days');
const popBest = document.getElementById('pop-best-streak');
const popPts = document.getElementById('pop-streak-points');
const openCustomBtn = document.getElementById('open-streak-customizer-btn');

const streakModal = document.getElementById('streak-modal');
const livePreview = document.getElementById('streak-live-preview');
const themeAlert = document.getElementById('streak-theme-alert');
const themesGrid = document.getElementById('streak-themes-grid');
const saveThemeBtn = document.getElementById('save-streak-theme-btn');

export function setStreakUserUpdateCallback(cb) {
  onUserUpdated = cb;
}

export async function refreshStreakWidget() {
  try {
    const data = await apiFetch('/api/streak');
    cachedStreak = data;
    const activeTheme = data.themes.find((t) => t.id === data.streakTheme) || data.themes[0];

    widgetWrap.classList.remove('hidden');
    pillBtn.style.background = activeTheme.gradient;
    pillIcon.innerHTML = iconSvg(resolveThemeIcon(activeTheme), { size: 15 });
    pillText.textContent = `${data.streakDays} ${data.streakDays === 1 ? 'Día' : 'Días'}`;
    pillPts.textContent = `${data.streakPoints} pts`;

    popThemeName.textContent = activeTheme.name;
    popThemeBadge.textContent = activeTheme.badgeLabel;
    popDays.textContent = `${data.streakDays} días`;
    popBest.textContent = `${data.bestStreak} días`;
    popPts.textContent = `${data.streakPoints} pts`;
  } catch {
    // Silencioso si no aplica al rol
  }
}

function renderPreview(themeId) {
  if (!cachedStreak) return;
  const theme = cachedStreak.themes.find((t) => t.id === themeId) || cachedStreak.themes[0];
  livePreview.style.background = theme.gradient;
  livePreview.innerHTML = `${iconSvg(resolveThemeIcon(theme), { size: 17 })}<span>${Number(cachedStreak.streakDays)} Días · ${Number(cachedStreak.streakPoints)} pts (${escapeHtml(theme.name)})</span>`;
}

function renderThemesModal() {
  if (!cachedStreak) return;
  themeAlert.classList.add('hidden');
  renderPreview(previewThemeId);

  themesGrid.innerHTML = cachedStreak.themes
    .map((theme) => {
      const selectedClass = theme.id === previewThemeId ? 'selected' : '';
      const lockedClass = theme.unlocked ? '' : 'locked';
      const statusText = theme.unlocked
        ? 'Disponible'
        : `Requiere ${theme.minDays} días (faltan ${theme.missingDays})`;
      return `
        <button type="button" class="theme-card ${selectedClass} ${lockedClass}" data-theme-id="${escapeHtml(theme.id)}">
          <div class="theme-swatch" style="background: ${theme.gradient}">
            ${iconSvg(resolveThemeIcon(theme), { size: 14 })}
            <span>${escapeHtml(theme.badgeLabel)}</span>
          </div>
          <strong style="font-size:0.86rem;">${escapeHtml(theme.name)}</strong>
          <div class="small-text muted" style="margin-top:2px;">${escapeHtml(statusText)}</div>
        </button>
      `;
    })
    .join('');

  themesGrid.querySelectorAll('.theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.themeId;
      const chosen = cachedStreak.themes.find((t) => t.id === id);
      previewThemeId = id;
      renderThemesModal();
      if (chosen && !chosen.unlocked) {
        themeAlert.className = 'alert error';
        themeAlert.textContent = `Te faltan ${chosen.missingDays} días consecutivos de racha para desbloquear "${chosen.name}".`;
        themeAlert.classList.remove('hidden');
      }
    });
  });
}

export function initStreakHandlers() {
  pillBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!widgetWrap.contains(e.target)) {
      popover.classList.add('hidden');
    }
  });

  openCustomBtn.addEventListener('click', async () => {
    popover.classList.add('hidden');
    await refreshStreakWidget();
    if (!cachedStreak) return;
    previewThemeId = cachedStreak.streakTheme || 'classic';
    renderThemesModal();
    streakModal.classList.remove('hidden');
  });

  saveThemeBtn.addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/streak/theme', {
        method: 'PUT',
        body: { themeId: previewThemeId }
      });
      streakModal.classList.add('hidden');
      await refreshStreakWidget();
      onUserUpdated(res.user);
    } catch (err) {
      themeAlert.className = 'alert error';
      themeAlert.textContent = err.message;
      themeAlert.classList.remove('hidden');
    }
  });
}
