import { hashPassword } from './auth.js';
import {
  addCalendarDays,
  appendAuditLog,
  DEFAULT_TIMEZONE,
  getLocalDateString,
  getLocalDateTimeString
} from './db.js';

/**
 * Inserta datos semilla académicos (grupos UPFIM, docente, alumnos, materias, horario, tareas y chats)
 * únicamente cuando la tabla de grupos está vacía.
 */
export function seedDatabaseIfEmpty(db, timeZone = DEFAULT_TIMEZONE) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM groups').get();
  if (existing.count > 0) return;

  const now = new Date();
  const todayStr = getLocalDateString(timeZone, now);
  const yesterdayStr = addCalendarDays(todayStr, -1);
  const tomorrowStr = addCalendarDays(todayStr, 1);
  const inTwoDaysStr = addCalendarDays(todayStr, 2);
  const inThreeDaysStr = addCalendarDays(todayStr, 3);
  const twoDaysAgoStr = addCalendarDays(todayStr, -2);
  const fiveDaysAgoStr = addCalendarDays(todayStr, -5);
  const soonDateTime = getLocalDateTimeString(timeZone, new Date(now.getTime() + 75 * 60 * 1000));
  const nowIso = now.toISOString();

  // 1. Grupos
  const insertGroup = db.prepare('INSERT INTO groups (name, program) VALUES (?, ?)');
  const g7 = insertGroup.run('7TIDG2', 'Ing. en Tecnologías de la Información e Innovación Digital').lastInsertRowid;
  const g4 = insertGroup.run('4° B', 'Ing. en Tecnologías de la Información e Innovación Digital').lastInsertRowid;

  // 2. Usuarios demo (contraseña común: Demo1234!)
  const demoPass = hashPassword('Demo1234!');
  const insertUser = db.prepare(`
    INSERT INTO users (
      name, email, password_hash, role, group_id, avatar_url,
      tutorial_completed, streak_days, best_streak, streak_points,
      last_streak_date, streak_theme, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const teacherId = insertUser.run(
    'Ing. Daniel Hernández Pérez',
    'daniel.hernandez@upfim.edu.mx',
    demoPass,
    'teacher',
    null,
    '',
    1,
    0,
    0,
    0,
    null,
    'classic',
    nowIso
  ).lastInsertRowid;

  const student1Id = insertUser.run(
    'Heidy Areli Hernández',
    'estudiante@upfim.edu.mx',
    demoPass,
    'student',
    g7,
    '',
    0, // Primera sesión muestra tutorial emergente (HU-07)
    7,
    12,
    140,
    yesterdayStr, // Al iniciar hoy sumará +1 -> 8 días de racha
    'arctic',
    nowIso
  ).lastInsertRowid;

  const student2Id = insertUser.run(
    'Ivonne Andrade Candelaria',
    'ivonne.andrade@upfim.edu.mx',
    demoPass,
    'student',
    g7,
    '',
    1,
    15,
    15,
    310,
    todayStr,
    'golden',
    nowIso
  ).lastInsertRowid;

  const student3Id = insertUser.run(
    'Carlos Méndez Pérez',
    'carlos.mendez@upfim.edu.mx',
    demoPass,
    'student',
    g4,
    '',
    1,
    3,
    6,
    60,
    todayStr,
    'emerald',
    nowIso
  ).lastInsertRowid;

  // 3. Materias por grupo asignadas al docente
  const insertSubject = db.prepare(`
    INSERT INTO subjects (code, name, color, weekly_hours, group_id, teacher_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const subForm = insertSubject.run('TI-701', 'Formulación de Proyectos de TI', '#4f46e5', 5, g7, teacherId).lastInsertRowid;
  const subIng = insertSubject.run('TI-702', 'Ingeniería de Software', '#0d9488', 5, g7, teacherId).lastInsertRowid;
  const subCloud = insertSubject.run('TI-703', 'Arquitectura Cloud', '#d97706', 4, g7, teacherId).lastInsertRowid;
  const subWeb = insertSubject.run('TI-704', 'Desarrollo Web Avanzado', '#db2777', 5, g7, teacherId).lastInsertRowid;
  const subMath = insertSubject.run('TI-401', 'Matemáticas para Ingeniería', '#0284c7', 5, g4, teacherId).lastInsertRowid;

  // 4. Horario semanal del docente (Lunes=1 .. Viernes=5)
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (subject_id, day_of_week, start_time, end_time, classroom, building)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertSchedule.run(subForm, 1, '08:00', '10:00', 'Aula 204', 'Edificio Docencia II');
  insertSchedule.run(subIng, 1, '10:00', '12:00', 'Lab. Cómputo 2', 'Centro de Cómputo');
  insertSchedule.run(subCloud, 2, '08:00', '10:00', 'Lab. Redes 1', 'Centro de Cómputo');
  insertSchedule.run(subWeb, 2, '11:00', '13:00', 'Lab. Cómputo 1', 'Centro de Cómputo');
  insertSchedule.run(subForm, 3, '09:00', '11:00', 'Aula 204', 'Edificio Docencia II');
  insertSchedule.run(subMath, 3, '11:00', '13:00', 'Aula 102', 'Edificio Docencia I');
  insertSchedule.run(subIng, 4, '08:00', '10:00', 'Lab. Cómputo 2', 'Centro de Cómputo');
  insertSchedule.run(subWeb, 4, '10:00', '12:00', 'Lab. Cómputo 1', 'Centro de Cómputo');
  insertSchedule.run(subCloud, 5, '09:00', '11:00', 'Lab. Redes 1', 'Centro de Cómputo');
  insertSchedule.run(subMath, 5, '11:00', '13:00', 'Aula 102', 'Edificio Docencia I');

  // 5. Tareas iniciales realistas
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      user_id, subject_name, subject_color, title, description, due_at,
      priority, completed, completed_at, points_awarded, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Tarea que vence pronto (< 2 horas) para probar alertas internas HU-25
  insertTask.run(
    student1Id,
    'Formulación de Proyectos de TI',
    '#4f46e5',
    'Subir Diagrama de Ishikawa v2 y matriz 6M',
    'Revisar las 6 categorías principales y verificar que las subcausas correspondan a problemas reales.',
    soonDateTime,
    'high',
    0,
    null,
    0,
    nowIso,
    nowIso
  );

  insertTask.run(
    student1Id,
    'Ingeniería de Software',
    '#0d9488',
    'Validar criterios de aceptación Sprint 1',
    'Comprobar los 50 casos de prueba derivados de las historias de usuario.',
    `${todayStr}T23:59`,
    'medium',
    0,
    null,
    0,
    nowIso,
    nowIso
  );

  insertTask.run(
    student1Id,
    'Desarrollo Web Avanzado',
    '#db2777',
    'Práctica de endpoints REST con validación JSON',
    'Implementar pruebas de integración para rutas protegidas por rol.',
    `${tomorrowStr}T18:00`,
    'high',
    0,
    null,
    0,
    nowIso,
    nowIso
  );

  insertTask.run(
    student1Id,
    'Arquitectura Cloud',
    '#d97706',
    'Cuadro comparativo de servicios serverless vs IaaS',
    'Incluir estimación de costos mensuales para 200 estudiantes activos.',
    `${inTwoDaysStr}T20:00`,
    'low',
    0,
    null,
    0,
    nowIso,
    nowIso
  );

  insertTask.run(
    student1Id,
    'Formulación de Proyectos de TI',
    '#4f46e5',
    'Repasar cálculos PERT/CPM y ruta crítica',
    'Confirmar holguras de actividades A, B, C, D y E antes del examen.',
    `${inThreeDaysStr}T17:00`,
    'medium',
    0,
    null,
    0,
    nowIso,
    nowIso
  );

  // Tareas completadas en el historial (HU-24)
  insertTask.run(
    student1Id,
    'Formulación de Proyectos de TI',
    '#4f46e5',
    'Cargar 50 Historias de Usuario en Jira',
    'Asignar épicas y fechas límite en el backlog del equipo.',
    `${twoDaysAgoStr}T23:59`,
    'high',
    1,
    `${twoDaysAgoStr}T19:15`,
    30,
    nowIso,
    nowIso
  );

  insertTask.run(
    student1Id,
    'Ingeniería de Software',
    '#0d9488',
    'Definir Matriz RACI del equipo',
    'Delimitar responsables A/R/C/I por cada módulo del sistema.',
    `${fiveDaysAgoStr}T20:00`,
    'medium',
    1,
    `${fiveDaysAgoStr}T16:40`,
    20,
    nowIso,
    nowIso
  );

  // Tareas de otros estudiantes (para el Portal Docente HU-43)
  insertTask.run(
    student2Id,
    'Formulación de Proyectos de TI',
    '#4f46e5',
    'Documentar Matriz RACI en reporte final',
    'Integrar tabla comparativa de EDT por entregables.',
    `${tomorrowStr}T21:00`,
    'high',
    0,
    null,
    0,
    nowIso,
    nowIso
  );
  insertTask.run(
    student2Id,
    'Arquitectura Cloud',
    '#d97706',
    'Configurar certificados TLS y variables de entorno',
    'Verificar HTTPS en entorno de pruebas.',
    `${yesterdayStr}T20:00`,
    'medium',
    1,
    `${yesterdayStr}T18:10`,
    20,
    nowIso,
    nowIso
  );
  insertTask.run(
    student3Id,
    'Matemáticas para Ingeniería',
    '#0284c7',
    'Serie de ejercicios de ecuaciones lineales',
    'Resolver guía de ejercicios del capítulo 3.',
    `${tomorrowStr}T23:59`,
    'medium',
    0,
    null,
    0,
    nowIso,
    nowIso
  );

  // 6. Mensaje inicial en chat privado Docente -> Alumno (cifrado en reposo AES-256-GCM)
  const rawWelcomeChat =
    'Hola Heidy, recuerda revisar las fechas límite de tus entregas de esta semana. Si tienes alguna duda de organización puedes escribirme por aquí.';
  const storedWelcomeChat = db.vault ? db.vault.encrypt(rawWelcomeChat) : rawWelcomeChat;
  db.prepare(
    `INSERT INTO private_messages (sender_id, receiver_id, content, is_read, created_at)
     VALUES (?, ?, ?, 0, ?)`
  ).run(teacherId, student1Id, storedWelcomeChat, nowIso);

  // 7. Saludo inicial del Asistente Inteligente
  db.prepare(
    `INSERT INTO assistant_messages (user_id, sender, content, created_at)
     VALUES (?, 'assistant', ?, ?)`
  ).run(
    student1Id,
    '¡Hola! Soy tu Asistente Académico Inteligente. Puedo ayudarte a organizar tus tareas por prioridad, explicarte cómo usar los filtros, rachas o el portal, y planear tus bloques de estudio. (Nota: no resuelvo ejercicios ni contenidos de tus materias).',
    nowIso
  );

  appendAuditLog(db, {
    userId: null,
    action: 'SYSTEM_SEED_INITIALIZED',
    severity: 'info',
    ipAddress: '127.0.0.1',
    details: { groups: 2, users: 4, encryptedPrivateMessages: true }
  });
}
