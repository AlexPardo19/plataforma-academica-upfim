import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_TIMEZONE = 'America/Mexico_City';

/**
 * Valida una zona horaria IANA; si es inválida o vacía, retorna America/Mexico_City.
 */
export function normalizeTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return DEFAULT_TIMEZONE;
  const clean = tz.trim();
  if (!clean) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: clean }).format(new Date());
    return clean;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Retorna la fecha calendario local en formato YYYY-MM-DD según la zona horaria indicada.
 */
export function getLocalDateString(timeZone = DEFAULT_TIMEZONE, date = new Date()) {
  const tz = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Retorna fecha y hora local en formato YYYY-MM-DDTHH:MM (compatible con input datetime-local).
 */
export function getLocalDateTimeString(timeZone = DEFAULT_TIMEZONE, date = new Date()) {
  const tz = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
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

/**
 * Retorna los componentes locales actuales (fecha, hora, día de semana 1..7 donde 1=Lunes).
 */
export function getLocalDateTimeParts(timeZone = DEFAULT_TIMEZONE, date = new Date()) {
  const dateStr = getLocalDateString(timeZone, date);
  const dateTimeStr = getLocalDateTimeString(timeZone, date);
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isoWeekday = utcDay === 0 ? 7 : utcDay;
  return {
    dateStr,
    dateTimeStr,
    timeStr: dateTimeStr.slice(11, 16),
    isoWeekday
  };
}

/**
 * Suma o resta días calendario puros sobre una cadena YYYY-MM-DD.
 */
export function addCalendarDays(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Calcula diferencia entera en días calendario (toDateStr - fromDateStr).
 */
export function diffCalendarDays(fromDateStr, toDateStr) {
  const [y1, m1, d1] = fromDateStr.split('-').map(Number);
  const [y2, m2, d2] = toDateStr.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86_400_000);
}

/**
 * Inicializa y migra la base de datos SQLite del proyecto usando node:sqlite.
 */
export function createDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      program TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      tutorial_completed INTEGER NOT NULL DEFAULT 0,
      streak_days INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      streak_points INTEGER NOT NULL DEFAULT 0,
      last_streak_date TEXT DEFAULT NULL,
      streak_theme TEXT NOT NULL DEFAULT 'classic',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4f46e5',
      weekly_hours INTEGER NOT NULL DEFAULT 4,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      classroom TEXT NOT NULL,
      building TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject_name TEXT NOT NULL,
      subject_color TEXT NOT NULL DEFAULT '#4f46e5',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_at TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')) DEFAULT 'medium',
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT DEFAULT NULL,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      snoozed_until INTEGER DEFAULT NULL,
      dismissed_date TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS private_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subjects_group ON subjects(group_id);
    CREATE INDEX IF NOT EXISTS idx_private_msg_pair ON private_messages(sender_id, receiver_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_private_msg_unread ON private_messages(receiver_id, is_read);
  `);

  return db;
}
