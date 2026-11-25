import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDataVault, hashToken } from './security.js';

export const DEFAULT_TIMEZONE = 'America/Mexico_City';

const txDepthMap = new WeakMap();

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
 * Ejecuta un bloque síncrono dentro de una transacción atómica SQLite 3 (BEGIN IMMEDIATE),
 * soportando anidamiento seguro mediante SAVEPOINT.
 */
export function withTransaction(db, fn) {
  const depth = txDepthMap.get(db) || 0;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE;');
    txDepthMap.set(db, 1);
    try {
      const result = fn();
      db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Ignorado si SQLite ya revirtió la transacción
      }
      throw err;
    } finally {
      txDepthMap.set(db, 0);
    }
  }

  const spName = `sp_nested_${depth}`;
  db.exec(`SAVEPOINT ${spName};`);
  txDepthMap.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${spName};`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${spName}; RELEASE SAVEPOINT ${spName};`);
    } catch {
      // Ignorado
    }
    throw err;
  } finally {
    txDepthMap.set(db, depth);
  }
}

function getColumnNames(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((r) => r.name));
}

function hardenFilePermissions(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  try {
    fs.chmodSync(path.dirname(dbPath), 0o700);
  } catch {
    // Ignorado si no aplica
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) {
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        // Ignorado si no aplica
      }
    }
  }
}

function computeAuditHash({ prevHash, userId, action, severity, ipAddress, detailsJson, createdAt }) {
  const payload = [
    prevHash,
    userId ?? 'anon',
    action,
    severity,
    ipAddress || '',
    detailsJson,
    createdAt
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Registra un evento en la bitácora inmutable audit_logs con encadenamiento SHA-256 (tamper-evident).
 */
export function appendAuditLog(
  db,
  { userId = null, action, severity = 'info', ipAddress = '', details = {} }
) {
  return withTransaction(db, () => {
    const last = db.prepare('SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get();
    const prevHash = last ? last.entry_hash : 'GENESIS_UPFIM_SQLITE3';
    const createdAt = new Date().toISOString();
    const detailsJson = JSON.stringify(details || {});
    const entryHash = computeAuditHash({
      prevHash,
      userId,
      action,
      severity,
      ipAddress,
      detailsJson,
      createdAt
    });

    db.prepare(
      `INSERT INTO audit_logs (user_id, action, severity, ip_address, details_json, created_at, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, action, severity, String(ipAddress || '').slice(0, 64), detailsJson, createdAt, prevHash, entryHash);

    return { createdAt, prevHash, entryHash };
  });
}

/**
 * Verifica criptográficamente toda la cadena SHA-256 de audit_logs para detectar manipulaciones externas al archivo SQLite.
 */
export function verifyAuditChain(db) {
  const rows = db
    .prepare(
      'SELECT id, user_id, action, severity, ip_address, details_json, created_at, prev_hash, entry_hash FROM audit_logs ORDER BY id ASC'
    )
    .all();

  let expectedPrev = 'GENESIS_UPFIM_SQLITE3';
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, totalEntries: rows.length, brokenAtId: row.id, reason: 'PREV_HASH_MISMATCH' };
    }
    const recomputed = computeAuditHash({
      prevHash: row.prev_hash,
      userId: row.user_id,
      action: row.action,
      severity: row.severity,
      ipAddress: row.ip_address,
      detailsJson: row.details_json,
      createdAt: row.created_at
    });
    if (recomputed !== row.entry_hash) {
      return { ok: false, totalEntries: rows.length, brokenAtId: row.id, reason: 'ENTRY_HASH_TAMPERED' };
    }
    expectedPrev = row.entry_hash;
  }

  return {
    ok: true,
    totalEntries: rows.length,
    headHash: expectedPrev
  };
}

/**
 * Limpia artefactos efímeros vencidos (sesiones expiradas, enlaces de reseteo caducados y tickets SSE).
 */
export function purgeExpiredArtifacts(db, nowMs = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
  db.prepare('DELETE FROM password_resets WHERE expires_at <= ? OR used = 1').run(nowMs - 60_000);
  db.prepare('DELETE FROM sse_tickets WHERE expires_at <= ?').run(nowMs);
}

/**
 * Diagnostica en tiempo real el estado de blindaje, integridad física, PRAGMAs y cifrado de SQLite 3.
 */
export function getDatabaseSecurityStatus(db, dbPath) {
  const versionRow = db.prepare('SELECT sqlite_version() AS version').get();
  const quickCheck = db.prepare('PRAGMA quick_check').all();
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  const journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode || 'unknown';
  const foreignKeys = Boolean(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys);
  const secureDelete = Boolean(db.prepare('PRAGMA secure_delete').get()?.secure_delete);
  const synchronous = db.prepare('PRAGMA synchronous').get()?.synchronous ?? null;
  const busyTimeout = db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0;

  const msgStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN content LIKE 'enc:v1:%' THEN 1 ELSE 0 END) AS encryptedCount
       FROM private_messages`
    )
    .get();

  const sessionStats = db.prepare('SELECT COUNT(*) AS activeSessions FROM sessions WHERE expires_at > ?').get(Date.now());
  const auditVerification = verifyAuditChain(db);

  let fileSizeBytes = 0;
  let fileModeOctal = 'memory';
  if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    const st = fs.statSync(dbPath);
    fileSizeBytes = st.size;
    fileModeOctal = (st.mode & 0o777).toString(8).padStart(4, '0');
  }

  const backupDir =
    dbPath && dbPath !== ':memory:' ? path.join(path.dirname(dbPath), 'backups') : null;
  let backups = [];
  if (backupDir && fs.existsSync(backupDir)) {
    backups = fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.sqlite'))
      .sort()
      .reverse()
      .slice(0, 5)
      .map((name) => {
        const st = fs.statSync(path.join(backupDir, name));
        return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
      });
  }

  const integrityOk =
    quickCheck.length === 1 && quickCheck[0].quick_check === 'ok' && fkViolations.length === 0;

  return {
    engine: `SQLite ${versionRow?.version || '3.x'}`,
    integrityOk,
    quickCheck: quickCheck.map((r) => r.quick_check),
    foreignKeyViolations: fkViolations.length,
    pragmas: {
      journalMode,
      foreignKeys,
      secureDelete,
      synchronous,
      busyTimeoutMs: busyTimeout
    },
    encryption: {
      algorithm: db.vault?.algorithm || 'AES-256-GCM',
      totalPrivateMessages: msgStats?.total || 0,
      encryptedMessages: msgStats?.encryptedCount || 0,
      allEncryptedAtRest: (msgStats?.total || 0) === (msgStats?.encryptedCount || 0)
    },
    sessions: {
      activeHashedSessions: sessionStats?.activeSessions || 0,
      rawTokensStored: 0
    },
    auditChain: auditVerification,
    storage: {
      fileSizeBytes,
      fileModeOctal,
      backups
    }
  };
}

/**
 * Crea un respaldo consistente y atómico en caliente usando VACUUM INTO de SQLite 3,
 * aplicando permisos 0600 y rotación automática de los últimos 5 archivos.
 */
export function createDatabaseBackup(db, dbPath, maxBackups = 5) {
  if (!dbPath || dbPath === ':memory:') {
    throw Object.assign(new Error('No se puede respaldar a disco una base en memoria (:memory:).'), {
      status: 400
    });
  }

  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `academico-backup-${stamp}.sqlite`;
  const targetPath = path.join(backupDir, fileName);
  const escapedTarget = targetPath.replace(/'/g, "''");

  db.exec(`VACUUM INTO '${escapedTarget}';`);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    // Ignorado si no aplica
  }

  // Rotación de respaldos antiguos conservando los más recientes
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.sqlite'))
    .sort();

  while (files.length > maxBackups) {
    const oldest = files.shift();
    if (oldest) {
      fs.rmSync(path.join(backupDir, oldest), { force: true });
    }
  }

  const st = fs.statSync(targetPath);
  return {
    fileName,
    sizeBytes: st.size,
    createdAt: st.mtime.toISOString()
  };
}

function migrateExistingDatabase(db, vault) {
  // 1. Columnas de protección anti-fuerza bruta en users
  const userCols = getColumnNames(db, 'users');
  if (userCols.size > 0) {
    if (!userCols.has('failed_login_attempts')) {
      db.exec('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;');
    }
    if (!userCols.has('locked_until')) {
      db.exec('ALTER TABLE users ADD COLUMN locked_until INTEGER DEFAULT NULL;');
    }
    if (!userCols.has('password_changed_at')) {
      db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT DEFAULT NULL;');
    }
  }

  // 2. Migrar tabla sessions si aún guardaba token en texto plano
  const sessionCols = getColumnNames(db, 'sessions');
  if (sessionCols.size > 0 && !sessionCols.has('token_hash')) {
    const legacySessions = db.prepare('SELECT token, user_id, created_at, last_activity_at FROM sessions').all();
    db.exec('DROP TABLE sessions;');
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip_address TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const ins = db.prepare(
      `INSERT INTO sessions (token_hash, user_id, ip_address, user_agent, created_at, last_activity_at, expires_at)
       VALUES (?, ?, 'migrated', 'legacy-session', ?, ?, ?)`
    );
    const defaultTtl = 8 * 60 * 60 * 1000;
    for (const s of legacySessions) {
      if (s.token) {
        ins.run(hashToken(s.token), s.user_id, s.created_at, s.last_activity_at, s.created_at + defaultTtl);
      }
    }
  }

  // 3. Migrar tabla password_resets si aún guardaba token en texto plano
  const resetCols = getColumnNames(db, 'password_resets');
  if (resetCols.size > 0 && !resetCols.has('token_hash')) {
    db.exec('DROP TABLE password_resets;');
  }

  // 4. Deduplicar asignaturas previas si existían claves repetidas por grupo antes del índice único
  const subjectCols = getColumnNames(db, 'subjects');
  if (subjectCols.size > 0) {
    db.exec(`
      DELETE FROM subjects
      WHERE id NOT IN (
        SELECT MIN(id) FROM subjects GROUP BY upper(code), group_id
      );
    `);
  }

  // 5. Cifrar en reposo (AES-256-GCM) cualquier mensaje privado que estuviera en texto plano
  const msgCols = getColumnNames(db, 'private_messages');
  if (msgCols.size > 0 && vault) {
    const plainRows = db
      .prepare("SELECT id, content FROM private_messages WHERE content NOT LIKE 'enc:v1:%'")
      .all();
    if (plainRows.length > 0) {
      const upd = db.prepare('UPDATE private_messages SET content = ? WHERE id = ?');
      for (const row of plainRows) {
        upd.run(vault.encrypt(row.content), row.id);
      }
    }
  }
}

/**
 * Inicializa, migra y blinda la base de datos SQLite 3 del proyecto usando node:sqlite.
 */
export function createDatabase(dbPath, options = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }

  const keyFilePath =
    dbPath !== ':memory:' ? path.join(path.dirname(dbPath), '.master.key') : undefined;
  const vault = createDataVault({
    secretKey: options.encryptionKey,
    keyFilePath
  });

  const db = new DatabaseSync(dbPath);
  db.vault = vault;

  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA secure_delete = ON;');
  db.exec('PRAGMA temp_store = MEMORY;');
  try {
    db.exec('PRAGMA trusted_schema = OFF;');
  } catch {
    // Ignorado en compilaciones donde no exista este PRAGMA
  }

  withTransaction(db, () => {
    migrateExistingDatabase(db, vault);

    db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 60),
        program TEXT NOT NULL CHECK (length(trim(program)) BETWEEN 2 AND 180)
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
        email TEXT NOT NULL UNIQUE CHECK (length(trim(email)) BETWEEN 5 AND 160),
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
        group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        tutorial_completed INTEGER NOT NULL DEFAULT 0 CHECK (tutorial_completed IN (0, 1)),
        streak_days INTEGER NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
        best_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
        streak_points INTEGER NOT NULL DEFAULT 0 CHECK (streak_points >= 0),
        last_streak_date TEXT DEFAULT NULL,
        streak_theme TEXT NOT NULL DEFAULT 'classic',
        failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
        locked_until INTEGER DEFAULT NULL,
        password_changed_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip_address TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS sse_tickets (
        ticket_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL CHECK (length(trim(code)) BETWEEN 2 AND 30),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
        color TEXT NOT NULL DEFAULT '#4f46e5',
        weekly_hours INTEGER NOT NULL DEFAULT 4 CHECK (weekly_hours BETWEEN 1 AND 20),
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        classroom TEXT NOT NULL CHECK (length(trim(classroom)) BETWEEN 1 AND 80),
        building TEXT NOT NULL CHECK (length(trim(building)) BETWEEN 1 AND 120)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_name TEXT NOT NULL CHECK (length(trim(subject_name)) BETWEEN 1 AND 120),
        subject_color TEXT NOT NULL DEFAULT '#4f46e5',
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
        due_at TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')) DEFAULT 'medium',
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        completed_at TEXT DEFAULT NULL,
        points_awarded INTEGER NOT NULL DEFAULT 0 CHECK (points_awarded >= 0),
        snoozed_until INTEGER DEFAULT NULL,
        dismissed_date TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assistant_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 8000),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
        created_at TEXT NOT NULL,
        CHECK (sender_id != receiver_id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
        ip_address TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id, due_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_completed ON tasks(user_id, completed, completed_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_subjects_group ON subjects(group_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_code_group ON subjects(code, group_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_subject_day ON schedules(subject_id, day_of_week, start_time);
      CREATE INDEX IF NOT EXISTS idx_private_msg_pair ON private_messages(sender_id, receiver_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_private_msg_unread ON private_messages(receiver_id, is_read);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

      -- Triggers de inmutabilidad en audit_logs (Append-Only Ledger)
      CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
      BEFORE UPDATE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'Violación de integridad: audit_logs es inmutable (append-only).');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
      BEFORE DELETE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'Violación de integridad: no se permite eliminar registros de audit_logs.');
      END;

      -- Triggers declarativos de validación de dominio en tareas, horarios y mensajes
      CREATE TRIGGER IF NOT EXISTS trg_tasks_validate_insert
      BEFORE INSERT ON tasks
      WHEN length(trim(NEW.title)) = 0
        OR length(NEW.title) > 200
        OR length(trim(NEW.subject_name)) = 0
        OR length(NEW.subject_name) > 120
        OR length(NEW.description) > 4000
        OR NEW.subject_color NOT GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'
        OR NEW.points_awarded < 0
      BEGIN
        SELECT RAISE(ABORT, 'Datos de tarea inválidos según políticas de integridad SQLite.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_tasks_validate_update
      BEFORE UPDATE ON tasks
      WHEN length(trim(NEW.title)) = 0
        OR length(NEW.title) > 200
        OR length(trim(NEW.subject_name)) = 0
        OR length(NEW.subject_name) > 120
        OR length(NEW.description) > 4000
        OR NEW.subject_color NOT GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'
        OR NEW.points_awarded < 0
      BEGIN
        SELECT RAISE(ABORT, 'Actualización de tarea inválida según políticas de integridad SQLite.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_schedules_validate_insert
      BEFORE INSERT ON schedules
      WHEN NEW.start_time >= NEW.end_time OR NEW.day_of_week < 1 OR NEW.day_of_week > 5
      BEGIN
        SELECT RAISE(ABORT, 'El bloque horario debe tener hora de inicio menor a la hora de fin (Lunes a Viernes).');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_schedules_validate_update
      BEFORE UPDATE ON schedules
      WHEN NEW.start_time >= NEW.end_time OR NEW.day_of_week < 1 OR NEW.day_of_week > 5
      BEGIN
        SELECT RAISE(ABORT, 'El bloque horario debe tener hora de inicio menor a la hora de fin (Lunes a Viernes).');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_private_messages_no_self
      BEFORE INSERT ON private_messages
      WHEN NEW.sender_id = NEW.receiver_id
      BEGIN
        SELECT RAISE(ABORT, 'No se permite enviar mensajes privados al mismo usuario.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_users_non_negative_streak
      BEFORE UPDATE ON users
      WHEN NEW.streak_days < 0 OR NEW.best_streak < 0 OR NEW.streak_points < 0
      BEGIN
        SELECT RAISE(ABORT, 'Los indicadores de racha y puntos no pueden ser negativos.');
      END;
    `);
  });

  hardenFilePermissions(dbPath);
  return db;
}
