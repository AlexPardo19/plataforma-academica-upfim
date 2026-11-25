import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENCRYPTION_PREFIX = 'enc:v1:';
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const TIME_24H_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATA_IMAGE_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/**
 * Calcula un hash SHA-256 determinista para tokens de sesión, tickets SSE y enlaces de recuperación.
 * Evita almacenar tokens en texto plano dentro de SQLite.
 */
export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || ''), 'utf8').digest('hex');
}

/**
 * Comparación en tiempo constante para secretos o códigos de acceso institucionales.
 */
export function safeCompareStrings(input, expected) {
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) {
    // Ejecutar comparación dummy para no filtrar longitud exacta fácilmente
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Crea una bóveda de cifrado autenticado AES-256-GCM para campos sensibles en reposo dentro de SQLite 3.
 * Si no existe DATA_ENCRYPTION_KEY en el entorno y la base está en disco, gestiona una llave maestra local con modo 0600.
 */
export function createDataVault({ secretKey, keyFilePath } = {}) {
  let rawSecret = secretKey || process.env.DATA_ENCRYPTION_KEY || '';

  if (!rawSecret && keyFilePath) {
    try {
      const dir = path.dirname(keyFilePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.existsSync(keyFilePath)) {
        rawSecret = fs.readFileSync(keyFilePath, 'utf8').trim();
      }
      if (!rawSecret) {
        rawSecret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(keyFilePath, `${rawSecret}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      try {
        fs.chmodSync(keyFilePath, 0o600);
      } catch {
        // Ignorado en sistemas de archivos que no soportan chmod POSIX
      }
    } catch {
      rawSecret = 'upfim-ephemeral-fallback-key';
    }
  }

  if (!rawSecret) {
    rawSecret = crypto.randomBytes(32).toString('hex');
  }

  const key = crypto.scryptSync(rawSecret, 'upfim-sqlite3-vault-v1', 32);

  function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
  }

  function encrypt(plainText) {
    const str = String(plainText ?? '');
    if (isEncrypted(str)) return str;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  function decrypt(storedValue) {
    const str = String(storedValue ?? '');
    if (!isEncrypted(str)) return str;
    const parts = str.slice(ENCRYPTION_PREFIX.length).split(':');
    if (parts.length !== 3) {
      throw new Error('Formato de dato cifrado inválido en SQLite.');
    }
    const [ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(cipherHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  return {
    algorithm: 'AES-256-GCM',
    isEncrypted,
    encrypt,
    decrypt
  };
}

/**
 * Valida estrictamente un color hexadecimal #RRGGBB (previene inyección CSS en atributos style).
 */
export function isValidHexColor(color) {
  return typeof color === 'string' && HEX_COLOR_REGEX.test(color.trim());
}

export function normalizeHexColor(color, fallback = '#4f46e5') {
  const clean = typeof color === 'string' ? color.trim() : '';
  return isValidHexColor(clean) ? clean.toLowerCase() : fallback;
}

/**
 * Valida formato y longitud segura de correo electrónico.
 */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const clean = email.trim();
  if (clean.length < 5 || clean.length > 160) return false;
  return EMAIL_REGEX.test(clean);
}

/**
 * Política de contraseñas: entre 8 y 128 caracteres, al menos una letra y un dígito.
 * El tope de 128 caracteres mitiga ataques de denegación de servicio sobre scrypt.
 */
export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Contraseña inválida.' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' };
  }
  if (password.length > 128) {
    return { ok: false, error: 'La contraseña no puede exceder 128 caracteres.' };
  }
  if (!/[a-zA-ZÁÉÍÓÚáéíóúÑñ]/.test(password) || !/\d/.test(password)) {
    return { ok: false, error: 'La contraseña debe incluir al menos una letra y un número.' };
  }
  return { ok: true };
}

/**
 * Valida URLs de avatar previniendo vectores XSS (comillas, espacios, esquemas javascript: o SVG activos).
 */
export function validateAvatarUrl(avatarUrl) {
  const clean = String(avatarUrl ?? '').trim();
  if (!clean) return { ok: true, value: '' };

  if (/[\s"'<>\\`\u0000-\u001F]/.test(clean)) {
    return { ok: false, error: 'La URL de fotografía contiene caracteres no permitidos.' };
  }

  if (clean.startsWith('data:')) {
    if (clean.length > 65_536 || !DATA_IMAGE_REGEX.test(clean)) {
      return {
        ok: false,
        error: 'Solo se admiten imágenes en base64 (PNG, JPEG, WEBP o GIF) menores a 64 KB.'
      };
    }
    return { ok: true, value: clean };
  }

  if (clean.length > 1024) {
    return { ok: false, error: 'La URL de fotografía no puede exceder 1024 caracteres.' };
  }

  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'La URL de fotografía debe usar protocolo http:// o https://.' };
    }
    return { ok: true, value: parsed.href };
  } catch {
    return { ok: false, error: 'La URL de fotografía no tiene un formato válido.' };
  }
}

/**
 * Valida que una cadena YYYY-MM-DDTHH:MM represente una fecha y hora real del calendario gregoriano
 * (rechaza fechas imposibles como 2026-02-31T25:99).
 */
export function isValidLocalDateTime(dateTimeStr) {
  if (typeof dateTimeStr !== 'string') return false;
  const match = dateTimeStr.trim().match(LOCAL_DATETIME_REGEX);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (year < 2000 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;

  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/**
 * Valida horas en formato 24h HH:MM.
 */
export function isValidTime24h(timeStr) {
  return typeof timeStr === 'string' && TIME_24H_REGEX.test(timeStr.trim());
}

/**
 * Escapa comodines de SQLite LIKE (%, _, \) para evitar búsquedas abusivas o inesperadas.
 */
export function escapeLikePattern(term) {
  return String(term || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Elimina caracteres de control invisibles (excepto saltos de línea y tabuladores cuando se permiten).
 */
export function cleanControlChars(value, { multiline = false } = {}) {
  const str = String(value ?? '');
  return multiline
    ? str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
    : str.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * Limitador de tasa en memoria por ventana deslizante ligera (protege contra fuerza bruta y flooding).
 */
export function createRateLimiter() {
  const buckets = new Map();

  function check(bucketKey, maxRequests, windowMs, nowMs = Date.now()) {
    // Limpieza perezosa cuando el mapa crece
    if (buckets.size > 5000) {
      for (const [k, entry] of buckets.entries()) {
        if (nowMs >= entry.resetAt) buckets.delete(k);
      }
    }

    let entry = buckets.get(bucketKey);
    if (!entry || nowMs >= entry.resetAt) {
      entry = { count: 0, resetAt: nowMs + windowMs };
      buckets.set(bucketKey, entry);
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - entry.count),
      retryAfterSec: 0
    };
  }

  function reset(bucketKey) {
    buckets.delete(bucketKey);
  }

  return { check, reset };
}

/**
 * Cabeceras HTTP de defensa en profundidad para todas las respuestas del servidor.
 */
export function getSecurityHeaders() {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
}

/**
 * Extrae IP del cliente de manera segura para auditoría y rate-limiting local.
 */
export function getClientIp(req) {
  return String(req.socket?.remoteAddress || '127.0.0.1').slice(0, 64);
}
