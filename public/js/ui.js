import { escapeHtml, sanitizeHexColor } from './api.js';
import { iconSvg } from './icons.js';

export const ACADEMIC_PALETTE = [
  { hex: '#4f46e5', name: 'Índigo' },
  { hex: '#0d9488', name: 'Turquesa' },
  { hex: '#0284c7', name: 'Azul' },
  { hex: '#7c3aed', name: 'Violeta' },
  { hex: '#db2777', name: 'Magenta' },
  { hex: '#059669', name: 'Esmeralda' },
  { hex: '#d97706', name: 'Ámbar' },
  { hex: '#ea580c', name: 'Coral' },
  { hex: '#dc2626', name: 'Carmesí' },
  { hex: '#334155', name: 'Pizarra' }
];

let activePopover = null;

function closeActivePopover() {
  if (!activePopover) return;
  const { el, trigger, onClose } = activePopover;
  activePopover = null;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-open');
  }
  if (el && el.parentNode) {
    el.remove();
  }
  if (onClose) onClose();
}

function positionFloatingMenu(menuEl, anchorEl, { minWidthMatch = true } = {}) {
  const rect = anchorEl.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  if (minWidthMatch) {
    menuEl.style.minWidth = `${Math.max(170, Math.round(rect.width))}px`;
  }

  // Medir altura real después de insertar en el DOM
  const menuRect = menuEl.getBoundingClientRect();
  const spaceBelow = viewportH - rect.bottom - 12;
  const spaceAbove = rect.top - 12;

  let top = rect.bottom + 6;
  if (spaceBelow < Math.min(menuRect.height, 240) && spaceAbove > spaceBelow) {
    const targetH = Math.min(menuRect.height, spaceAbove - 6, 280);
    menuEl.style.maxHeight = `${targetH}px`;
    top = Math.max(8, rect.top - targetH - 6);
  } else {
    menuEl.style.maxHeight = `${Math.min(280, Math.max(140, spaceBelow))}px`;
  }

  let left = rect.left;
  if (left + menuRect.width > viewportW - 10) {
    left = Math.max(10, viewportW - menuRect.width - 10);
  }

  menuEl.style.top = `${Math.round(top)}px`;
  menuEl.style.left = `${Math.round(left)}px`;
}

function registerGlobalPopoverListeners() {
  if (window.__upfimUiBound) return;
  window.__upfimUiBound = true;

  document.addEventListener('mousedown', (e) => {
    if (!activePopover) return;
    if (activePopover.el.contains(e.target) || activePopover.anchor.contains(e.target)) return;
    closeActivePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePopover) {
      e.stopPropagation();
      const trigger = activePopover.trigger;
      closeActivePopover();
      trigger?.focus();
    }
  });

  window.addEventListener(
    'scroll',
    (e) => {
      if (!activePopover) return;
      if (activePopover.el.contains(e.target)) return;
      positionFloatingMenu(activePopover.el, activePopover.anchor, activePopover.posOpts);
    },
    true
  );

  window.addEventListener('resize', () => {
    if (activePopover) closeActivePopover();
  });
}

function interceptInputProperty(el, proto, propName, onAfterSet) {
  const desc = Object.getOwnPropertyDescriptor(proto, propName);
  if (!desc || !desc.get || !desc.set) return;
  Object.defineProperty(el, propName, {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return desc.get.call(this);
    },
    set(val) {
      desc.set.call(this, val);
      onAfterSet();
    }
  });
}

/**
 * Reemplaza el menú desplegable nativo de macOS (<select>) por un componente web propio,
 * manteniendo sincronización reactiva con .value, .innerHTML, .disabled y eventos 'change'.
 */
export function enhanceSelect(selectEl) {
  if (!selectEl || selectEl.dataset.uiEnhanced === '1') return;
  registerGlobalPopoverListeners();
  selectEl.dataset.uiEnhanced = '1';

  const wrapper = document.createElement('div');
  wrapper.className = 'ui-select';
  if (selectEl.style.flex) wrapper.style.flex = selectEl.style.flex;
  if (selectEl.style.maxWidth) wrapper.style.maxWidth = selectEl.style.maxWidth;

  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);
  selectEl.classList.add('ui-sr-only');
  selectEl.tabIndex = -1;

  const leadingIcon = selectEl.dataset.selectIcon || '';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (selectEl.getAttribute('aria-label')) {
    trigger.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
  }
  wrapper.appendChild(trigger);

  function syncTrigger() {
    const selectedOpt = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
    const label = selectedOpt ? selectedOpt.textContent : 'Seleccionar';
    const dotColor = selectedOpt?.dataset?.dotColor ? sanitizeHexColor(selectedOpt.dataset.dotColor) : '';
    trigger.disabled = selectEl.disabled;
    wrapper.classList.toggle('is-disabled', selectEl.disabled);

    const leadHtml = leadingIcon
      ? `<span class="ui-select-lead">${iconSvg(leadingIcon, { size: 15 })}</span>`
      : dotColor
        ? `<span class="ui-dot" style="background:${dotColor}"></span>`
        : '';

    trigger.innerHTML = `
      <span class="ui-select-value">${leadHtml}<span class="ui-select-text">${escapeHtml(label)}</span></span>
      <span class="ui-select-chevron">${iconSvg('chevronDown', { size: 15 })}</span>
    `;
  }

  function openMenu() {
    if (selectEl.disabled) return;
    if (activePopover && activePopover.trigger === trigger) {
      closeActivePopover();
      return;
    }
    closeActivePopover();

    const menu = document.createElement('div');
    menu.className = 'ui-floating-menu';
    menu.setAttribute('role', 'listbox');

    const opts = Array.from(selectEl.options);
    let focusedIdx = Math.max(0, selectEl.selectedIndex);

    menu.innerHTML = opts
      .map((opt, idx) => {
        const isSelected = idx === selectEl.selectedIndex;
        const dotColor = opt.dataset.dotColor ? sanitizeHexColor(opt.dataset.dotColor) : '';
        const dotHtml = dotColor ? `<span class="ui-dot" style="background:${dotColor}"></span>` : '';
        return `
          <button type="button" role="option" class="ui-menu-option ${isSelected ? 'is-selected' : ''}" data-opt-idx="${idx}" aria-selected="${isSelected}">
            <span class="ui-menu-option-main">${dotHtml}<span>${escapeHtml(opt.textContent)}</span></span>
            <span class="ui-menu-check">${isSelected ? iconSvg('check', { size: 14 }) : ''}</span>
          </button>
        `;
      })
      .join('');

    document.body.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-open');

    const posOpts = { minWidthMatch: true };
    activePopover = { el: menu, anchor: trigger, trigger, posOpts };
    positionFloatingMenu(menu, trigger, posOpts);

    const optionButtons = Array.from(menu.querySelectorAll('.ui-menu-option'));
    optionButtons[focusedIdx]?.scrollIntoView({ block: 'nearest' });

    function chooseIndex(idx) {
      const targetOpt = opts[idx];
      if (!targetOpt) return;
      const changed = selectEl.value !== targetOpt.value;
      selectEl.selectedIndex = idx;
      syncTrigger();
      closeActivePopover();
      trigger.focus();
      if (changed) {
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    optionButtons.forEach((btn) => {
      btn.addEventListener('click', () => chooseIndex(Number(btn.dataset.optIdx)));
    });

    menu.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusedIdx = (focusedIdx + 1) % optionButtons.length;
        optionButtons[focusedIdx]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusedIdx = (focusedIdx - 1 + optionButtons.length) % optionButtons.length;
        optionButtons[focusedIdx]?.focus();
      }
    });

    optionButtons[focusedIdx]?.focus();
  }

  trigger.addEventListener('click', openMenu);
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu();
    }
  });

  interceptInputProperty(selectEl, HTMLSelectElement.prototype, 'value', syncTrigger);
  interceptInputProperty(selectEl, HTMLSelectElement.prototype, 'selectedIndex', syncTrigger);
  interceptInputProperty(selectEl, HTMLSelectElement.prototype, 'disabled', syncTrigger);

  const observer = new MutationObserver(syncTrigger);
  observer.observe(selectEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

  syncTrigger();
}

/**
 * Mejora todos los <select> dentro de un contenedor raíz.
 */
export function enhanceAllSelects(root = document) {
  root.querySelectorAll('select').forEach((sel) => enhanceSelect(sel));
}

/**
 * Reemplaza el <input type="color"> nativo de macOS por un selector de paleta web propio.
 */
export function enhanceColorPicker(colorInput) {
  if (!colorInput || colorInput.dataset.uiEnhanced === '1') return;
  registerGlobalPopoverListeners();
  colorInput.dataset.uiEnhanced = '1';

  const compact = colorInput.dataset.compact === '1';
  const wrapper = document.createElement('div');
  wrapper.className = `ui-color-picker ${compact ? 'compact' : ''}`;
  colorInput.parentNode.insertBefore(wrapper, colorInput);
  wrapper.appendChild(colorInput);
  colorInput.classList.add('ui-sr-only');
  colorInput.tabIndex = -1;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-color-trigger';
  trigger.setAttribute('aria-label', 'Seleccionar color de etiqueta');
  wrapper.appendChild(trigger);

  function syncColor() {
    const hex = sanitizeHexColor(colorInput.value);
    const match = ACADEMIC_PALETTE.find((p) => p.hex.toLowerCase() === hex.toLowerCase());
    const label = match ? match.name : hex.toUpperCase();
    trigger.innerHTML = compact
      ? `<span class="ui-color-swatch-dot" style="background:${hex}"></span>${iconSvg('chevronDown', { size: 13 })}`
      : `<span class="ui-color-swatch-dot" style="background:${hex}"></span><span class="ui-select-text">${escapeHtml(label)}</span><span class="ui-select-chevron">${iconSvg('chevronDown', { size: 15 })}</span>`;
  }

  trigger.addEventListener('click', () => {
    if (activePopover && activePopover.trigger === trigger) {
      closeActivePopover();
      return;
    }
    closeActivePopover();

    const currentHex = sanitizeHexColor(colorInput.value);
    const pop = document.createElement('div');
    pop.className = 'ui-floating-menu ui-palette-popover';
    pop.innerHTML = `
      <div class="ui-palette-title">Color de asignatura</div>
      <div class="ui-palette-grid">
        ${ACADEMIC_PALETTE.map((item) => {
          const active = item.hex.toLowerCase() === currentHex.toLowerCase();
          return `
            <button type="button" class="ui-swatch-btn ${active ? 'is-selected' : ''}" data-hex="${item.hex}" title="${escapeHtml(item.name)}" style="background:${item.hex}">
              ${active ? iconSvg('check', { size: 14 }) : ''}
            </button>
          `;
        }).join('')}
      </div>
    `;

    document.body.appendChild(pop);
    trigger.classList.add('is-open');
    const posOpts = { minWidthMatch: false };
    activePopover = { el: pop, anchor: trigger, trigger, posOpts };
    positionFloatingMenu(pop, trigger, posOpts);

    pop.querySelectorAll('.ui-swatch-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        colorInput.value = btn.dataset.hex;
        syncColor();
        colorInput.dispatchEvent(new Event('input', { bubbles: true }));
        colorInput.dispatchEvent(new Event('change', { bubbles: true }));
        closeActivePopover();
      });
    });
  });

  interceptInputProperty(colorInput, HTMLInputElement.prototype, 'value', syncColor);
  syncColor();
}

/**
 * Combobox web propio para Asignatura/Materia (reemplaza <datalist> nativo de macOS).
 */
export function initSubjectCombobox(inputEl, getSubjectsFn, onChooseSubject) {
  if (!inputEl || inputEl.dataset.uiCombo === '1') return;
  registerGlobalPopoverListeners();
  inputEl.dataset.uiCombo = '1';
  inputEl.removeAttribute('list');
  inputEl.setAttribute('autocomplete', 'off');

  const wrapper = document.createElement('div');
  wrapper.className = 'ui-combo';
  inputEl.parentNode.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'ui-combo-btn';
  toggleBtn.tabIndex = -1;
  toggleBtn.setAttribute('aria-label', 'Mostrar asignaturas sugeridas');
  toggleBtn.innerHTML = iconSvg('chevronDown', { size: 15 });
  wrapper.appendChild(toggleBtn);

  function renderComboMenu({ filterByInput = false } = {}) {
    const subjects = getSubjectsFn() || [];
    const term = filterByInput ? inputEl.value.trim().toLowerCase() : '';
    const filtered = term
      ? subjects.filter((s) => s.name.toLowerCase().includes(term) || (s.code || '').toLowerCase().includes(term))
      : subjects;

    let menu = activePopover && activePopover.anchor === wrapper ? activePopover.el : null;
    if (!menu) {
      closeActivePopover();
      menu = document.createElement('div');
      menu.className = 'ui-floating-menu';
      document.body.appendChild(menu);
      activePopover = { el: menu, anchor: wrapper, trigger: toggleBtn, posOpts: { minWidthMatch: true } };
    }

    const exactExists = subjects.some((s) => s.name.toLowerCase() === inputEl.value.trim().toLowerCase());
    const customTyped = inputEl.value.trim();

    let rowsHtml = filtered
      .map((s, idx) => {
        const safeColor = sanitizeHexColor(s.color);
        return `
          <button type="button" class="ui-menu-option" data-sub-idx="${idx}">
            <span class="ui-menu-option-main">
              <span class="ui-dot" style="background:${safeColor}"></span>
              <span>${escapeHtml(s.name)}</span>
            </span>
            ${s.code ? `<span class="ui-combo-code">${escapeHtml(s.code)}</span>` : ''}
          </button>
        `;
      })
      .join('');

    if (customTyped && !exactExists) {
      rowsHtml += `
        <button type="button" class="ui-menu-option ui-combo-custom" data-custom-sub="${escapeHtml(customTyped)}">
          <span class="ui-menu-option-main">
            ${iconSvg('plus', { size: 14 })}
            <span>Usar asignatura "${escapeHtml(customTyped)}"</span>
          </span>
        </button>
      `;
    }

    if (!rowsHtml) {
      rowsHtml = '<div class="ui-combo-empty">Escribe el nombre de tu asignatura</div>';
    }

    menu.innerHTML = rowsHtml;
    positionFloatingMenu(menu, wrapper, { minWidthMatch: true });

    menu.querySelectorAll('[data-sub-idx]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const chosen = filtered[Number(btn.dataset.subIdx)];
        if (chosen) {
          inputEl.value = chosen.name;
          if (onChooseSubject) onChooseSubject(chosen);
          closeActivePopover();
        }
      });
    });

    menu.querySelectorAll('[data-custom-sub]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        closeActivePopover();
      });
    });
  }

  inputEl.addEventListener('focus', () => renderComboMenu({ filterByInput: false }));
  inputEl.addEventListener('input', () => renderComboMenu({ filterByInput: true }));
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (activePopover && activePopover.anchor === wrapper) {
      closeActivePopover();
    } else {
      inputEl.focus();
      renderComboMenu({ filterByInput: false });
    }
  });
}

export function closeAllPopovers() {
  closeActivePopover();
}
