import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendAuditLog,
  createDatabase,
  createDatabaseBackup,
  DEFAULT_TIMEZONE,
  getDatabaseSecurityStatus,
  getLocalDateString,
  getLocalDateTimeString,
  normalizeTimeZone,
  withTransaction
} from './db.js';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  changeAuthenticatedPassword,
  checkAccountLockout,
  clearFailedLoginAttempts,
  consumeSseTicket,
  createPasswordResetToken,
  createSession,
  createSseTicket,
  DEFAULT_INACTIVITY_LIMIT_MS,
  destroyOtherSessions,
  destroySession,
  hashPassword,
  listActiveSessions,
  parseCookies,
  recordFailedLoginAttempt,
  resetPasswordWithToken,
  sanitizeUser,
  SESSION_COOKIE_NAME,
  validateSession,
  verifyPassword,
  verifyTeacherAccessCode
} from './auth.js';
import { seedDatabaseIfEmpty } from './seed.js';
import {
  calculateTaskCompletionPoints,
  evaluateDailyStreak,
  getStreakThemesForUser,
  selectStreakTheme
} from './streak.js';
import { ASSISTANT_WELCOME, generateAssistantReply } from './assistant.js';
import { createSseHub } from './sse.js';
import {
  cleanControlChars,
  createRateLimiter,
  escapeLikePattern,
  getClientIp,
  getSecurityHeaders,
  isValidEmail,
  isValidHexColor,
  isValidLocalDateTime,
  isValidTime24h,
  validateAvatarUrl,
  validatePasswordPolicy
} from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DOCS_DIR = path.resolve(__dirname, '..', 'documentacion');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const FORBIDDEN_CHAT_KEYS = [
  'attachment',
  'attachments',
  'file',
  'fileUrl',
  'image',
  'audio',
  'video',
  'callType',
  'media'
];

const MAX_DAILY_REWARDED_TASKS = 15;

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...getSecurityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

async function parseJsonBody(req, maxBytes = 262_144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error('El cuerpo de la solicitud excede el tamaño máximo permitido.'), {
        status: 413
      });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Se esperaba un objeto JSON.');
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('JSON inválido en la solicitud.'), { status: 400 });
  }
}

function getTokenFromRequest(req, urlObj, { allowQueryToken = false } = {}) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return { token: authHeader.slice(7).trim(), source: 'bearer' };
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return { token: cookies[SESSION_COOKIE_NAME], source: 'cookie' };
  }
  if (allowQueryToken) {
    const queryToken = urlObj.searchParams.get('token') || '';
    if (queryToken) return { token: queryToken, source: 'query' };
  }
  return { token: '', source: 'none' };
}

function verifySameOriginForCookieMutation(req, method, authSource) {
  if (authSource !== 'cookie') return true;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function getClientTimeZone(req) {
  return normalizeTimeZone(req.headers['x-client-timezone'] || DEFAULT_TIMEZONE);
}

function getUserWithGroupById(db, userId) {
  const row = db
    .prepare(
      `SELECT u.*, g.name AS group_name, g.program AS group_program
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE u.id = ?`
    )
    .get(userId);
  return sanitizeUser(row);
}

function getUnreadMessagesCount(db, userId) {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM private_messages WHERE receiver_id = ? AND is_read = 0')
    .get(userId);
  return row ? row.count : 0;
}

function decryptMessageContent(db, storedContent) {
  if (!storedContent) return '';
  try {
    return db.vault ? db.vault.decrypt(storedContent) : storedContent;
  } catch {
    return '[Mensaje protegido: error de verificación de integridad]';
  }
}

function teacherTeachesGroup(db, teacherId, groupId) {
  if (!groupId) return false;
  const row = db
    .prepare('SELECT 1 AS ok FROM subjects WHERE teacher_id = ? AND group_id = ? LIMIT 1')
    .get(teacherId, groupId);
  return Boolean(row);
}

function serveStaticFile(reqPath, res) {
  if (reqPath === '/ishikawa' || reqPath === '/ishikawa.svg') {
    const docFile = reqPath === '/ishikawa.svg' ? 'diagrama-ishikawa.svg' : 'diagrama-ishikawa.html';
    const docTarget = path.join(DOCS_DIR, docFile);
    if (fs.existsSync(docTarget)) {
      const ext = path.extname(docTarget).toLowerCase();
      res.writeHead(200, {
        ...getSecurityHeaders(),
        'Content-Type': MIME_TYPES[ext] || 'text/html; charset=utf-8'
      });
      fs.createReadStream(docTarget).pipe(res);
      return;
    }
  }

  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, cleanRel);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, getSecurityHeaders());
    res.end('Forbidden');
    return;
  }

  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // Fallback SPA solo cuando no tiene extensión estática desconocida
    if (path.extname(cleanRel) && path.extname(cleanRel) !== '.html') {
      res.writeHead(404, getSecurityHeaders());
      res.end('Not Found');
      return;
    }
    target = path.join(PUBLIC_DIR, 'index.html');
  }

  if (!fs.existsSync(target)) {
    res.writeHead(404, getSecurityHeaders());
    res.end('Not Found');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    ...getSecurityHeaders(),
    'Content-Type': mime
  });
  fs.createReadStream(target).pipe(res);
}

/**
 * Crea la instancia del servidor HTTP y base de datos SQLite 3 blindada.
 */
export function createAppServer(options = {}) {
  const dbPath = options.dbPath || path.resolve(__dirname, '..', 'data', 'academico.sqlite');
  const inactivityLimitMs =
    options.inactivityMs ??
    (Number(process.env.SESSION_INACTIVITY_MS) || DEFAULT_INACTIVITY_LIMIT_MS);
  const enableDemoInbox =
    options.enableDemoInbox ??
    (process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEMO_INBOX !== 'false');

  const db = createDatabase(dbPath, { encryptionKey: options.encryptionKey });
  seedDatabaseIfEmpty(db, DEFAULT_TIMEZONE);
  const sseHub = createSseHub();
  const rateLimiter = createRateLimiter();

  function checkRate(res, bucketKey, maxRequests, windowMs) {
    const status = rateLimiter.check(bucketKey, maxRequests, windowMs);
    if (!status.allowed) {
      sendJson(
        res,
        429,
        {
          code: 'RATE_LIMITED',
          error: `Demasiadas solicitudes seguidas. Intenta nuevamente en ${status.retryAfterSec} segundos.`
        },
        { 'Retry-After': String(status.retryAfterSec) }
      );
      return false;
    }
    return true;
  }

  function requireAuth(req, res, urlObj, { allowQueryToken = false } = {}) {
    const { token, source } = getTokenFromRequest(req, urlObj, { allowQueryToken });
    const method = (req.method || 'GET').toUpperCase();
    if (!verifySameOriginForCookieMutation(req, method, source)) {
      sendJson(res, 403, { code: 'CSRF_BLOCKED', error: 'Origen de solicitud inválido (protección CSRF).' });
      return null;
    }
    const result = validateSession(db, token, inactivityLimitMs);
    if (!result.ok) {
      sendJson(res, result.status, { code: result.code, error: result.error });
      return null;
    }
    return result;
  }

  function requireRole(auth, res, role) {
    if (auth.user.role !== role) {
      const msg =
        role === 'student'
          ? 'Esta funcionalidad es exclusiva para cuentas de Estudiante.'
          : 'Esta funcionalidad es exclusiva del Portal Docente.';
      sendJson(res, 403, { error: msg });
      return false;
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const method = (req.method || 'GET').toUpperCase();
    const clientIp = getClientIp(req);
    const userAgent = String(req.headers['user-agent'] || '');

    if (!pathname.startsWith('/api/')) {
      serveStaticFile(pathname, res);
      return;
    }

    try {
      const tz = getClientTimeZone(req);

      // ------------------------------------------------------------------
      // Salud y catálogos públicos
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/health') {
        const sqliteVer = db.prepare('SELECT sqlite_version() AS v').get()?.v || '3.x';
        return sendJson(res, 200, { ok: true, timeZone: tz, database: `SQLite ${sqliteVer}` });
      }

      if (method === 'GET' && pathname === '/api/groups') {
        const groups = db.prepare('SELECT id, name, program FROM groups ORDER BY name ASC').all();
        return sendJson(res, 200, { groups });
      }

      // ------------------------------------------------------------------
      // Autenticación, Registro, Recuperación y Perfil (HU-01..HU-10)
      // ------------------------------------------------------------------
      if (method === 'POST' && pathname === '/api/auth/register') {
        if (!checkRate(res, `reg:${clientIp}`, 10, 5 * 60_000)) return;

        const body = await parseJsonBody(req);
        const name = cleanControlChars(body.name);
        const email = cleanControlChars(body.email).toLowerCase();
        const password = String(body.password || '');
        const role = body.role === 'teacher' ? 'teacher' : 'student';

        if (name.length < 2 || name.length > 120) {
          return sendJson(res, 400, { error: 'Ingresa tu nombre completo (entre 2 y 120 caracteres).' });
        }
        if (!isValidEmail(email)) {
          return sendJson(res, 400, { error: 'El correo electrónico no tiene un formato válido.' });
        }
        const passPolicy = validatePasswordPolicy(password);
        if (!passPolicy.ok) {
          return sendJson(res, 400, { error: passPolicy.error });
        }

        // Blindaje contra escalación de privilegios al rol Docente
        if (role === 'teacher') {
          if (!verifyTeacherAccessCode(body.teacherCode, options.teacherAccessCode)) {
            appendAuditLog(db, {
              userId: null,
              action: 'PRIVILEGE_ESCALATION_BLOCKED',
              severity: 'warning',
              ipAddress: clientIp,
              details: { attemptedEmail: email, role: 'teacher' }
            });
            return sendJson(res, 403, {
              error: 'Se requiere un código institucional de docente válido para registrar cuentas de supervisión.'
            });
          }
        }

        const exists = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
        if (exists) {
          return sendJson(res, 409, { error: 'Ya existe una cuenta registrada con este correo.' });
        }

        let groupId = null;
        if (role === 'student') {
          if (body.groupId) {
            const grp = db.prepare('SELECT id FROM groups WHERE id = ?').get(Number(body.groupId));
            if (!grp) return sendJson(res, 400, { error: 'El grupo seleccionado no existe.' });
            groupId = grp.id;
          } else {
            const firstGroup = db.prepare('SELECT id FROM groups ORDER BY id ASC LIMIT 1').get();
            groupId = firstGroup ? firstGroup.id : null;
          }
        }

        const regOutcome = withTransaction(db, () => {
          const nowIso = new Date().toISOString();
          const result = db
            .prepare(
              `INSERT INTO users (name, email, password_hash, role, group_id, tutorial_completed, created_at)
               VALUES (?, ?, ?, ?, ?, 0, ?)`
            )
            .run(name, email, hashPassword(password), role, groupId, nowIso);

          const userId = Number(result.lastInsertRowid);
          let streakEvent = null;
          if (role === 'student') {
            streakEvent = evaluateDailyStreak(db, userId, tz);
            db.prepare(
              `INSERT INTO assistant_messages (user_id, sender, content, created_at)
               VALUES (?, 'assistant', ?, ?)`
            ).run(userId, ASSISTANT_WELCOME, nowIso);
          }

          const token = createSession(db, userId, { ipAddress: clientIp, userAgent });
          appendAuditLog(db, {
            userId,
            action: 'AUTH_REGISTER_SUCCESS',
            severity: 'info',
            ipAddress: clientIp,
            details: { role, groupId }
          });

          return { userId, token, streakEvent };
        });

        const user = getUserWithGroupById(db, regOutcome.userId);
        return sendJson(
          res,
          201,
          {
            token: regOutcome.token,
            user,
            streakEvent: regOutcome.streakEvent,
            unreadMessages: 0
          },
          { 'Set-Cookie': buildSessionCookie(regOutcome.token) }
        );
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        if (!checkRate(res, `login:${clientIp}`, options.loginRateLimitMax ?? 15, 60_000)) return;

        const body = await parseJsonBody(req);
        const email = cleanControlChars(body.email).toLowerCase();
        const password = String(body.password || '');

        const userRow = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
        if (userRow) {
          const lockState = checkAccountLockout(userRow);
          if (lockState.locked) {
            appendAuditLog(db, {
              userId: userRow.id,
              action: 'AUTH_LOGIN_LOCKED_ATTEMPT',
              severity: 'warning',
              ipAddress: clientIp,
              details: { retryAfterSec: lockState.retryAfterSec }
            });
            return sendJson(
              res,
              423,
              {
                code: 'ACCOUNT_LOCKED',
                error: `Cuenta bloqueada temporalmente por múltiples intentos fallidos. Intenta en ${Math.ceil(lockState.retryAfterSec / 60)} min.`
              },
              { 'Retry-After': String(lockState.retryAfterSec) }
            );
          }
        }

        if (!userRow || !verifyPassword(password, userRow.password_hash)) {
          if (userRow) {
            const failInfo = recordFailedLoginAttempt(db, userRow);
            appendAuditLog(db, {
              userId: userRow.id,
              action: failInfo.locked ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN_FAILED',
              severity: failInfo.locked ? 'critical' : 'warning',
              ipAddress: clientIp,
              details: { attempts: failInfo.attempts }
            });
            if (failInfo.locked) {
              return sendJson(res, 423, {
                code: 'ACCOUNT_LOCKED',
                error: 'Se superó el límite de 5 intentos fallidos. Tu cuenta se bloqueó temporalmente por 15 minutos.'
              });
            }
          } else {
            // Mitigación de ataques de temporización cuando el correo no existe
            verifyPassword(password, '00000000000000000000000000000000:' + '0'.repeat(128));
          }
          return sendJson(res, 401, { error: 'Correo electrónico o contraseña incorrectos.' });
        }

        const loginOutcome = withTransaction(db, () => {
          clearFailedLoginAttempts(db, userRow.id);
          let streakEvent = null;
          if (userRow.role === 'student') {
            streakEvent = evaluateDailyStreak(db, userRow.id, tz);
          }
          const token = createSession(db, userRow.id, { ipAddress: clientIp, userAgent });
          appendAuditLog(db, {
            userId: userRow.id,
            action: 'AUTH_LOGIN_SUCCESS',
            severity: 'info',
            ipAddress: clientIp,
            details: { role: userRow.role }
          });
          return { token, streakEvent };
        });

        const user = getUserWithGroupById(db, userRow.id);
        const unreadMessages = getUnreadMessagesCount(db, userRow.id);
        return sendJson(
          res,
          200,
          {
            token: loginOutcome.token,
            user,
            streakEvent: loginOutcome.streakEvent,
            unreadMessages
          },
          { 'Set-Cookie': buildSessionCookie(loginOutcome.token) }
        );
      }

      if (method === 'POST' && pathname === '/api/auth/forgot-password') {
        if (!checkRate(res, `forgot:${clientIp}`, 6, 5 * 60_000)) return;

        const body = await parseJsonBody(req);
        const email = cleanControlChars(body.email).toLowerCase();
        if (!isValidEmail(email)) {
          return sendJson(res, 400, { error: 'Ingresa un correo electrónico válido.' });
        }
        const resetData = createPasswordResetToken(db, email);
        if (!resetData) {
          return sendJson(res, 200, {
            ok: true,
            message: 'Si el correo existe en la plataforma, se ha generado un enlace de recuperación válido por 15 minutos.'
          });
        }

        appendAuditLog(db, {
          userId: resetData.user.id,
          action: 'AUTH_PASSWORD_RESET_REQUESTED',
          severity: 'warning',
          ipAddress: clientIp,
          details: { tokenHashedInDb: true, demoInboxExposed: enableDemoInbox }
        });

        const responsePayload = {
          ok: true,
          message: 'Si el correo existe en la plataforma, se ha generado un enlace seguro de recuperación (válido por 15 minutos).'
        };

        if (enableDemoInbox) {
          responsePayload.demoInbox = {
            email: resetData.user.email,
            resetToken: resetData.token,
            expiresAt: resetData.expiresAt,
            note: 'Modo local autónomo: usa este código temporal de verificación (válido por 15 minutos) para restablecer tu contraseña.'
          };
        }

        return sendJson(res, 200, responsePayload);
      }

      if (method === 'POST' && pathname === '/api/auth/reset-password') {
        if (!checkRate(res, `reset:${clientIp}`, 6, 5 * 60_000)) return;

        const body = await parseJsonBody(req);
        const result = resetPasswordWithToken(
          db,
          cleanControlChars(body.token),
          String(body.newPassword || '')
        );
        if (!result.ok) {
          return sendJson(res, 400, { error: result.error });
        }
        appendAuditLog(db, {
          userId: result.userId,
          action: 'AUTH_PASSWORD_RESET_COMPLETED',
          severity: 'warning',
          ipAddress: clientIp,
          details: { allSessionsRevoked: true }
        });
        return sendJson(
          res,
          200,
          { ok: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' },
          { 'Set-Cookie': buildClearSessionCookie() }
        );
      }

      // ------------------------------------------------------------------
      // Canal SSE en Tiempo Real (soporta ticket efímero de 1 uso o Cookie HttpOnly)
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/events') {
        const ticketParam = urlObj.searchParams.get('ticket') || '';
        if (ticketParam) {
          const ticketUser = consumeSseTicket(db, ticketParam);
          if (!ticketUser) {
            return sendJson(res, 401, { code: 'INVALID_SSE_TICKET', error: 'Ticket de eventos inválido o expirado.' });
          }
          sseHub.registerClient(ticketUser.id, res);
          return;
        }
        const auth = requireAuth(req, res, urlObj, { allowQueryToken: true });
        if (!auth) return;
        sseHub.registerClient(auth.user.id, res);
        return;
      }

      // ------------------------------------------------------------------
      // Rutas autenticadas a partir de este punto
      // ------------------------------------------------------------------
      const auth = requireAuth(req, res, urlObj);
      if (!auth) return;

      if (method === 'POST' && pathname === '/api/events/ticket') {
        const ticketData = createSseTicket(db, auth.user.id);
        return sendJson(res, 201, ticketData);
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        destroySession(db, auth.token);
        appendAuditLog(db, {
          userId: auth.user.id,
          action: 'AUTH_LOGOUT',
          severity: 'info',
          ipAddress: clientIp,
          details: {}
        });
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': buildClearSessionCookie() });
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const unreadMessages = getUnreadMessagesCount(db, auth.user.id);
        return sendJson(res, 200, { user: auth.user, unreadMessages });
      }

      if (method === 'GET' && pathname === '/api/auth/sessions') {
        const sessions = listActiveSessions(db, auth.user.id, auth.tokenHash);
        return sendJson(res, 200, { sessions });
      }

      if (method === 'DELETE' && pathname === '/api/auth/sessions/others') {
        const closedCount = destroyOtherSessions(db, auth.user.id, auth.tokenHash);
        appendAuditLog(db, {
          userId: auth.user.id,
          action: 'AUTH_REVOKE_OTHER_SESSIONS',
          severity: 'warning',
          ipAddress: clientIp,
          details: { closedCount }
        });
        return sendJson(res, 200, { ok: true, closedCount });
      }

      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const body = await parseJsonBody(req);
        const result = changeAuthenticatedPassword(
          db,
          auth.user.id,
          String(body.currentPassword || ''),
          String(body.newPassword || ''),
          auth.tokenHash
        );
        if (!result.ok) {
          return sendJson(res, result.status || 400, { error: result.error });
        }
        appendAuditLog(db, {
          userId: auth.user.id,
          action: 'AUTH_PASSWORD_CHANGED',
          severity: 'warning',
          ipAddress: clientIp,
          details: { revokedOtherSessions: result.revokedSessions }
        });
        return sendJson(res, 200, {
          ok: true,
          revokedSessions: result.revokedSessions,
          message: 'Contraseña actualizada y otras sesiones cerradas correctamente.'
        });
      }

      if (method === 'PUT' && pathname === '/api/profile') {
        const body = await parseJsonBody(req);
        const name = cleanControlChars(body.name ?? auth.user.name);
        const email = cleanControlChars(body.email ?? auth.user.email).toLowerCase();
        const avatarCheck = validateAvatarUrl(body.avatarUrl ?? auth.user.avatarUrl ?? '');

        if (name.length < 2 || name.length > 120) {
          return sendJson(res, 400, { error: 'El nombre debe tener entre 2 y 120 caracteres.' });
        }
        if (!isValidEmail(email)) {
          return sendJson(res, 400, { error: 'Corrige el formato del correo electrónico.' });
        }
        if (!avatarCheck.ok) {
          return sendJson(res, 400, { error: avatarCheck.error });
        }

        const duplicate = db
          .prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?')
          .get(email, auth.user.id);
        if (duplicate) {
          return sendJson(res, 409, { error: 'Ese correo electrónico ya está en uso por otra cuenta.' });
        }

        let groupId = auth.user.groupId;
        if (auth.user.role === 'student' && body.groupId !== undefined && body.groupId !== null) {
          const grp = db.prepare('SELECT id FROM groups WHERE id = ?').get(Number(body.groupId));
          if (!grp) return sendJson(res, 400, { error: 'Grupo inválido.' });
          groupId = grp.id;
        }

        withTransaction(db, () => {
          db.prepare('UPDATE users SET name = ?, email = ?, avatar_url = ?, group_id = ? WHERE id = ?').run(
            name,
            email,
            avatarCheck.value,
            groupId,
            auth.user.id
          );
          appendAuditLog(db, {
            userId: auth.user.id,
            action: 'PROFILE_UPDATED',
            severity: 'info',
            ipAddress: clientIp,
            details: { groupId }
          });
        });

        return sendJson(res, 200, { user: getUserWithGroupById(db, auth.user.id) });
      }

      if (method === 'GET' && pathname === '/api/profile/export') {
        const tasks = db
          .prepare(
            'SELECT id, subject_name, subject_color, title, description, due_at, priority, completed, completed_at, points_awarded, created_at FROM tasks WHERE user_id = ? ORDER BY due_at ASC'
          )
          .all(auth.user.id);
        const audit = db
          .prepare(
            'SELECT id, action, severity, created_at, entry_hash FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 30'
          )
          .all(auth.user.id);

        appendAuditLog(db, {
          userId: auth.user.id,
          action: 'USER_DATA_EXPORTED',
          severity: 'info',
          ipAddress: clientIp,
          details: { taskCount: tasks.length }
        });

        return sendJson(res, 200, {
          exportedAt: new Date().toISOString(),
          user: auth.user,
          tasks,
          recentSecurityEvents: audit
        });
      }

      if (method === 'POST' && pathname === '/api/profile/tutorial') {
        const body = await parseJsonBody(req);
        const completed = body.completed === false ? 0 : 1;
        db.prepare('UPDATE users SET tutorial_completed = ? WHERE id = ?').run(completed, auth.user.id);
        return sendJson(res, 200, { ok: true, tutorialCompleted: Boolean(completed) });
      }

      // ------------------------------------------------------------------
      // Centro de Blindaje e Integridad SQLite 3
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/security/status') {
        const status = getDatabaseSecurityStatus(db, dbPath);
        if (auth.user.role !== 'teacher') {
          return sendJson(res, 200, {
            engine: status.engine,
            integrityOk: status.integrityOk,
            pragmas: status.pragmas,
            encryption: {
              algorithm: status.encryption.algorithm,
              allEncryptedAtRest: status.encryption.allEncryptedAtRest
            },
            auditChain: {
              ok: status.auditChain.ok,
              totalEntries: status.auditChain.totalEntries
            }
          });
        }
        return sendJson(res, 200, status);
      }

      if (method === 'GET' && pathname === '/api/security/audit') {
        if (auth.user.role === 'teacher') {
          const logs = db
            .prepare(
              `SELECT a.id, a.user_id AS userId, u.name AS userName, u.role AS userRole,
                      a.action, a.severity, a.ip_address AS ipAddress, a.details_json AS detailsJson,
                      a.created_at AS createdAt, substr(a.entry_hash, 1, 16) AS shortHash
               FROM audit_logs a
               LEFT JOIN users u ON u.id = a.user_id
               ORDER BY a.id DESC
               LIMIT 25`
            )
            .all();
          return sendJson(res, 200, { logs });
        }

        const ownLogs = db
          .prepare(
            `SELECT id, action, severity, created_at AS createdAt, substr(entry_hash, 1, 16) AS shortHash
             FROM audit_logs
             WHERE user_id = ?
             ORDER BY id DESC
             LIMIT 15`
          )
          .all(auth.user.id);
        return sendJson(res, 200, { logs: ownLogs });
      }

      if (method === 'POST' && pathname === '/api/security/backup') {
        if (!requireRole(auth, res, 'teacher')) return;
        if (!checkRate(res, `backup:${auth.user.id}`, 5, 60_000)) return;

        const backup = createDatabaseBackup(db, dbPath);
        appendAuditLog(db, {
          userId: auth.user.id,
          action: 'DATABASE_ATOMIC_BACKUP_CREATED',
          severity: 'info',
          ipAddress: clientIp,
          details: { fileName: backup.fileName, sizeBytes: backup.sizeBytes }
        });
        return sendJson(res, 201, { ok: true, backup });
      }

      // ------------------------------------------------------------------
      // Módulo Estudiante: Tareas, Materias, Notificaciones y Racha
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/subjects/student') {
        if (!requireRole(auth, res, 'student')) return;
        const groupSubjects = auth.user.groupId
          ? db
              .prepare('SELECT DISTINCT name, color, code FROM subjects WHERE group_id = ? ORDER BY name ASC')
              .all(auth.user.groupId)
          : [];
        const taskSubjects = db
          .prepare('SELECT DISTINCT subject_name AS name, subject_color AS color FROM tasks WHERE user_id = ?')
          .all(auth.user.id);

        const mergedMap = new Map();
        for (const s of groupSubjects) {
          mergedMap.set(s.name, { name: s.name, color: s.color, code: s.code });
        }
        for (const s of taskSubjects) {
          if (!mergedMap.has(s.name)) {
            mergedMap.set(s.name, { name: s.name, color: s.color || '#4f46e5', code: '' });
          }
        }
        return sendJson(res, 200, { subjects: Array.from(mergedMap.values()) });
      }

      if (method === 'GET' && pathname === '/api/tasks') {
        if (!requireRole(auth, res, 'student')) return;
        const subject = cleanControlChars(urlObj.searchParams.get('subject') || '');
        const search = cleanControlChars(urlObj.searchParams.get('search') || '').toLowerCase().slice(0, 120);
        const sort = (urlObj.searchParams.get('sort') || 'due_at').trim();
        const status = (urlObj.searchParams.get('status') || 'all').trim();
        const month = (urlObj.searchParams.get('month') || '').trim();

        const conditions = ['user_id = ?'];
        const params = [auth.user.id];

        if (subject && subject !== 'ALL') {
          conditions.push('subject_name = ?');
          params.push(subject);
        }
        if (search) {
          conditions.push(
            "(lower(title) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\' OR lower(subject_name) LIKE ? ESCAPE '\\')"
          );
          const pattern = `%${escapeLikePattern(search)}%`;
          params.push(pattern, pattern, pattern);
        }
        if (status === 'pending') {
          conditions.push('completed = 0');
        } else if (status === 'completed') {
          conditions.push('completed = 1');
        }
        if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          conditions.push('substr(COALESCE(completed_at, due_at), 1, 7) = ?');
          params.push(month);
        }

        const orderBy =
          sort === 'priority'
            ? "completed ASC, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, due_at ASC"
            : 'completed ASC, due_at ASC';

        const tasks = db
          .prepare(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy}`)
          .all(...params);

        const pendingRow = db
          .prepare('SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed = 0')
          .get(auth.user.id);

        return sendJson(res, 200, {
          tasks,
          pendingCount: pendingRow ? pendingRow.count : 0,
          todayLocal: getLocalDateString(tz),
          nowLocal: getLocalDateTimeString(tz)
        });
      }

      if (method === 'POST' && pathname === '/api/tasks') {
        if (!requireRole(auth, res, 'student')) return;
        if (!checkRate(res, `tasks:${auth.user.id}`, 40, 60_000)) return;

        const body = await parseJsonBody(req);
        const title = cleanControlChars(body.title);
        const subjectName = cleanControlChars(body.subjectName);
        const subjectColor = cleanControlChars(body.subjectColor || '#4f46e5');
        const description = cleanControlChars(body.description, { multiline: true });
        const dueAt = cleanControlChars(body.dueAt);
        const priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium';

        if (!title || !subjectName || !dueAt) {
          return sendJson(res, 400, { error: 'Título, asignatura y fecha límite son campos obligatorios.' });
        }
        if (title.length > 200 || subjectName.length > 120 || description.length > 4000) {
          return sendJson(res, 400, {
            error: 'Se excedió la longitud máxima permitida (título 200, materia 120, notas 4000 caracteres).'
          });
        }
        if (!isValidHexColor(subjectColor)) {
          return sendJson(res, 400, { error: 'El color de asignatura debe tener formato hexadecimal #RRGGBB.' });
        }
        if (!isValidLocalDateTime(dueAt)) {
          return sendJson(res, 400, {
            error: 'Fecha y hora límite inválida en el calendario (usa formato real YYYY-MM-DDTHH:MM).'
          });
        }

        const nowLocal = getLocalDateTimeString(tz);
        if (dueAt < nowLocal) {
          return sendJson(res, 400, {
            error: 'La fecha límite no puede ser previa a la fecha y hora actual.'
          });
        }

        const nowIso = new Date().toISOString();
        const info = db
          .prepare(
            `INSERT INTO tasks (
              user_id, subject_name, subject_color, title, description,
              due_at, priority, completed, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
          )
          .run(auth.user.id, subjectName, subjectColor.toLowerCase(), title, description, dueAt, priority, nowIso, nowIso);

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(info.lastInsertRowid));
        return sendJson(res, 201, { task });
      }

      const taskActionMatch = pathname.match(/^\/api\/tasks\/(\d+)(?:\/(toggle|notification))?$/);
      if (taskActionMatch) {
        if (!requireRole(auth, res, 'student')) return;
        const taskId = Number(taskActionMatch[1]);
        const subAction = taskActionMatch[2] || '';
        const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, auth.user.id);
        if (!task) {
          return sendJson(res, 404, { error: 'Tarea no encontrada.' });
        }

        if (method === 'PUT' && !subAction) {
          const body = await parseJsonBody(req);
          const title = cleanControlChars(body.title ?? task.title);
          const subjectName = cleanControlChars(body.subjectName ?? task.subject_name);
          const subjectColor = cleanControlChars(body.subjectColor ?? task.subject_color);
          const description = cleanControlChars(body.description ?? task.description, { multiline: true });
          const dueAt = cleanControlChars(body.dueAt ?? task.due_at);
          const priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : task.priority;

          if (!title || !subjectName || !dueAt) {
            return sendJson(res, 400, { error: 'Título, asignatura y fecha límite son obligatorios.' });
          }
          if (title.length > 200 || subjectName.length > 120 || description.length > 4000) {
            return sendJson(res, 400, {
              error: 'Se excedió la longitud máxima permitida en los campos de la tarea.'
            });
          }
          if (!isValidHexColor(subjectColor)) {
            return sendJson(res, 400, { error: 'El color de asignatura debe tener formato hexadecimal #RRGGBB.' });
          }
          if (!isValidLocalDateTime(dueAt)) {
            return sendJson(res, 400, { error: 'Fecha y hora límite inválida en el calendario.' });
          }

          if (task.completed && (priority !== task.priority || dueAt !== task.due_at)) {
            return sendJson(res, 400, {
              error: 'No se puede alterar la prioridad ni la fecha límite de una tarea ya completada. Desmárcala primero.'
            });
          }

          const nowLocal = getLocalDateTimeString(tz);
          if (dueAt !== task.due_at && dueAt < nowLocal) {
            return sendJson(res, 400, { error: 'La nueva fecha límite no puede estar en el pasado.' });
          }

          const nowIso = new Date().toISOString();
          db.prepare(
            `UPDATE tasks
             SET title = ?, subject_name = ?, subject_color = ?, description = ?,
                 due_at = ?, priority = ?, updated_at = ?
             WHERE id = ? AND user_id = ?`
          ).run(
            title,
            subjectName,
            subjectColor.toLowerCase(),
            description,
            dueAt,
            priority,
            nowIso,
            taskId,
            auth.user.id
          );

          const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
          return sendJson(res, 200, { task: updated });
        }

        if (method === 'PATCH' && subAction === 'toggle') {
          const nowLocal = getLocalDateTimeString(tz);
          const todayLocal = nowLocal.slice(0, 10);
          const nowIso = new Date().toISOString();

          const toggleResult = withTransaction(db, () => {
            const freshTask = db
              .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
              .get(taskId, auth.user.id);
            let pointsDelta = 0;

            if (!freshTask.completed) {
              const rewardedToday = db
                .prepare(
                  'SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed = 1 AND points_awarded > 0 AND substr(completed_at, 1, 10) = ?'
                )
                .get(auth.user.id, todayLocal).count;

              const rawPts = calculateTaskCompletionPoints(freshTask, nowLocal);
              const pts = rewardedToday >= MAX_DAILY_REWARDED_TASKS ? 0 : rawPts;
              pointsDelta = pts;

              db.prepare(
                `UPDATE tasks
                 SET completed = 1, completed_at = ?, points_awarded = ?, updated_at = ?
                 WHERE id = ?`
              ).run(nowLocal, pts, nowIso, taskId);

              if (pts > 0) {
                db.prepare('UPDATE users SET streak_points = streak_points + ? WHERE id = ?').run(pts, auth.user.id);
              }
            } else {
              const prevPts = freshTask.points_awarded || 0;
              pointsDelta = -prevPts;
              db.prepare(
                `UPDATE tasks
                 SET completed = 0, completed_at = NULL, points_awarded = 0, updated_at = ?
                 WHERE id = ?`
              ).run(nowIso, taskId);
              if (prevPts > 0) {
                db.prepare('UPDATE users SET streak_points = MAX(0, streak_points - ?) WHERE id = ?').run(
                  prevPts,
                  auth.user.id
                );
              }
            }

            const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
            const updatedUser = getUserWithGroupById(db, auth.user.id);
            return { updatedTask, updatedUser, pointsDelta };
          });

          return sendJson(res, 200, {
            task: toggleResult.updatedTask,
            pointsDelta: toggleResult.pointsDelta,
            streakPoints: toggleResult.updatedUser.streakPoints,
            streakDays: toggleResult.updatedUser.streakDays
          });
        }

        if (method === 'DELETE' && !subAction) {
          const todayLocal = getLocalDateString(tz);
          const revertedPoints = withTransaction(db, () => {
            const freshTask = db
              .prepare('SELECT id, completed, completed_at, points_awarded FROM tasks WHERE id = ? AND user_id = ?')
              .get(taskId, auth.user.id);
            let reverted = 0;
            // Anti-exploit: si completa hoy para ganar puntos y borra la tarea el mismo día, se revierten los puntos
            if (
              freshTask &&
              freshTask.completed &&
              freshTask.points_awarded > 0 &&
              String(freshTask.completed_at || '').startsWith(todayLocal)
            ) {
              reverted = freshTask.points_awarded;
              db.prepare('UPDATE users SET streak_points = MAX(0, streak_points - ?) WHERE id = ?').run(
                reverted,
                auth.user.id
              );
            }
            db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, auth.user.id);
            return reverted;
          });

          return sendJson(res, 200, { ok: true, deletedId: taskId, revertedPoints });
        }

        if (method === 'POST' && subAction === 'notification') {
          const body = await parseJsonBody(req);
          if (body.action === 'snooze') {
            const snoozedUntil = Date.now() + 60 * 60 * 1000;
            db.prepare('UPDATE tasks SET snoozed_until = ? WHERE id = ?').run(snoozedUntil, taskId);
            return sendJson(res, 200, { ok: true, snoozedUntil });
          }
          if (body.action === 'dismiss') {
            const todayLocal = getLocalDateString(tz);
            db.prepare('UPDATE tasks SET dismissed_date = ? WHERE id = ?').run(todayLocal, taskId);
            return sendJson(res, 200, { ok: true, dismissedDate: todayLocal });
          }
          return sendJson(res, 400, { error: 'Acción de notificación inválida.' });
        }
      }

      // Racha y personalización (HU-29..HU-37)
      if (method === 'GET' && pathname === '/api/streak') {
        if (!requireRole(auth, res, 'student')) return;
        const themes = getStreakThemesForUser(auth.user.streakDays);
        return sendJson(res, 200, {
          streakDays: auth.user.streakDays,
          bestStreak: auth.user.bestStreak,
          streakPoints: auth.user.streakPoints,
          streakTheme: auth.user.streakTheme,
          themes
        });
      }

      if (method === 'PUT' && pathname === '/api/streak/theme') {
        if (!requireRole(auth, res, 'student')) return;
        const body = await parseJsonBody(req);
        const result = selectStreakTheme(db, auth.user.id, cleanControlChars(body.themeId));
        if (!result.ok) {
          return sendJson(res, result.status, { error: result.error, missingDays: result.missingDays });
        }
        const user = getUserWithGroupById(db, auth.user.id);
        return sendJson(res, 200, { theme: result.theme, user });
      }

      // ------------------------------------------------------------------
      // Asistente Virtual Inteligente (HU-38..HU-42)
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/assistant/messages') {
        if (!requireRole(auth, res, 'student')) return;
        let messages = db
          .prepare('SELECT * FROM assistant_messages WHERE user_id = ? ORDER BY id ASC')
          .all(auth.user.id);
        if (messages.length === 0) {
          const nowIso = new Date().toISOString();
          db.prepare(
            "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'assistant', ?, ?)"
          ).run(auth.user.id, ASSISTANT_WELCOME, nowIso);
          messages = db
            .prepare('SELECT * FROM assistant_messages WHERE user_id = ? ORDER BY id ASC')
            .all(auth.user.id);
        }
        return sendJson(res, 200, { messages });
      }

      if (method === 'POST' && pathname === '/api/assistant/messages') {
        if (!requireRole(auth, res, 'student')) return;
        if (!checkRate(res, `assistant:${auth.user.id}`, 30, 60_000)) return;

        const body = await parseJsonBody(req);
        const content = cleanControlChars(body.content, { multiline: true });
        if (!content) {
          return sendJson(res, 400, { error: 'Escribe un mensaje para el asistente.' });
        }
        if (content.length > 1500) {
          return sendJson(res, 400, { error: 'La consulta al asistente no puede exceder 1500 caracteres.' });
        }

        const replyText = await generateAssistantReply(db, auth.user, content, tz);
        const { userMessage, assistantMessage } = withTransaction(db, () => {
          const nowIso = new Date().toISOString();
          const userMsgId = db
            .prepare(
              "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'user', ?, ?)"
            )
            .run(auth.user.id, content, nowIso).lastInsertRowid;

          const replyIso = new Date().toISOString();
          const botMsgId = db
            .prepare(
              "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'assistant', ?, ?)"
            )
            .run(auth.user.id, replyText, replyIso).lastInsertRowid;

          return {
            userMessage: db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(Number(userMsgId)),
            assistantMessage: db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(Number(botMsgId))
          };
        });

        return sendJson(res, 201, { userMessage, assistantMessage });
      }

      if (method === 'DELETE' && pathname === '/api/assistant/messages') {
        if (!requireRole(auth, res, 'student')) return;
        const welcome = withTransaction(db, () => {
          db.prepare('DELETE FROM assistant_messages WHERE user_id = ?').run(auth.user.id);
          const nowIso = new Date().toISOString();
          const id = db
            .prepare(
              "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'assistant', ?, ?)"
            )
            .run(auth.user.id, ASSISTANT_WELCOME, nowIso).lastInsertRowid;
          return db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(Number(id));
        });
        return sendJson(res, 200, { ok: true, messages: [welcome] });
      }

      // ------------------------------------------------------------------
      // Portal Docente de Exclusiva Consulta con Aislamiento por Grupo (HU-43..HU-46)
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/teacher/groups') {
        if (!requireRole(auth, res, 'teacher')) return;
        const groups = db
          .prepare(
            `SELECT g.id, g.name, g.program,
                    COUNT(DISTINCT u.id) AS studentCount,
                    COUNT(t.id) AS totalTasks,
                    SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END) AS completedTasks
             FROM groups g
             LEFT JOIN users u ON u.group_id = g.id AND u.role = 'student'
             LEFT JOIN tasks t ON t.user_id = u.id
             WHERE EXISTS (
               SELECT 1 FROM subjects s WHERE s.group_id = g.id AND s.teacher_id = ?
             )
             GROUP BY g.id
             ORDER BY g.name ASC`
          )
          .all(auth.user.id)
          .map((g) => ({
            ...g,
            completedTasks: g.completedTasks || 0,
            completionRate: g.totalTasks > 0 ? Math.round(((g.completedTasks || 0) / g.totalTasks) * 100) : 0
          }));
        return sendJson(res, 200, { groups });
      }

      const teacherGroupMatch = pathname.match(/^\/api\/teacher\/groups\/(\d+)\/students$/);
      if (method === 'GET' && teacherGroupMatch) {
        if (!requireRole(auth, res, 'teacher')) return;
        const groupId = Number(teacherGroupMatch[1]);
        if (!teacherTeachesGroup(db, auth.user.id, groupId)) {
          return sendJson(res, 403, {
            error: 'Acceso restringido: solo puedes supervisar grupos donde impartes asignaturas.'
          });
        }
        const students = db
          .prepare(
            `SELECT u.id, u.name, u.email, u.streak_days AS streakDays, u.streak_points AS streakPoints,
                    COUNT(t.id) AS totalTasks,
                    SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END) AS completedTasks
             FROM users u
             LEFT JOIN tasks t ON t.user_id = u.id
             WHERE u.role = 'student' AND u.group_id = ?
             GROUP BY u.id
             ORDER BY u.name ASC`
          )
          .all(groupId)
          .map((s) => ({
            ...s,
            completedTasks: s.completedTasks || 0,
            completionRate: s.totalTasks > 0 ? Math.round(((s.completedTasks || 0) / s.totalTasks) * 100) : 0
          }));
        return sendJson(res, 200, { students });
      }

      const teacherStudentTasksMatch = pathname.match(/^\/api\/teacher\/students\/(\d+)\/tasks$/);
      if (method === 'GET' && teacherStudentTasksMatch) {
        if (!requireRole(auth, res, 'teacher')) return;
        const studentId = Number(teacherStudentTasksMatch[1]);
        const student = db
          .prepare(
            `SELECT u.id, u.name, u.email, u.group_id AS groupId, u.streak_days AS streakDays,
                    u.streak_points AS streakPoints, g.name AS groupName
             FROM users u
             LEFT JOIN groups g ON g.id = u.group_id
             WHERE u.id = ? AND u.role = 'student'`
          )
          .get(studentId);
        if (!student) {
          return sendJson(res, 404, { error: 'Estudiante no encontrado.' });
        }
        if (!teacherTeachesGroup(db, auth.user.id, student.groupId)) {
          return sendJson(res, 403, {
            error: 'Acceso restringido: este estudiante pertenece a un grupo donde no tienes carga académica asignada.'
          });
        }
        const tasks = db
          .prepare(
            'SELECT id, subject_name, subject_color, title, description, due_at, priority, completed, completed_at FROM tasks WHERE user_id = ? ORDER BY completed ASC, due_at ASC'
          )
          .all(studentId);
        return sendJson(res, 200, { student, tasks, readOnly: true });
      }

      if (method === 'GET' && pathname === '/api/teacher/subjects') {
        if (!requireRole(auth, res, 'teacher')) return;
        const subjects = db
          .prepare(
            `SELECT s.id, s.code, s.name, s.color, s.weekly_hours AS weeklyHours,
                    g.id AS groupId, g.name AS groupName,
                    (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.role = 'student') AS enrolledCount
             FROM subjects s
             JOIN groups g ON g.id = s.group_id
             WHERE s.teacher_id = ?
             ORDER BY g.name ASC, s.name ASC`
          )
          .all(auth.user.id);
        return sendJson(res, 200, { subjects });
      }

      if (method === 'POST' && pathname === '/api/teacher/subjects') {
        if (!requireRole(auth, res, 'teacher')) return;
        const body = await parseJsonBody(req);
        const code = cleanControlChars(body.code).toUpperCase();
        const name = cleanControlChars(body.name);
        const color = cleanControlChars(body.color || '#4f46e5');
        const rawHours = Number(body.weeklyHours ?? 4);
        const weeklyHours = Number.isFinite(rawHours) ? Math.max(1, Math.min(20, Math.round(rawHours))) : 4;
        const groupId = Number(body.groupId);

        if (!code || code.length < 2 || code.length > 30 || !name || name.length < 2 || name.length > 120 || !groupId) {
          return sendJson(res, 400, { error: 'Clave (2-30), nombre de materia (2-120) y grupo son obligatorios.' });
        }
        if (!isValidHexColor(color)) {
          return sendJson(res, 400, { error: 'Color inválido (usa formato hexadecimal #RRGGBB).' });
        }
        const grp = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
        if (!grp) return sendJson(res, 400, { error: 'Grupo inválido.' });

        const dup = db
          .prepare('SELECT id FROM subjects WHERE upper(code) = ? AND group_id = ?')
          .get(code, groupId);
        if (dup) {
          return sendJson(res, 409, { error: 'Ya existe una asignatura con esa clave en el grupo seleccionado.' });
        }

        const id = db
          .prepare(
            'INSERT INTO subjects (code, name, color, weekly_hours, group_id, teacher_id) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(code, name, color.toLowerCase(), weeklyHours, groupId, auth.user.id).lastInsertRowid;

        const subject = db
          .prepare(
            `SELECT s.id, s.code, s.name, s.color, s.weekly_hours AS weeklyHours,
                    g.id AS groupId, g.name AS groupName,
                    (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.role = 'student') AS enrolledCount
             FROM subjects s JOIN groups g ON g.id = s.group_id WHERE s.id = ?`
          )
          .get(Number(id));
        return sendJson(res, 201, { subject });
      }

      if (method === 'GET' && pathname === '/api/teacher/schedule') {
        if (!requireRole(auth, res, 'teacher')) return;
        const schedule = db
          .prepare(
            `SELECT sc.id, sc.day_of_week AS dayOfWeek, sc.start_time AS startTime,
                    sc.end_time AS endTime, sc.classroom, sc.building,
                    s.id AS subjectId, s.code AS subjectCode, s.name AS subjectName,
                    s.color AS subjectColor, g.name AS groupName
             FROM schedules sc
             JOIN subjects s ON s.id = sc.subject_id
             JOIN groups g ON g.id = s.group_id
             WHERE s.teacher_id = ?
             ORDER BY sc.day_of_week ASC, sc.start_time ASC`
          )
          .all(auth.user.id);
        return sendJson(res, 200, { schedule });
      }

      if (method === 'POST' && pathname === '/api/teacher/schedule') {
        if (!requireRole(auth, res, 'teacher')) return;
        const body = await parseJsonBody(req);
        const subjectId = Number(body.subjectId);
        const dayOfWeek = Number(body.dayOfWeek);
        const startTime = cleanControlChars(body.startTime);
        const endTime = cleanControlChars(body.endTime);
        const classroom = cleanControlChars(body.classroom);
        const building = cleanControlChars(body.building);

        if (
          !subjectId ||
          !Number.isInteger(dayOfWeek) ||
          dayOfWeek < 1 ||
          dayOfWeek > 5 ||
          !classroom ||
          classroom.length > 80 ||
          !building ||
          building.length > 120
        ) {
          return sendJson(res, 400, {
            error: 'Todos los datos del bloque de horario son obligatorios (Lunes a Viernes).'
          });
        }
        if (!isValidTime24h(startTime) || !isValidTime24h(endTime) || startTime >= endTime) {
          return sendJson(res, 400, {
            error: 'El horario debe tener formato HH:MM válido y la hora de inicio debe ser menor a la hora de término.'
          });
        }

        const sub = db
          .prepare('SELECT id FROM subjects WHERE id = ? AND teacher_id = ?')
          .get(subjectId, auth.user.id);
        if (!sub) return sendJson(res, 404, { error: 'Materia no encontrada para este docente.' });

        // Prevención de traslapes horarios para el mismo docente en el mismo día
        const teacherOverlap = db
          .prepare(
            `SELECT sc.id, s.name AS subjectName, sc.start_time AS startTime, sc.end_time AS endTime
             FROM schedules sc
             JOIN subjects s ON s.id = sc.subject_id
             WHERE s.teacher_id = ? AND sc.day_of_week = ? AND sc.start_time < ? AND sc.end_time > ?
             LIMIT 1`
          )
          .get(auth.user.id, dayOfWeek, endTime, startTime);

        if (teacherOverlap) {
          return sendJson(res, 409, {
            error: `Colisión de horario: se traslapa con "${teacherOverlap.subjectName}" (${teacherOverlap.startTime}–${teacherOverlap.endTime}).`
          });
        }

        const id = db
          .prepare(
            'INSERT INTO schedules (subject_id, day_of_week, start_time, end_time, classroom, building) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(subjectId, dayOfWeek, startTime, endTime, classroom, building).lastInsertRowid;

        const block = db
          .prepare(
            `SELECT sc.id, sc.day_of_week AS dayOfWeek, sc.start_time AS startTime,
                    sc.end_time AS endTime, sc.classroom, sc.building,
                    s.id AS subjectId, s.code AS subjectCode, s.name AS subjectName,
                    s.color AS subjectColor, g.name AS groupName
             FROM schedules sc JOIN subjects s ON s.id = sc.subject_id JOIN groups g ON g.id = s.group_id
             WHERE sc.id = ?`
          )
          .get(Number(id));
        return sendJson(res, 201, { block });
      }

      // ------------------------------------------------------------------
      // Mensajería Privada Texto Plano Cifrada en Reposo AES-256-GCM (HU-47..HU-50)
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/messages/unread-count') {
        return sendJson(res, 200, { unreadMessages: getUnreadMessagesCount(db, auth.user.id) });
      }

      if (method === 'GET' && pathname === '/api/messages/contacts') {
        let contacts = [];
        if (auth.user.role === 'student') {
          contacts = db
            .prepare(
              `SELECT DISTINCT u.id, u.name, u.email, u.role,
                      GROUP_CONCAT(DISTINCT s.name) AS subjectsLabel
               FROM users u
               JOIN subjects s ON s.teacher_id = u.id AND s.group_id = ?
               WHERE u.role = 'teacher'
               GROUP BY u.id
               ORDER BY u.name ASC`
            )
            .all(auth.user.groupId || -1);
        } else {
          contacts = db
            .prepare(
              `SELECT DISTINCT u.id, u.name, u.email, u.role, g.name AS groupName
               FROM users u
               JOIN groups g ON g.id = u.group_id
               WHERE u.role = 'student'
                 AND EXISTS (
                   SELECT 1 FROM subjects s WHERE s.group_id = u.group_id AND s.teacher_id = ?
                 )
               ORDER BY g.name ASC, u.name ASC`
            )
            .all(auth.user.id);
        }

        const enriched = contacts.map((c) => {
          const unread = db
            .prepare(
              'SELECT COUNT(*) AS count FROM private_messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
            )
            .get(c.id, auth.user.id).count;
          const lastMsg = db
            .prepare(
              `SELECT content, created_at FROM private_messages
               WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
               ORDER BY id DESC LIMIT 1`
            )
            .get(auth.user.id, c.id, c.id, auth.user.id);
          return {
            ...c,
            unreadCount: unread,
            lastMessage: lastMsg ? decryptMessageContent(db, lastMsg.content) : null,
            lastMessageAt: lastMsg ? lastMsg.created_at : null
          };
        });

        return sendJson(res, 200, { contacts: enriched });
      }

      const chatContactMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
      if (chatContactMatch) {
        const contactId = Number(chatContactMatch[1]);
        const contact = db
          .prepare(
            `SELECT u.id, u.name, u.email, u.role, u.group_id AS groupId, g.name AS groupName
             FROM users u LEFT JOIN groups g ON g.id = u.group_id WHERE u.id = ?`
          )
          .get(contactId);

        if (!contact || contact.role === auth.user.role) {
          return sendJson(res, 404, { error: 'Contacto académico no disponible para chat privado.' });
        }

        const teacherId = auth.user.role === 'teacher' ? auth.user.id : contact.id;
        const studentGroupId = auth.user.role === 'student' ? auth.user.groupId : contact.groupId;
        if (!teacherTeachesGroup(db, teacherId, studentGroupId)) {
          return sendJson(res, 403, {
            error: 'El chat privado está restringido a docentes y estudiantes que comparten grupo académico.'
          });
        }

        if (method === 'GET') {
          db.prepare(
            'UPDATE private_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
          ).run(contactId, auth.user.id);

          const unreadMessages = getUnreadMessagesCount(db, auth.user.id);
          sseHub.emitToUser(auth.user.id, 'unread_update', { unreadMessages });

          const rows = db
            .prepare(
              `SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, is_read AS isRead, created_at AS createdAt
               FROM private_messages
               WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
               ORDER BY id ASC`
            )
            .all(auth.user.id, contactId, contactId, auth.user.id);

          const messages = rows.map((m) => ({
            ...m,
            content: decryptMessageContent(db, m.content)
          }));

          return sendJson(res, 200, { contact, messages, unreadMessages });
        }

        if (method === 'POST') {
          if (!checkRate(res, `chat:${auth.user.id}`, 30, 60_000)) return;

          const body = await parseJsonBody(req);
          for (const key of FORBIDDEN_CHAT_KEYS) {
            if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
              return sendJson(res, 400, {
                error: 'El chat privado admite exclusivamente mensajes de texto plano (sin archivos ni videollamadas).'
              });
            }
          }

          const content =
            typeof body.content === 'string' ? cleanControlChars(body.content, { multiline: true }) : '';
          if (!content) {
            return sendJson(res, 400, { error: 'Escribe un mensaje de texto antes de enviar.' });
          }
          if (content.length > 2000) {
            return sendJson(res, 400, { error: 'El mensaje no puede exceder los 2000 caracteres.' });
          }

          const nowIso = new Date().toISOString();
          const encryptedContent = db.vault ? db.vault.encrypt(content) : content;
          const msgId = db
            .prepare(
              'INSERT INTO private_messages (sender_id, receiver_id, content, is_read, created_at) VALUES (?, ?, ?, 0, ?)'
            )
            .run(auth.user.id, contactId, encryptedContent, nowIso).lastInsertRowid;

          const storedRow = db
            .prepare(
              'SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, is_read AS isRead, created_at AS createdAt FROM private_messages WHERE id = ?'
            )
            .get(Number(msgId));

          const message = {
            ...storedRow,
            content: decryptMessageContent(db, storedRow.content)
          };

          const receiverUnread = getUnreadMessagesCount(db, contactId);
          sseHub.emitToUser(contactId, 'private_message', {
            message,
            senderName: auth.user.name,
            unreadMessages: receiverUnread
          });
          sseHub.emitToUser(contactId, 'unread_update', { unreadMessages: receiverUnread });

          return sendJson(res, 201, { message });
        }
      }

      return sendJson(res, 404, { error: 'Ruta de API no encontrada.' });
    } catch (err) {
      const status = err.status || 500;
      const safeMessage =
        status >= 500 ? 'Error interno del servidor al procesar la solicitud.' : err.message;
      return sendJson(res, status, { error: safeMessage });
    }
  });

  server.on('close', () => {
    sseHub.closeAll();
    try {
      db.close();
    } catch {
      // Ignorado si ya estaba cerrada
    }
  });

  return { server, db };
}

// Arranque directo cuando se ejecuta con node server/index.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createAppServer();
  server.listen(port, () => {
    console.log(`Plataforma Web Académica UPFIM (SQLite 3 Blindado) ejecutándose en http://localhost:${port}`);
  });
}
