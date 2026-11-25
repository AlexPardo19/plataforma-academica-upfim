const TOKEN_KEY = 'upfim_auth_token';
const HEX_COLOR_RX = /^#[0-9a-fA-F]{6}$/;

export function getClientTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City';
  } catch {
    return 'America/Mexico_City';
  }
}

export function getStoredToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token) {
  // Limpiar rastro legado en localStorage para minimizar exposición persistente
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignorado
  }
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

let onSessionExpiredCallback = () => {};
export function setOnSessionExpired(cb) {
  onSessionExpiredCallback = cb;
}

export async function apiFetch(path, options = {}) {
  const token = getStoredToken();
  const headers = {
    'X-Client-Timezone': getClientTimeZone(),
    ...(options.headers || {})
  };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const resp = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401 && (data.code === 'SESSION_EXPIRED' || data.code === 'INVALID_SESSION')) {
      setStoredToken('');
      onSessionExpiredCallback(data.error || 'Tu sesión expiró por inactividad.');
    }
    const err = new Error(data.error || `Error HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHexColor(color, fallback = '#4f46e5') {
  const clean = String(color ?? '').trim();
  return HEX_COLOR_RX.test(clean) ? clean.toLowerCase() : fallback;
}

export function getLocalDateStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: getClientTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function getLocalDateTimeStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: getClientTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`;
}

export function addDaysToDateStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function getMondayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isoDay = utcDay === 0 ? 7 : utcDay;
  return addDaysToDateStr(dateStr, -(isoDay - 1));
}

export function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${Number(d)} ${months[Number(m) - 1] || m}`;
}

export function formatTimeFromIso(isoStr) {
  if (!isoStr) return '';
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return isoStr;
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(dt);
}
