import crypto from 'node:crypto';

export const DEFAULT_INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Genera un hash seguro usando scrypt y salt aleatorio de 16 bytes.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verifica una contraseña contra el hash almacenado usando comparación en tiempo constante.
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Crea una sesión activa para el usuario y retorna su token aleatorio.
 */
export function createSession(db, userId, nowMs = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, last_activity_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, nowMs, nowMs);
  return token;
}

/**
 * Elimina la sesión asociada al token.
 */
export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * Valida la sesión verificando expiración por inactividad y actualiza last_activity_at.
 */
export function validateSession(db, token, inactivityLimitMs = DEFAULT_INACTIVITY_LIMIT_MS, nowMs = Date.now()) {
  if (!token) {
    return { ok: false, status: 401, code: 'NO_TOKEN', error: 'Sesión no iniciada.' };
  }

  const row = db
    .prepare(
      `SELECT s.token, s.user_id, s.last_activity_at,
              u.id, u.name, u.email, u.role, u.group_id, u.avatar_url,
              u.tutorial_completed, u.streak_days, u.best_streak,
              u.streak_points, u.last_streak_date, u.streak_theme,
              g.name AS group_name, g.program AS group_program
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!row) {
    return { ok: false, status: 401, code: 'INVALID_SESSION', error: 'Tu sesión no es válida o fue cerrada.' };
  }

  if (nowMs - row.last_activity_at > inactivityLimitMs) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return {
      ok: false,
      status: 401,
      code: 'SESSION_EXPIRED',
      error: 'Tu sesión expiró por superar 30 minutos de inactividad. Inicia sesión nuevamente.'
    };
  }

  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE token = ?').run(nowMs, token);

  return {
    ok: true,
    token: row.token,
    user: sanitizeUser(row)
  };
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
 * Genera un token de recuperación de contraseña con expiración de 15 minutos.
 */
export function createPasswordResetToken(db, email, nowMs = Date.now()) {
  const user = db.prepare('SELECT id, email, name FROM users WHERE lower(email) = lower(?)').get(email);
  if (!user) {
    return null;
  }
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = nowMs + RESET_TOKEN_TTL_MS;
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(
    token,
    user.id,
    expiresAt
  );
  return { token, expiresAt, user };
}

/**
 * Consume un token de recuperación y actualiza la contraseña del usuario.
 */
export function resetPasswordWithToken(db, token, newPassword, nowMs = Date.now()) {
  if (!token || !newPassword || newPassword.length < 6) {
    return { ok: false, error: 'El token es obligatorio y la contraseña debe tener al menos 6 caracteres.' };
  }
  const reset = db
    .prepare('SELECT token, user_id, expires_at, used FROM password_resets WHERE token = ?')
    .get(token);

  if (!reset || reset.used) {
    return { ok: false, error: 'El token de recuperación es inválido o ya fue utilizado.' };
  }
  if (nowMs > reset.expires_at) {
    return { ok: false, error: 'El token de recuperación ha expirado.' };
  }

  const newHash = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, reset.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
  return { ok: true };
}
