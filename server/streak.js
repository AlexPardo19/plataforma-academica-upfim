import { DEFAULT_TIMEZONE, diffCalendarDays, getLocalDateString } from './db.js';

export const STREAK_THEMES = [
  {
    id: 'classic',
    name: 'Llama Clásica',
    minDays: 0,
    icon: 'flame',
    gradient: 'linear-gradient(135deg, #f97316, #ef4444)',
    accent: '#ea580c',
    badgeLabel: 'Constancia Base',
    description: 'Tema cálido clásico disponible desde el primer día.'
  },
  {
    id: 'emerald',
    name: 'Fuego Esmeralda',
    minDays: 3,
    icon: 'leaf',
    gradient: 'linear-gradient(135deg, #10b981, #059669)',
    accent: '#059669',
    badgeLabel: 'Ritmo Inicial',
    description: 'Desbloqueado al acumular 3 días consecutivos de ingreso.'
  },
  {
    id: 'violet',
    name: 'Pulso Violeta',
    minDays: 5,
    icon: 'zap',
    gradient: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
    accent: '#7c3aed',
    badgeLabel: 'Enfoque Activo',
    description: 'Estilo eléctrico desbloqueado al completar 5 días seguidos.'
  },
  {
    id: 'arctic',
    name: 'Llama Ártica',
    minDays: 7,
    icon: 'snowflake',
    gradient: 'linear-gradient(135deg, #06b6d4, #2563eb)',
    accent: '#0284c7',
    badgeLabel: 'Semana Completa',
    description: 'Tema helado de alta constancia al alcanzar 7 días consecutivos.'
  },
  {
    id: 'golden',
    name: 'Fuego Dorado',
    minDays: 15,
    icon: 'crown',
    gradient: 'linear-gradient(135deg, #f59e0b, #d97706)',
    accent: '#b45309',
    badgeLabel: 'Disciplina Elite',
    description: 'Insignia dorada reservada para estudiantes con 15 días de racha.'
  },
  {
    id: 'cosmic',
    name: 'Supernova Cósmica',
    minDays: 30,
    icon: 'sparkles',
    gradient: 'linear-gradient(135deg, #ec4899, #7c3aed)',
    accent: '#be185d',
    badgeLabel: 'Maestro Mensual',
    description: 'Diseño legendario al sostener 30 días continuos en la plataforma.'
  }
];

export const PRIORITY_POINTS = {
  high: 30,
  medium: 20,
  low: 10
};

/**
 * Evalúa y actualiza la racha diaria del estudiante de manera autónoma en la base local.
 */
export function evaluateDailyStreak(db, userId, timeZone = DEFAULT_TIMEZONE, nowDate = new Date()) {
  const user = db
    .prepare('SELECT id, role, streak_days, best_streak, streak_points, last_streak_date, streak_theme FROM users WHERE id = ?')
    .get(userId);

  if (!user || user.role !== 'student') {
    return null;
  }

  const today = getLocalDateString(timeZone, nowDate);
  const prevDays = user.streak_days ?? 0;
  const prevBest = user.best_streak ?? 0;
  const lastDate = user.last_streak_date;

  let newDays = prevDays;
  let status = 'maintained';
  let message = null;

  if (!lastDate) {
    newDays = 1;
    status = 'started';
    message = '¡Bienvenido! Iniciaste tu racha de constancia académica (Día 1).';
  } else if (lastDate === today) {
    newDays = prevDays > 0 ? prevDays : 1;
    status = 'maintained';
  } else {
    const diff = diffCalendarDays(lastDate, today);
    if (diff === 1) {
      newDays = prevDays + 1;
      status = 'incremented';
      message = `¡+1 día de racha! Llevas ${newDays} días consecutivos ingresando al sitio.`;
    } else if (diff > 1) {
      newDays = 1;
      status = 'reset';
      message = `Tu racha anterior de ${prevDays} días se reinició por faltar un día. ¡Hoy arrancas un nuevo ciclo (Día 1)!`;
    } else {
      newDays = prevDays > 0 ? prevDays : 1;
      status = 'maintained';
    }
  }

  const newBest = Math.max(prevBest, newDays);
  if (lastDate !== today || newDays !== prevDays || newBest !== prevBest) {
    db.prepare(
      'UPDATE users SET streak_days = ?, best_streak = ?, last_streak_date = ? WHERE id = ?'
    ).run(newDays, newBest, today, userId);
  }

  return {
    status,
    streakDays: newDays,
    bestStreak: newBest,
    previousDays: prevDays,
    today,
    message
  };
}

/**
 * Calcula los puntos de recompensa al completar una tarea antes de su fecha límite (HU-30).
 */
export function calculateTaskCompletionPoints(task, nowLocalDateTime) {
  if (!task || !task.due_at) return 0;
  if (nowLocalDateTime <= task.due_at) {
    return PRIORITY_POINTS[task.priority] ?? 10;
  }
  return 0;
}

/**
 * Retorna la galería de temas con indicador de desbloqueo según la racha activa del estudiante.
 */
export function getStreakThemesForUser(streakDays) {
  return STREAK_THEMES.map((theme) => {
    const unlocked = streakDays >= theme.minDays;
    return {
      ...theme,
      unlocked,
      missingDays: unlocked ? 0 : theme.minDays - streakDays
    };
  });
}

/**
 * Valida y aplica el tema visual seleccionado por el estudiante para su widget de racha.
 */
export function selectStreakTheme(db, userId, themeId) {
  const theme = STREAK_THEMES.find((t) => t.id === themeId);
  if (!theme) {
    return { ok: false, status: 400, error: 'El tema de racha seleccionado no existe.' };
  }

  const user = db.prepare('SELECT id, streak_days FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { ok: false, status: 404, error: 'Usuario no encontrado.' };
  }

  if ((user.streak_days ?? 0) < theme.minDays) {
    const missingDays = theme.minDays - (user.streak_days ?? 0);
    return {
      ok: false,
      status: 403,
      missingDays,
      error: `Te faltan ${missingDays} días de racha para desbloquear "${theme.name}" (requiere ${theme.minDays} días consecutivos).`
    };
  }

  db.prepare('UPDATE users SET streak_theme = ? WHERE id = ?').run(theme.id, userId);
  return { ok: true, theme };
}
