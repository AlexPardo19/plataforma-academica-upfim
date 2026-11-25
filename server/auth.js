import crypto from 'node:crypto';
import { purgeExpiredArtifacts, withTransaction } from './db.js';
import { hashToken, safeCompareStrings, validatePasswordPolicy } from './security.js';

export const DEFAULT_INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
export const ABSOLUTE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SSE_TICKET_TTL_MS = 30 * 1000;
export const MAX_CONCURRENT_SESSIONS = 5;
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const ACCOUNT_LOCKOUT_MS = 15 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'upfim_sid';
export const DEFAULT_TEACHER_ACCESS_CODE = 'UPFIM-DOCENTE-2026';

/**
 * Genera un hash seguro usando scrypt y salt aleatorio de 16 bytes.
 */
export function hashPassword(password) {
  const str = String(password || '');
  if (str.length > 128) {
    throw Object.assign(new Error('La contraseña excede la longitud máxima permitida (128 caracteres).'), {
      status: 400
    });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(str, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verifica una contraseña contra el hash almacenado usando comparación en tiempo constante.
 */
export function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    return false;
  }
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Verifica el código institucional para registro de cuentas Docentes (evita escalación de privilegios).
 */
export function verifyTeacherAccessCode(submittedCode, configuredCode) {
  const expected = configuredCode || process.env.TEACHER_ACCESS_CODE || DEFAULT_TEACHER_ACCESS_CODE;
  return safeCompareStrings(String(submittedCode || '').trim(), expected);
}

/**
 * Crea una sesión activa guardando únicamente el hash SHA-256 del token en SQLite 3.
 */
export function createSession(db, userId, meta = {}, nowMs = Date.now()) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const ipAddress = String(meta.ipAddress || '').slice(0, 64);
  const userAgent = String(meta.userAgent || '').slice(0, 200);
  const expiresAt = nowMs + ABSOLUTE_SESSION_TTL_MS;

  withTransaction(db, () => {
    purgeExpiredArtifacts(db, nowMs);

    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, ip_address, user_agent, created_at, last_activity_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenHash, userId, ipAddress, userAgent, nowMs, nowMs, expiresAt);

    // Limitar sesiones concurrentes máximas por usuario conservando las más recientes
    const active = db
      .prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC')
      .all(userId);
    if (active.length > MAX_CONCURRENT_SESSIONS) {
      const toDelete = active.slice(MAX_CONCURRENT_SESSIONS);
      const delStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
      for (const row of toDelete) {
        delStmt.run(row.id);
      }
    }
  });

  return rawToken;
}

/**
 * Elimina la sesión asociada al token en claro (o su hash).
 */
export function destroySession(db, rawToken) {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/**
 * Elimina todas las demás sesiones activas del usuario excepto la actual.
 */
export function destroyOtherSessions(db, userId, currentTokenHash) {
  const res = db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, currentTokenHash);
  return Number(res.changes || 0);
}

/**
 * Lista sesiones activas del usuario sin exponer jamás tokens ni hashes completos.
 */
export function listActiveSessions(db, userId, currentTokenHash, nowMs = Date.now()) {
  purgeExpiredArtifacts(db, nowMs);
  const rows = db
    .prepare(
      `SELECT id, token_hash, ip_address, user_agent, created_at, last_activity_at, expires_at
       FROM sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY last_activity_at DESC`
    )
    .all(userId, nowMs);

  return rows.map((r) => ({
    id: r.id,
    ipAddress: r.ip_address || 'Local',
    userAgent: summarizeUserAgent(r.user_agent),
    createdAt: new Date(r.created_at).toISOString(),
    lastActivityAt: new Date(r.last_activity_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    isCurrent: r.token_hash === currentTokenHash
  }));
}

function summarizeUserAgent(ua) {
  const clean = String(ua || '').trim();
  if (!clean) return 'Cliente Web / API';
  if (/Edg\//i.test(clean)) return 'Microsoft Edge';
  if (/Chrome\//i.test(clean) && !/Chromium/i.test(clean)) return 'Google Chrome';
  if (/Firefox\//i.test(clean)) return 'Mozilla Firefox';
  if (/Safari\//i.test(clean) && !/Chrome/i.test(clean)) return 'Apple Safari';
  return clean.slice(0, 60);
}

/**
 * Valida la sesión usando comparación sobre token_hash SHA-256, verificando expiración absoluta e inactividad.
 */
export function validateSession(
  db,
  rawToken,
  inactivityLimitMs = DEFAULT_INACTIVITY_LIMIT_MS,
  nowMs = Date.now()
) {
  if (!rawToken) {
    return { ok: false, status: 401, code: 'NO_TOKEN', error: 'Sesión no iniciada.' };
  }

  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.token_hash, s.user_id, s.last_activity_at, s.expires_at,
              u.id, u.name, u.email, u.role, u.group_id, u.avatar_url,
              u.tutorial_completed, u.streak_days, u.best_streak,
              u.streak_points, u.last_streak_date, u.streak_theme,
              u.locked_until,
              g.name AS group_name, g.program AS group_program
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) {
    return { ok: false, status: 401, code: 'INVALID_SESSION', error: 'Tu sesión no es válida o fue cerrada.' };
  }

  if (nowMs > row.expires_at || nowMs - row.last_activity_at > inactivityLimitMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return {
      ok: false,
      status: 401,
      code: 'SESSION_EXPIRED',
      error: 'Tu sesión expiró por superar 30 minutos de inactividad. Inicia sesión nuevamente.'
    };
  }

  if (row.locked_until && nowMs < row.locked_until) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return {
      ok: false,
      status: 423,
      code: 'ACCOUNT_LOCKED',
      error: 'Tu cuenta se encuentra bloqueada temporalmente por seguridad.'
    };
  }

  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE token_hash = ?').run(nowMs, tokenHash);

  return {
    ok: true,
    sessionId: row.session_id,
    token: rawToken,
    tokenHash,
    user: sanitizeUser(row)
  };
}

/**
 * Genera un ticket efímero de un solo uso (30 s) para abrir el canal SSE sin exponer el Bearer token en la URL.
 */
export function createSseTicket(db, userId, nowMs = Date.now()) {
  const rawTicket = crypto.randomBytes(24).toString('hex');
  const ticketHash = hashToken(rawTicket);
  const expiresAt = nowMs + SSE_TICKET_TTL_MS;

  withTransaction(db, () => {
    db.prepare('DELETE FROM sse_tickets WHERE expires_at <= ?').run(nowMs);
    db.prepare('INSERT INTO sse_tickets (ticket_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      ticketHash,
      userId,
      expiresAt
    );
  });

  return { ticket: rawTicket, expiresAt };
}

/**
 * Consume atómicamente un ticket efímero SSE y retorna el usuario si es válido.
 */
export function consumeSseTicket(db, rawTicket, nowMs = Date.now()) {
  if (!rawTicket) return null;
  const ticketHash = hashToken(rawTicket);

  return withTransaction(db, () => {
    const row = db
      .prepare('SELECT ticket_hash, user_id, expires_at FROM sse_tickets WHERE ticket_hash = ?')
      .get(ticketHash);
    if (!row) return null;

    db.prepare('DELETE FROM sse_tickets WHERE ticket_hash = ?').run(ticketHash);
    if (nowMs > row.expires_at) return null;

    const userRow = db
      .prepare(
        `SELECT u.*, g.name AS group_name, g.program AS group_program
         FROM users u
         LEFT JOIN groups g ON g.id = u.group_id
         WHERE u.id = ?`
      )
      .get(row.user_id);

    return sanitizeUser(userRow);
  });
}

/**
 * Evalúa si una cuenta está bloqueada temporalmente por intentos fallidos de inicio de sesión.
 */
export function checkAccountLockout(userRow, nowMs = Date.now()) {
  if (!userRow || !userRow.locked_until) return { locked: false, retryAfterSec: 0 };
  if (nowMs >= userRow.locked_until) return { locked: false, retryAfterSec: 0 };
  const retryAfterSec = Math.max(1, Math.ceil((userRow.locked_until - nowMs) / 1000));
  return { locked: true, retryAfterSec };
}

/**
 * Registra un intento fallido de contraseña en SQLite y aplica bloqueo temporal al alcanzar el umbral.
 */
export function recordFailedLoginAttempt(db, userRow, nowMs = Date.now()) {
  if (!userRow) return { locked: false, attempts: 0 };
  const baseAttempts =
    userRow.locked_until && nowMs >= userRow.locked_until ? 0 : userRow.failed_login_attempts || 0;
  const attempts = baseAttempts + 1;

  if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
    const lockedUntil = nowMs + ACCOUNT_LOCKOUT_MS;
    db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(
      attempts,
      lockedUntil,
      userRow.id
    );
    return { locked: true, attempts, lockedUntil };
  }

  db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = NULL WHERE id = ?').run(
    attempts,
    userRow.id
  );
  return { locked: false, attempts, remainingAttempts: MAX_FAILED_LOGIN_ATTEMPTS - attempts };
}

/**
 * Restablece el contador de intentos fallidos tras una autenticación válida.
 */
export function clearFailedLoginAttempts(db, userId) {
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
}

/**
 * Limpia campos sensibles y normaliza un objeto de usuario para respuestas API.
 */
export function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    groupId: row.group_id ?? null,
    groupName: row.group_name ?? null,
    groupProgram: row.group_program ?? null,
    avatarUrl: row.avatar_url || '',
    tutorialCompleted: Boolean(row.tutorial_completed),
    streakDays: row.streak_days ?? 0,
    bestStreak: row.best_streak ?? 0,
    streakPoints: row.streak_points ?? 0,
    lastStreakDate: row.last_streak_date ?? null,
    streakTheme: row.streak_theme || 'classic'
  };
}

/**
 * Genera un token de recuperación de contraseña con expiración de 15 minutos,
 * almacenando únicamente su hash SHA-256 en SQLite.
 */
export function createPasswordResetToken(db, email, nowMs = Date.now()) {
  const user = db.prepare('SELECT id, email, name FROM users WHERE lower(email) = lower(?)').get(email);
  if (!user) {
    return null;
  }
  const rawToken = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = nowMs + RESET_TOKEN_TTL_MS;

  withTransaction(db, () => {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(
      tokenHash,
      user.id,
      expiresAt
    );
  });

  return { token: rawToken, expiresAt, user };
}

/**
 * Consume atómicamente un token de recuperación y actualiza la contraseña revocando todas las sesiones previas.
 */
export function resetPasswordWithToken(db, rawToken, newPassword, nowMs = Date.now()) {
  if (!rawToken) {
    return { ok: false, error: 'El token de recuperación es obligatorio.' };
  }
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.ok) {
    return { ok: false, error: policy.error };
  }

  const tokenHash = hashToken(rawToken);

  return withTransaction(db, () => {
    const reset = db
      .prepare('SELECT token_hash, user_id, expires_at, used FROM password_resets WHERE token_hash = ?')
      .get(tokenHash);

    if (!reset || reset.used) {
      return { ok: false, error: 'El token de recuperación es inválido o ya fue utilizado.' };
    }
    if (nowMs > reset.expires_at) {
      db.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(tokenHash);
      return { ok: false, error: 'El token de recuperación ha expirado.' };
    }

    const newHash = hashPassword(newPassword);
    const nowIso = new Date(nowMs).toISOString();
    db.prepare(
      'UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL, password_changed_at = ? WHERE id = ?'
    ).run(newHash, nowIso, reset.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(tokenHash);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);

    return { ok: true, userId: reset.user_id };
  });
}

/**
 * Cambia la contraseña de un usuario autenticado verificando su clave actual y cerrando otras sesiones.
 */
export function changeAuthenticatedPassword(db, userId, currentPassword, newPassword, keepTokenHash = null) {
  const row = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    return { ok: false, status: 401, error: 'Tu contraseña actual no es correcta.' };
  }
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.ok) {
    return { ok: false, status: 400, error: policy.error };
  }
  if (currentPassword === newPassword) {
    return { ok: false, status: 400, error: 'La nueva contraseña debe ser diferente a la actual.' };
  }

  const newHash = hashPassword(newPassword);
  const nowIso = new Date().toISOString();

  const revokedSessions = withTransaction(db, () => {
    db.prepare(
      'UPDATE users SET password_hash = ?, password_changed_at = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?'
    ).run(newHash, nowIso, userId);

    if (keepTokenHash) {
      return Number(
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepTokenHash).changes || 0
      );
    }
    return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes || 0);
  });

  return { ok: true, revokedSessions };
}

/**
 * Construye cookies HttpOnly + SameSite=Strict para blindar la sesión en navegadores.
 */
export function buildSessionCookie(rawToken, maxAgeSec = Math.floor(ABSOLUTE_SESSION_TTL_MS / 1000)) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secureFlag}`;
}

export function buildClearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}
