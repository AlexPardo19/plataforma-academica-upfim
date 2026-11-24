import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDatabase,
  DEFAULT_TIMEZONE,
  getLocalDateString,
  getLocalDateTimeString,
  normalizeTimeZone
} from './db.js';
import {
  createPasswordResetToken,
  createSession,
  DEFAULT_INACTIVITY_LIMIT_MS,
  destroySession,
  hashPassword,
  resetPasswordWithToken,
  sanitizeUser,
  validateSession,
  verifyPassword
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function parseJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) {
      throw Object.assign(new Error('El cuerpo de la solicitud excede 1 MB.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('JSON inválido en la solicitud.'), { status: 400 });
  }
}

function getTokenFromRequest(req, urlObj) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return urlObj.searchParams.get('token') || '';
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

function serveStaticFile(reqPath, res) {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, cleanRel);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // Fallback SPA para rutas no API
    target = path.join(PUBLIC_DIR, 'index.html');
  }

  if (!fs.existsSync(target)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(target).pipe(res);
}

/**
 * Crea la instancia del servidor HTTP y base de datos SQLite.
 */
export function createAppServer(options = {}) {
  const dbPath = options.dbPath || path.resolve(__dirname, '..', 'data', 'academico.sqlite');
  const inactivityLimitMs =
    options.inactivityMs ??
    (Number(process.env.SESSION_INACTIVITY_MS) || DEFAULT_INACTIVITY_LIMIT_MS);

  const db = createDatabase(dbPath);
  seedDatabaseIfEmpty(db, DEFAULT_TIMEZONE);
  const sseHub = createSseHub();

  function requireAuth(req, res, urlObj) {
    const token = getTokenFromRequest(req, urlObj);
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
        return sendJson(res, 200, { ok: true, timeZone: tz });
      }

      if (method === 'GET' && pathname === '/api/groups') {
        const groups = db.prepare('SELECT id, name, program FROM groups ORDER BY name ASC').all();
        return sendJson(res, 200, { groups });
      }

      // ------------------------------------------------------------------
      // Autenticación, Registro, Recuperación y Perfil (HU-01..HU-10)
      // ------------------------------------------------------------------
      if (method === 'POST' && pathname === '/api/auth/register') {
        const body = await parseJsonBody(req);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const role = body.role === 'teacher' ? 'teacher' : 'student';

        if (name.length < 2) {
          return sendJson(res, 400, { error: 'Ingresa tu nombre completo.' });
        }
        if (!EMAIL_REGEX.test(email)) {
          return sendJson(res, 400, { error: 'El correo electrónico no tiene un formato válido.' });
        }
        if (password.length < 6) {
          return sendJson(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
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

        const token = createSession(db, userId);
        const user = getUserWithGroupById(db, userId);
        return sendJson(res, 201, { token, user, streakEvent, unreadMessages: 0 });
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await parseJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        const userRow = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
        if (!userRow || !verifyPassword(password, userRow.password_hash)) {
          return sendJson(res, 401, { error: 'Correo electrónico o contraseña incorrectos.' });
        }

        let streakEvent = null;
        if (userRow.role === 'student') {
          streakEvent = evaluateDailyStreak(db, userRow.id, tz);
        }

        const token = createSession(db, userRow.id);
        const user = getUserWithGroupById(db, userRow.id);
        const unreadMessages = getUnreadMessagesCount(db, userRow.id);
        return sendJson(res, 200, { token, user, streakEvent, unreadMessages });
      }

      if (method === 'POST' && pathname === '/api/auth/forgot-password') {
        const body = await parseJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!EMAIL_REGEX.test(email)) {
          return sendJson(res, 400, { error: 'Ingresa un correo electrónico válido.' });
        }
        const resetData = createPasswordResetToken(db, email);
        if (!resetData) {
          return sendJson(res, 200, {
            ok: true,
            message: 'Si el correo existe en la plataforma, se ha generado un enlace de recuperación válido por 15 minutos.'
          });
        }
        return sendJson(res, 200, {
          ok: true,
          message: 'Se generó tu enlace seguro de recuperación (válido por 15 minutos).',
          demoInbox: {
            email: resetData.user.email,
            resetToken: resetData.token,
            expiresAt: resetData.expiresAt,
            note: 'Modo local autónomo: en cumplimiento de limitaciones del sitio, el enlace se muestra en esta bandeja segura sin envío SMTP externo.'
          }
        });
      }

      if (method === 'POST' && pathname === '/api/auth/reset-password') {
        const body = await parseJsonBody(req);
        const result = resetPasswordWithToken(
          db,
          String(body.token || '').trim(),
          String(body.newPassword || '')
        );
        if (!result.ok) {
          return sendJson(res, 400, { error: result.error });
        }
        return sendJson(res, 200, { ok: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
      }

      // ------------------------------------------------------------------
      // Rutas autenticadas a partir de este punto
      // ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/events') {
        const auth = requireAuth(req, res, urlObj);
        if (!auth) return;
        sseHub.registerClient(auth.user.id, res);
        return;
      }

      const auth = requireAuth(req, res, urlObj);
      if (!auth) return;

      if (method === 'POST' && pathname === '/api/auth/logout') {
        destroySession(db, auth.token);
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const unreadMessages = getUnreadMessagesCount(db, auth.user.id);
        return sendJson(res, 200, { user: auth.user, unreadMessages });
      }

      if (method === 'PUT' && pathname === '/api/profile') {
        const body = await parseJsonBody(req);
        const name = String(body.name ?? auth.user.name).trim();
        const email = String(body.email ?? auth.user.email).trim().toLowerCase();
        const avatarUrl = String(body.avatarUrl ?? auth.user.avatarUrl ?? '').trim();

        if (name.length < 2) {
          return sendJson(res, 400, { error: 'El nombre debe tener al menos 2 caracteres.' });
        }
        if (!EMAIL_REGEX.test(email)) {
          return sendJson(res, 400, { error: 'Corrige el formato del correo electrónico.' });
        }
        if (
          avatarUrl &&
          !avatarUrl.startsWith('https://') &&
          !avatarUrl.startsWith('http://') &&
          !avatarUrl.startsWith('data:image/')
        ) {
          return sendJson(res, 400, { error: 'La URL de fotografía debe usar http(s) o imagen válida.' });
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

        db.prepare('UPDATE users SET name = ?, email = ?, avatar_url = ?, group_id = ? WHERE id = ?').run(
          name,
          email,
          avatarUrl,
          groupId,
          auth.user.id
        );
        return sendJson(res, 200, { user: getUserWithGroupById(db, auth.user.id) });
      }

      if (method === 'POST' && pathname === '/api/profile/tutorial') {
        const body = await parseJsonBody(req);
        const completed = body.completed === false ? 0 : 1;
        db.prepare('UPDATE users SET tutorial_completed = ? WHERE id = ?').run(completed, auth.user.id);
        return sendJson(res, 200, { ok: true, tutorialCompleted: Boolean(completed) });
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
        const subject = (urlObj.searchParams.get('subject') || '').trim();
        const search = (urlObj.searchParams.get('search') || '').trim().toLowerCase();
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
          conditions.push('(lower(title) LIKE ? OR lower(description) LIKE ? OR lower(subject_name) LIKE ?)');
          const pattern = `%${search}%`;
          params.push(pattern, pattern, pattern);
        }
        if (status === 'pending') {
          conditions.push('completed = 0');
        } else if (status === 'completed') {
          conditions.push('completed = 1');
        }
        if (month && /^\d{4}-\d{2}$/.test(month)) {
          conditions.push("substr(COALESCE(completed_at, due_at), 1, 7) = ?");
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
        const body = await parseJsonBody(req);
        const title = String(body.title || '').trim();
        const subjectName = String(body.subjectName || '').trim();
        const subjectColor = String(body.subjectColor || '#4f46e5').trim();
        const description = String(body.description || '').trim();
        const dueAt = String(body.dueAt || '').trim();
        const priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium';

        if (!title || !subjectName || !dueAt) {
          return sendJson(res, 400, { error: 'Título, asignatura y fecha límite son campos obligatorios.' });
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueAt)) {
          return sendJson(res, 400, { error: 'Formato de fecha y hora límite inválido (usa YYYY-MM-DDTHH:MM).' });
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
          .run(auth.user.id, subjectName, subjectColor, title, description, dueAt, priority, nowIso, nowIso);

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
          const title = String(body.title ?? task.title).trim();
          const subjectName = String(body.subjectName ?? task.subject_name).trim();
          const subjectColor = String(body.subjectColor ?? task.subject_color).trim();
          const description = String(body.description ?? task.description).trim();
          const dueAt = String(body.dueAt ?? task.due_at).trim();
          const priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : task.priority;

          if (!title || !subjectName || !dueAt) {
            return sendJson(res, 400, { error: 'Título, asignatura y fecha límite son obligatorios.' });
          }
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueAt)) {
            return sendJson(res, 400, { error: 'Formato de fecha y hora límite inválido.' });
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
          ).run(title, subjectName, subjectColor, description, dueAt, priority, nowIso, taskId, auth.user.id);

          const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
          return sendJson(res, 200, { task: updated });
        }

        if (method === 'PATCH' && subAction === 'toggle') {
          const nowLocal = getLocalDateTimeString(tz);
          const nowIso = new Date().toISOString();
          let pointsDelta = 0;

          if (!task.completed) {
            const pts = calculateTaskCompletionPoints(task, nowLocal);
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
            const prevPts = task.points_awarded || 0;
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
          return sendJson(res, 200, {
            task: updatedTask,
            pointsDelta,
            streakPoints: updatedUser.streakPoints,
            streakDays: updatedUser.streakDays
          });
        }

        if (method === 'DELETE' && !subAction) {
          db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, auth.user.id);
          return sendJson(res, 200, { ok: true, deletedId: taskId });
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
        const result = selectStreakTheme(db, auth.user.id, String(body.themeId || ''));
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
        const body = await parseJsonBody(req);
        const content = String(body.content || '').trim();
        if (!content) {
          return sendJson(res, 400, { error: 'Escribe un mensaje para el asistente.' });
        }

        const nowIso = new Date().toISOString();
        const userMsgId = db
          .prepare(
            "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'user', ?, ?)"
          )
          .run(auth.user.id, content, nowIso).lastInsertRowid;

        const replyText = await generateAssistantReply(db, auth.user, content, tz);
        const replyIso = new Date().toISOString();
        const botMsgId = db
          .prepare(
            "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'assistant', ?, ?)"
          )
          .run(auth.user.id, replyText, replyIso).lastInsertRowid;

        const userMessage = db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(Number(userMsgId));
        const assistantMessage = db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(Number(botMsgId));
        return sendJson(res, 201, { userMessage, assistantMessage });
      }

      if (method === 'DELETE' && pathname === '/api/assistant/messages') {
        if (!requireRole(auth, res, 'student')) return;
        db.prepare('DELETE FROM assistant_messages WHERE user_id = ?').run(auth.user.id);
        const nowIso = new Date().toISOString();
        const id = db
          .prepare(
            "INSERT INTO assistant_messages (user_id, sender, content, created_at) VALUES (?, 'assistant', ?, ?)"
          )
          .run(auth.user.id, ASSISTANT_WELCOME, nowIso).lastInsertRowid;
        const welcome = db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(Number(id));
        return sendJson(res, 200, { ok: true, messages: [welcome] });
      }

      // ------------------------------------------------------------------
      // Portal Docente de Exclusiva Consulta (HU-43..HU-46)
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
             GROUP BY g.id
             ORDER BY g.name ASC`
          )
          .all()
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
            `SELECT u.id, u.name, u.email, u.streak_days AS streakDays, u.streak_points AS streakPoints, g.name AS groupName
             FROM users u
             LEFT JOIN groups g ON g.id = u.group_id
             WHERE u.id = ? AND u.role = 'student'`
          )
          .get(studentId);
        if (!student) {
          return sendJson(res, 404, { error: 'Estudiante no encontrado.' });
        }
        const tasks = db
          .prepare('SELECT id, subject_name, subject_color, title, description, due_at, priority, completed, completed_at FROM tasks WHERE user_id = ? ORDER BY completed ASC, due_at ASC')
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
        const code = String(body.code || '').trim().toUpperCase();
        const name = String(body.name || '').trim();
        const color = String(body.color || '#4f46e5').trim();
        const weeklyHours = Math.max(1, Math.min(20, Number(body.weeklyHours || 4)));
        const groupId = Number(body.groupId);

        if (!code || !name || !groupId) {
          return sendJson(res, 400, { error: 'Clave, nombre de materia y grupo son obligatorios.' });
        }
        const grp = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
        if (!grp) return sendJson(res, 400, { error: 'Grupo inválido.' });

        const id = db
          .prepare(
            'INSERT INTO subjects (code, name, color, weekly_hours, group_id, teacher_id) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(code, name, color, weeklyHours, groupId, auth.user.id).lastInsertRowid;

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
        const startTime = String(body.startTime || '').trim();
        const endTime = String(body.endTime || '').trim();
        const classroom = String(body.classroom || '').trim();
        const building = String(body.building || '').trim();

        if (!subjectId || dayOfWeek < 1 || dayOfWeek > 5 || !startTime || !endTime || !classroom || !building) {
          return sendJson(res, 400, { error: 'Todos los datos del bloque de horario son obligatorios (Lunes a Viernes).' });
        }
        const sub = db.prepare('SELECT id FROM subjects WHERE id = ? AND teacher_id = ?').get(subjectId, auth.user.id);
        if (!sub) return sendJson(res, 404, { error: 'Materia no encontrada para este docente.' });

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
      // Mensajería Privada Texto Plano (HU-47..HU-50)
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
               LEFT JOIN subjects s ON s.teacher_id = u.id AND s.group_id = ?
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
               LEFT JOIN groups g ON g.id = u.group_id
               WHERE u.role = 'student'
               ORDER BY g.name ASC, u.name ASC`
            )
            .all();
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
            lastMessage: lastMsg ? lastMsg.content : null,
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
            `SELECT u.id, u.name, u.email, u.role, g.name AS groupName
             FROM users u LEFT JOIN groups g ON g.id = u.group_id WHERE u.id = ?`
          )
          .get(contactId);

        if (!contact || contact.role === auth.user.role) {
          return sendJson(res, 404, { error: 'Contacto académico no disponible para chat privado.' });
        }

        if (method === 'GET') {
          db.prepare(
            'UPDATE private_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
          ).run(contactId, auth.user.id);

          const unreadMessages = getUnreadMessagesCount(db, auth.user.id);
          sseHub.emitToUser(auth.user.id, 'unread_update', { unreadMessages });

          const messages = db
            .prepare(
              `SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, is_read AS isRead, created_at AS createdAt
               FROM private_messages
               WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
               ORDER BY id ASC`
            )
            .all(auth.user.id, contactId, contactId, auth.user.id);

          return sendJson(res, 200, { contact, messages, unreadMessages });
        }

        if (method === 'POST') {
          const body = await parseJsonBody(req);
          for (const key of FORBIDDEN_CHAT_KEYS) {
            if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
              return sendJson(res, 400, {
                error: 'El chat privado admite exclusivamente mensajes de texto plano (sin archivos ni videollamadas).'
              });
            }
          }

          const content = typeof body.content === 'string' ? body.content.trim() : '';
          if (!content) {
            return sendJson(res, 400, { error: 'Escribe un mensaje de texto antes de enviar.' });
          }
          if (content.length > 2000) {
            return sendJson(res, 400, { error: 'El mensaje no puede exceder los 2000 caracteres.' });
          }

          const nowIso = new Date().toISOString();
          const msgId = db
            .prepare(
              'INSERT INTO private_messages (sender_id, receiver_id, content, is_read, created_at) VALUES (?, ?, ?, 0, ?)'
            )
            .run(auth.user.id, contactId, content, nowIso).lastInsertRowid;

          const message = db
            .prepare(
              'SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, is_read AS isRead, created_at AS createdAt FROM private_messages WHERE id = ?'
            )
            .get(Number(msgId));

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
      return sendJson(res, status, { error: err.message || 'Error interno del servidor.' });
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
    console.log(`Plataforma Web Académica UPFIM ejecutándose en http://localhost:${port}`);
  });
}
