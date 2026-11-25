import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createAppServer } from '../server/index.js';
import { addCalendarDays, getLocalDateString, getLocalDateTimeString } from '../server/db.js';
import { evaluateDailyStreak } from '../server/streak.js';

const TZ = 'America/Mexico_City';

async function startTestServer(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upfim-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const { server, db } = createAppServer({ dbPath, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function api(urlPath, { method = 'GET', token, body } = {}) {
    const headers = { 'X-Client-Timezone': TZ };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { baseUrl, db, api, close };
}

test('HU-01..HU-06: Registro, login por rol, recuperación de contraseña y actualización de perfil', async () => {
  const app = await startTestServer();
  try {
    const groupsRes = await app.api('/api/groups');
    assert.equal(groupsRes.status, 200);
    assert.ok(groupsRes.data.groups.length >= 2);

    // Login demo estudiante y verificación de racha (7 -> 8 por haber entrado ayer en seed)
    const loginStudent = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    assert.equal(loginStudent.status, 200);
    assert.equal(loginStudent.data.user.role, 'student');
    assert.equal(loginStudent.data.user.streakDays, 8);
    assert.ok(loginStudent.data.token);

    // Login erróneo
    const badLogin = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'WrongPassword' }
    });
    assert.equal(badLogin.status, 401);

    // Registro nuevo estudiante
    const reg = await app.api('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Alumno Prueba',
        email: 'alumno.prueba@upfim.edu.mx',
        password: 'ClaveSegura1',
        role: 'student',
        groupId: groupsRes.data.groups[0].id
      }
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.user.streakDays, 1);

    // Validación de correo en perfil (HU-05 Escenario 2)
    const badProfile = await app.api('/api/profile', {
      method: 'PUT',
      token: reg.data.token,
      body: { name: 'Alumno Prueba', email: 'correo-invalido' }
    });
    assert.equal(badProfile.status, 400);

    // Recuperación de contraseña autónoma (HU-04)
    const forgot = await app.api('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'alumno.prueba@upfim.edu.mx' }
    });
    assert.equal(forgot.status, 200);
    const resetToken = forgot.data.demoInbox.resetToken;
    assert.ok(resetToken);

    const reset = await app.api('/api/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, newPassword: 'NuevaClave99' }
    });
    assert.equal(reset.status, 200);

    const loginNewPass = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'alumno.prueba@upfim.edu.mx', password: 'NuevaClave99' }
    });
    assert.equal(loginNewPass.status, 200);
  } finally {
    await app.close();
  }
});

test('HU-02: Expiración automática de sesión por inactividad', async () => {
  const app = await startTestServer({ inactivityMs: 60 });
  try {
    const login = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    assert.equal(login.status, 200);
    const token = login.data.token;

    await new Promise((r) => setTimeout(r, 90));
    const me = await app.api('/api/auth/me', { token });
    assert.equal(me.status, 401);
    assert.equal(me.data.code, 'SESSION_EXPIRED');
  } finally {
    await app.close();
  }
});

test('HU-11..HU-27: CRUD de tareas, bloqueo de fecha vencida, filtros, ordenamiento y notificaciones', async () => {
  const app = await startTestServer();
  try {
    const login = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    const token = login.data.token;

    const today = getLocalDateString(TZ);
    const yesterday = addCalendarDays(today, -1);
    const tomorrow = addCalendarDays(today, 1);

    // Bloqueo de fecha vencida (HU-17 Escenario 2)
    const pastTask = await app.api('/api/tasks', {
      method: 'POST',
      token,
      body: {
        title: 'Tarea pasada inválida',
        subjectName: 'Física',
        dueAt: `${yesterday}T23:59`,
        priority: 'high'
      }
    });
    assert.equal(pastTask.status, 400);

    // Alta válida (HU-11)
    const created = await app.api('/api/tasks', {
      method: 'POST',
      token,
      body: {
        title: 'Examen parcial de Física',
        subjectName: 'Física',
        subjectColor: '#0284c7',
        dueAt: `${tomorrow}T23:59`,
        priority: 'high',
        description: 'Estudiar capítulos 1 al 4'
      }
    });
    assert.equal(created.status, 201);
    const taskId = created.data.task.id;

    // Filtro por materia y búsqueda (HU-20, HU-22)
    const filtered = await app.api('/api/tasks?subject=F%C3%ADsica&search=Examen&sort=priority', { token });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.data.tasks.length, 1);
    assert.equal(filtered.data.tasks[0].id, taskId);

    // Posponer y descartar notificación (HU-27)
    const snooze = await app.api(`/api/tasks/${taskId}/notification`, {
      method: 'POST',
      token,
      body: { action: 'snooze' }
    });
    assert.equal(snooze.status, 200);
    assert.ok(snooze.data.snoozedUntil > Date.now());

    const dismiss = await app.api(`/api/tasks/${taskId}/notification`, {
      method: 'POST',
      token,
      body: { action: 'dismiss' }
    });
    assert.equal(dismiss.status, 200);
    assert.equal(dismiss.data.dismissedDate, today);

    // Eliminación permanente (HU-14)
    const del = await app.api(`/api/tasks/${taskId}`, { method: 'DELETE', token });
    assert.equal(del.status, 200);
  } finally {
    await app.close();
  }
});

test('HU-29..HU-37: Racha diaria, reinicio, puntos anti-exploit, extemporáneas y desbloqueo de temas', async () => {
  const app = await startTestServer();
  try {
    const login = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    const token = login.data.token;
    const userId = login.data.user.id;
    const initialPoints = login.data.user.streakPoints;

    // Segundo login el mismo día NO duplica la racha (HU-29 Escenario 2)
    const login2 = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    assert.equal(login2.data.user.streakDays, 8);

    // Crear tarea futura prioridad Alta (+30 pts al completar)
    const futureDate = addCalendarDays(getLocalDateString(TZ), 2);
    const tFuture = await app.api('/api/tasks', {
      method: 'POST',
      token,
      body: {
        title: 'Entrega puntual alta',
        subjectName: 'Arquitectura Cloud',
        dueAt: `${futureDate}T20:00`,
        priority: 'high'
      }
    });
    const fId = tFuture.data.task.id;

    // Completar a tiempo -> +30 pts
    const tog1 = await app.api(`/api/tasks/${fId}/toggle`, { method: 'PATCH', token });
    assert.equal(tog1.status, 200);
    assert.equal(tog1.data.pointsDelta, 30);
    assert.equal(tog1.data.streakPoints, initialPoints + 30);

    // Desmarcar -> revierte exactamente los -30 pts (anti-exploit HU-13)
    const tog2 = await app.api(`/api/tasks/${fId}/toggle`, { method: 'PATCH', token });
    assert.equal(tog2.data.pointsDelta, -30);
    assert.equal(tog2.data.streakPoints, initialPoints);

    // Tarea vencida completada extemporáneamente -> 0 puntos (HU-30 Escenario 2)
    const pastIso = getLocalDateTimeString(TZ, new Date(Date.now() - 3 * 3600 * 1000));
    const expiredInsert = app.db
      .prepare(
        `INSERT INTO tasks (user_id, subject_name, subject_color, title, description, due_at, priority, completed, created_at, updated_at)
         VALUES (?, 'Redes', '#2563eb', 'Entrega vencida', '', ?, 'high', 0, ?, ?)`
      )
      .run(userId, pastIso, new Date().toISOString(), new Date().toISOString());
    const expRes = await app.api(`/api/tasks/${Number(expiredInsert.lastInsertRowid)}/toggle`, {
      method: 'PATCH',
      token
    });
    assert.equal(expRes.data.pointsDelta, 0);

    // Bloqueo de tema Fuego Dorado (15 días) cuando solo tiene 8 días (HU-35 Escenario 2)
    const lockedTheme = await app.api('/api/streak/theme', {
      method: 'PUT',
      token,
      body: { themeId: 'golden' }
    });
    assert.equal(lockedTheme.status, 403);
    assert.equal(lockedTheme.data.missingDays, 7);

    // Tema desbloqueado Llama Ártica (7 días) -> permitido
    const okTheme = await app.api('/api/streak/theme', {
      method: 'PUT',
      token,
      body: { themeId: 'arctic' }
    });
    assert.equal(okTheme.status, 200);

    // Reinicio por faltar más de 1 día (HU-32)
    const threeDaysAgo = addCalendarDays(getLocalDateString(TZ), -3);
    app.db.prepare('UPDATE users SET last_streak_date = ? WHERE id = ?').run(threeDaysAgo, userId);
    const resetEval = evaluateDailyStreak(app.db, userId, TZ);
    assert.equal(resetEval.status, 'reset');
    assert.equal(resetEval.streakDays, 1);
  } finally {
    await app.close();
  }
});

test('HU-38..HU-42: Asistente Inteligente (organización real, ayuda sitio, guardrail escolar y vaciado)', async () => {
  const app = await startTestServer();
  try {
    const login = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    const token = login.data.token;

    // Plan de organización basado en tareas reales (HU-39)
    const org = await app.api('/api/assistant/messages', {
      method: 'POST',
      token,
      body: { content: 'Tengo varias tareas esta semana, ¿cómo me organizo?' }
    });
    assert.equal(org.status, 201);
    assert.ok(org.data.assistantMessage.content.includes('•'));

    // Ayuda de filtros del sitio (HU-40)
    const help = await app.api('/api/assistant/messages', {
      method: 'POST',
      token,
      body: { content: '¿Cómo puedo filtrar las tareas por materia?' }
    });
    assert.equal(help.status, 201);
    assert.match(help.data.assistantMessage.content, /desplegable|etiqueta/i);

    // Guardrail estricto ante ecuación escolar (HU-41)
    const blocked = await app.api('/api/assistant/messages', {
      method: 'POST',
      token,
      body: { content: 'Resuélveme este problema de matemáticas: 2x + 5 = 15' }
    });
    assert.equal(blocked.status, 201);
    assert.match(blocked.data.assistantMessage.content, /no puedo resolver/i);
    assert.doesNotMatch(blocked.data.assistantMessage.content, /\bx\s*=\s*5\b/i);

    // Vaciar conversación (HU-42)
    const cleared = await app.api('/api/assistant/messages', { method: 'DELETE', token });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.messages.length, 1);
    assert.equal(cleared.data.messages[0].sender, 'assistant');
  } finally {
    await app.close();
  }
});

test('HU-43..HU-50: Portal Docente (exclusiva consulta) y Chat Privado texto plano con badges', async () => {
  const app = await startTestServer();
  try {
    const teacherLogin = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'daniel.hernandez@upfim.edu.mx', password: 'Demo1234!' }
    });
    assert.equal(teacherLogin.status, 200);
    assert.equal(teacherLogin.data.user.role, 'teacher');
    const teacherToken = teacherLogin.data.token;

    const studentLogin = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    const studentToken = studentLogin.data.token;
    const studentId = studentLogin.data.user.id;
    const teacherId = teacherLogin.data.user.id;

    // Docente NO puede crear tareas en el módulo estudiantil (HU-46)
    const forbiddenTaskCreate = await app.api('/api/tasks', {
      method: 'POST',
      token: teacherToken,
      body: { title: 'Asignar tarea', subjectName: 'TI', dueAt: '2026-12-30T23:59', priority: 'high' }
    });
    assert.equal(forbiddenTaskCreate.status, 403);

    // Portal docente consulta grupos, alumnos, expediente, materias y horario (HU-43..HU-45)
    const groups = await app.api('/api/teacher/groups', { token: teacherToken });
    assert.equal(groups.status, 200);
    assert.ok(groups.data.groups.length >= 2);

    const students = await app.api(`/api/teacher/groups/${groups.data.groups[0].id}/students`, {
      token: teacherToken
    });
    assert.equal(students.status, 200);

    const dossier = await app.api(`/api/teacher/students/${studentId}/tasks`, { token: teacherToken });
    assert.equal(dossier.status, 200);
    assert.equal(dossier.data.readOnly, true);

    const subjects = await app.api('/api/teacher/subjects', { token: teacherToken });
    assert.equal(subjects.status, 200);
    assert.ok(subjects.data.subjects.length >= 4);

    const schedule = await app.api('/api/teacher/schedule', { token: teacherToken });
    assert.equal(schedule.status, 200);
    assert.ok(schedule.data.schedule.length >= 5);

    // Chat privado: rechazo de adjuntos/archivos (HU-50)
    const badChat = await app.api(`/api/messages/${studentId}`, {
      method: 'POST',
      token: teacherToken,
      body: { content: 'Mira este archivo', attachment: 'tarea.pdf' }
    });
    assert.equal(badChat.status, 400);

    // Envío válido de texto plano e incremento de badge no leídos (HU-48, HU-49)
    const sent = await app.api(`/api/messages/${studentId}`, {
      method: 'POST',
      token: teacherToken,
      body: { content: 'Hola, revisé tus tareas de esta semana y vas muy bien.' }
    });
    assert.equal(sent.status, 201);

    const unreadBefore = await app.api('/api/messages/unread-count', { token: studentToken });
    assert.ok(unreadBefore.data.unreadMessages >= 2); // 1 del seed + 1 nuevo

    // Al abrir la conversación del docente se limpia el contador de no leídos (HU-49 Escenario 2)
    const thread = await app.api(`/api/messages/${teacherId}`, { token: studentToken });
    assert.equal(thread.status, 200);
    assert.equal(thread.data.unreadMessages, 0);
  } finally {
    await app.close();
  }
});

test('BLINDAJE-01: SQLite 3 PRAGMAs, sesiones SHA-256, cifrado AES-256-GCM en reposo y bitácora inmutable', async () => {
  const app = await startTestServer();
  try {
    const teacherLogin = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'daniel.hernandez@upfim.edu.mx', password: 'Demo1234!' }
    });
    assert.equal(teacherLogin.status, 200);
    const rawToken = teacherLogin.data.token;

    // 1. Ningún token de sesión en claro se almacena en SQLite 3 (solo token_hash SHA-256)
    const rawMatch = app.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?').get(rawToken);
    assert.equal(rawMatch.count, 0);
    const activeSessions = app.db.prepare('SELECT token_hash FROM sessions').all();
    assert.ok(activeSessions.length >= 1);
    assert.equal(activeSessions[0].token_hash.length, 64);

    // 2. Mensajes privados almacenados cifrados con AES-256-GCM en disco y descifrados transparentemente por API
    const studentRow = app.db.prepare("SELECT id FROM users WHERE email = 'estudiante@upfim.edu.mx'").get();
    const secretText = 'Retroalimentación confidencial cifrada en SQLite 3.';
    const sent = await app.api(`/api/messages/${studentRow.id}`, {
      method: 'POST',
      token: teacherLogin.data.token,
      body: { content: secretText }
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.data.message.content, secretText);

    const diskRow = app.db
      .prepare('SELECT content FROM private_messages WHERE id = ?')
      .get(sent.data.message.id);
    assert.ok(diskRow.content.startsWith('enc:v1:'), 'El contenido en SQLite debe estar cifrado con AES-256-GCM');
    assert.ok(!diskRow.content.includes('Retroalimentación'), 'El texto plano no debe aparecer en disco');

    // 3. Bitácora audit_logs inmutable (triggers BEFORE UPDATE y BEFORE DELETE bloquean manipulación SQL directa)
    assert.throws(() => {
      app.db.exec("DELETE FROM audit_logs WHERE id = 1;");
    }, /inmutable|eliminar/i);
    assert.throws(() => {
      app.db.exec("UPDATE audit_logs SET action = 'HACKED' WHERE id = 1;");
    }, /inmutable/i);

    // 4. Diagnóstico de blindaje y respaldo atómico VACUUM INTO
    const statusRes = await app.api('/api/security/status', { token: rawToken });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.integrityOk, true);
    assert.equal(statusRes.data.pragmas.journalMode, 'wal');
    assert.equal(statusRes.data.pragmas.foreignKeys, true);
    assert.equal(statusRes.data.pragmas.secureDelete, true);
    assert.equal(statusRes.data.encryption.allEncryptedAtRest, true);
    assert.equal(statusRes.data.auditChain.ok, true);

    const backupRes = await app.api('/api/security/backup', { method: 'POST', token: rawToken });
    assert.equal(backupRes.status, 201);
    assert.ok(backupRes.data.backup.fileName.endsWith('.sqlite'));
    assert.ok(backupRes.data.backup.sizeBytes > 0);
  } finally {
    await app.close();
  }
});

test('BLINDAJE-02: Anti-escalación de rol, bloqueo por fuerza bruta, aislamiento IDOR, anti-XSS/CSS y anti-farming', async () => {
  const app = await startTestServer({ teacherAccessCode: 'CLAVE-INST-TEST' });
  try {
    // 1. Bloqueo de escalación de privilegios al intentar registrarse como docente sin código institucional
    const fakeTeacher = await app.api('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Intruso Docente',
        email: 'intruso@upfim.edu.mx',
        password: 'ClaveFuerte1',
        role: 'teacher'
      }
    });
    assert.equal(fakeTeacher.status, 403);

    // Registro legítimo de un nuevo docente con código válido (sin grupos asignados aún)
    const validTeacher = await app.api('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Mtra. Laura Soto',
        email: 'laura.soto@upfim.edu.mx',
        password: 'ClaveFuerte1',
        role: 'teacher',
        teacherCode: 'CLAVE-INST-TEST'
      }
    });
    assert.equal(validTeacher.status, 201);
    const newTeacherToken = validTeacher.data.token;

    // 2. Aislamiento horizontal (anti-IDOR): docente sin materias en el grupo 7TIDG2 no puede espiar expedientes ajenos
    const studentRow = app.db.prepare("SELECT id, group_id FROM users WHERE email = 'estudiante@upfim.edu.mx'").get();
    const idorDossier = await app.api(`/api/teacher/students/${studentRow.id}/tasks`, {
      token: newTeacherToken
    });
    assert.equal(idorDossier.status, 403);

    const idorChat = await app.api(`/api/messages/${studentRow.id}`, {
      method: 'POST',
      token: newTeacherToken,
      body: { content: 'Intento de contacto fuera de grupo' }
    });
    assert.equal(idorChat.status, 403);

    // 3. Prevención de XSS en avatarUrl e inyección CSS en colores y fechas calendario imposibles
    const studentLogin = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'estudiante@upfim.edu.mx', password: 'Demo1234!' }
    });
    const studentToken = studentLogin.data.token;

    const xssAvatar = await app.api('/api/profile', {
      method: 'PUT',
      token: studentToken,
      body: {
        name: 'Heidy Areli Hernández',
        email: 'estudiante@upfim.edu.mx',
        avatarUrl: 'https://evil.test/x" onerror="alert(1)'
      }
    });
    assert.equal(xssAvatar.status, 400);

    const cssInjectionTask = await app.api('/api/tasks', {
      method: 'POST',
      token: studentToken,
      body: {
        title: 'Tarea maliciosa',
        subjectName: 'Seguridad',
        subjectColor: '#ff0000; position:fixed; inset:0',
        dueAt: '2027-05-10T12:00',
        priority: 'high'
      }
    });
    assert.equal(cssInjectionTask.status, 400);

    const impossibleDateTask = await app.api('/api/tasks', {
      method: 'POST',
      token: studentToken,
      body: {
        title: 'Fecha inexistente',
        subjectName: 'Seguridad',
        subjectColor: '#4f46e5',
        dueAt: '2027-02-31T12:00',
        priority: 'high'
      }
    });
    assert.equal(impossibleDateTask.status, 400);

    // 4. Anti-farming: completar tarea hoy (+30 pts) y eliminarla revierte los puntos otorgados
    const ptsBefore = (await app.api('/api/streak', { token: studentToken })).data.streakPoints;
    const tomorrow = addCalendarDays(getLocalDateString(TZ), 1);
    const farmTask = await app.api('/api/tasks', {
      method: 'POST',
      token: studentToken,
      body: {
        title: 'Intento farming puntos',
        subjectName: 'Seguridad',
        subjectColor: '#4f46e5',
        dueAt: `${tomorrow}T20:00`,
        priority: 'high'
      }
    });
    const farmId = farmTask.data.task.id;
    await app.api(`/api/tasks/${farmId}/toggle`, { method: 'PATCH', token: studentToken });
    const delFarm = await app.api(`/api/tasks/${farmId}`, { method: 'DELETE', token: studentToken });
    assert.equal(delFarm.data.revertedPoints, 30);
    const ptsAfter = (await app.api('/api/streak', { token: studentToken })).data.streakPoints;
    assert.equal(ptsAfter, ptsBefore);

    // 5. Detección de traslape de horarios docentes
    const mainTeacherLogin = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'daniel.hernandez@upfim.edu.mx', password: 'Demo1234!' }
    });
    const tSubs = await app.api('/api/teacher/subjects', { token: mainTeacherLogin.data.token });
    const overlapSchedule = await app.api('/api/teacher/schedule', {
      method: 'POST',
      token: mainTeacherLogin.data.token,
      body: {
        subjectId: tSubs.data.subjects[0].id,
        dayOfWeek: 1,
        startTime: '08:30',
        endTime: '09:30',
        classroom: 'Aula 999',
        building: 'Edificio Docencia II'
      }
    });
    assert.equal(overlapSchedule.status, 409);

    // 6. Bloqueo temporal de cuenta tras 5 intentos fallidos de contraseña
    for (let i = 0; i < 4; i++) {
      const attempt = await app.api('/api/auth/login', {
        method: 'POST',
        body: { email: 'carlos.mendez@upfim.edu.mx', password: 'WrongPassword1' }
      });
      assert.equal(attempt.status, 401);
    }
    const fifthAttempt = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'carlos.mendez@upfim.edu.mx', password: 'WrongPassword1' }
    });
    assert.equal(fifthAttempt.status, 423);
    assert.equal(fifthAttempt.data.code, 'ACCOUNT_LOCKED');

    // Incluso con la contraseña correcta queda bloqueada durante la ventana de seguridad
    const lockedEvenCorrect = await app.api('/api/auth/login', {
      method: 'POST',
      body: { email: 'carlos.mendez@upfim.edu.mx', password: 'Demo1234!' }
    });
    assert.equal(lockedEvenCorrect.status, 423);
  } finally {
    await app.close();
  }
});
