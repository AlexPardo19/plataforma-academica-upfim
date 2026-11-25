import { DEFAULT_TIMEZONE, getLocalDateString } from './db.js';

export const ASSISTANT_WELCOME =
  '¡Hola! Soy tu Asistente Académico Inteligente. Puedo ayudarte a organizar tus tareas por prioridad, explicarte cómo usar los filtros, rachas o el portal, y planear tus bloques de estudio. (Nota: no resuelvo ejercicios ni contenidos de tus materias).';

const PRIORITY_LABEL = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja'
};

const PRIORITY_WEIGHT = {
  high: 0,
  medium: 1,
  low: 2
};

/**
 * Detecta solicitudes de resolución de ejercicios o dudas sobre contenido académico escolar (HU-41).
 */
export function isAcademicContentRequest(text) {
  const lower = text.toLowerCase().trim();

  // Expresiones matemáticas o ecuaciones explícitas (ej. 2x + 5 = 15, 3x^2 - 4 = 0)
  if (/\d+\s*[xyz]\s*[\^+\-*/=]/i.test(text) || /[xyz]\s*[+\-*/]\s*\d+\s*=\s*\d+/i.test(text)) {
    return true;
  }

  // Operaciones aritméticas directas acompañadas de verbos de cálculo
  if (/(cu[aá]nto es|resuelve|resu[eé]lveme|calcula)\s+\d+\s*[+\-*/^]/i.test(lower)) {
    return true;
  }

  const academicPatterns = [
    /(resuelv[ea]|resu[eé]lveme|hazme|contesta|responde|redacta|escr[ií]beme)\s+(el|la|los|las|un|una|este|esta|mi)\s+(tarea|ejercicio|problema|ensayo|resumen|c[oó]digo|programa|examen|cuestionario|pr[aá]ctica|ecuaci[oó]n)/i,
    /resu[eé]lveme\s+(este|esta|el|la)/i,
    /cu[aá]l\s+es\s+la\s+(derivada|integral|f[oó]rmula|capital|respuesta|soluci[oó]n|valencia)/i,
    /ay[uú]dame\s+a\s+resolver\s+(el|la|este|un|una)\s+(problema|ejercicio|ecuaci[oó]n|tarea)/i,
    /explica\s+(el\s+tema|la\s+ley|la\s+teor[ií]a|c[oó]mo\s+se\s+resuelve)/i,
    /dame\s+el\s+c[oó]digo\s+(de|para)/i
  ];

  return academicPatterns.some((rx) => rx.test(lower));
}

/**
 * Detecta dudas de navegación y funcionamiento de la plataforma (HU-40).
 */
function buildPlatformHelpReply(lower) {
  if (/filtrar|filtro|materia|asignatura|buscar|buscador/.test(lower)) {
    return [
      'Para **filtrar o buscar tareas por materia**, sigue estos pasos:',
      '• En la barra de herramientas del tablero principal, abre el menú desplegable **"Todas las materias"** y selecciona la asignatura que deseas revisar.',
      '• También puedes hacer **clic directo sobre la etiqueta de color** de cualquier materia dentro de una tarjeta de tarea para filtrar al instante.',
      '• Si buscas una actividad concreta, escribe una palabra clave en la **barra de búsqueda** (usa el botón de limpiar para restablecer la vista).'
    ].join('\n');
  }

  if (/racha|punto|llama|tema|personaliz/.test(lower)) {
    return [
      'Así funciona el sistema de **Racha y Puntos de Cumplimiento**:',
      '• **Días consecutivos:** Sumas **+1 día** al iniciar sesión en días seguidos (entrar varias veces el mismo día no duplica la racha). Si faltas un día completo, la racha se reinicia a 1.',
      '• **Puntos por puntualidad:** Al completar una tarea **antes** de su fecha y hora límite ganas **30 pts (Alta)**, **20 pts (Media)** o **10 pts (Baja)**.',
      '• **Personalización:** Haz clic en el widget de llama en la barra superior y elige **"Personalizar Racha"** para previsualizar y activar estilos según los días que lleves.'
    ].join('\n');
  }

  if (/recordatorio|alerta|notificaci|posponer|descartar/.test(lower)) {
    return [
      'Sobre los **recordatorios internos** de la plataforma:',
      '• Cuando una tarea vence en menos de **2 horas** (o al iniciar sesión con entregas del día), aparece una alerta flotante en pantalla.',
      '• Puedes pulsar **"Posponer 1 hr"** para silenciarla 60 minutos o **"Entendido"** para descartarla por el resto del día.',
      '• Todas las alertas viven dentro del sitio web (sin envíos por correo ni WhatsApp).'
    ].join('\n');
  }

  if (/docente|profesor|maestro|chat privado|mensaje privado|temporizador|pomodoro|vista diaria|historial/.test(lower)) {
    return [
      'Funciones rápidas de navegación en la plataforma:',
      '• **Vista Diaria / Semanal / Historial:** Usa los botones del encabezado del tablero para enfocarte en hoy, ver los 7 días o revisar entregas pasadas.',
      '• **Temporizador de Enfoque:** Pulsa **"Enfocar"** en cualquier tarea para iniciar un bloque Pomodoro de 25 min sin perder tiempo al cambiar de pestaña.',
      '• **Chat Privado con Docente:** Abre el icono de mensajes en la barra superior para enviar mensajes de texto plano a tus docentes.'
    ].join('\n');
  }

  return null;
}

/**
 * Construye una recomendación estructurada basada en las tareas reales del estudiante (HU-39).
 */
function buildOrganizationPlanReply(db, user, message, timeZone) {
  const lower = message.toLowerCase();
  const today = getLocalDateString(timeZone);

  const pendingTasks = db
    .prepare(
      `SELECT id, title, subject_name, due_at, priority
       FROM tasks
       WHERE user_id = ? AND completed = 0
       ORDER BY due_at ASC`
    )
    .all(user.id);

  if (pendingTasks.length === 0) {
    return [
      '¡Excelente trabajo! No tienes tareas pendientes registradas en este momento:',
      '• Aprovecha para registrar tus próximas entregas con **+ Nueva Tarea** indicando materia, fecha límite y prioridad.',
      '• Si deseas repasar una materia, agenda un bloque de estudio preventivo para mantener activa tu racha.'
    ].join('\n');
  }

  // Ordenar por fecha de vencimiento y prioridad
  const sorted = [...pendingTasks].sort((a, b) => {
    if (a.due_at !== b.due_at) return a.due_at.localeCompare(b.due_at);
    return (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1);
  });

  const topTask = sorted[0];
  const dueDate = topTask.due_at.slice(0, 10);
  const dueTime = topTask.due_at.slice(11, 16);

  // Pregunta específica sobre por cuál tarea empezar hoy
  if (/cu[aá]l\s+(tarea\s+)?(empiezo|inicio|hago\s+primero)|prioridad\s+hoy|por\s+d[oó]nde\s+empiezo/.test(lower)) {
    const second = sorted[1];
    const lines = [
      `Te recomiendo iniciar hoy con **${topTask.title}** (${topTask.subject_name}):`,
      `• **Motivo:** Tiene prioridad **${PRIORITY_LABEL[topTask.priority]}** y es la entrega más próxima (**${dueDate} a las ${dueTime}**).`,
      '• **Acción sugerida:** Activa el **Temporizador de Enfoque (25 min)** en esa tarjeta para avanzar sin distracciones.'
    ];
    if (second) {
      lines.push(
        `• **Siguiente en turno:** Después continúa con **${second.title}** (${second.subject_name}, vence el ${second.due_at.slice(0, 10)} a las ${second.due_at.slice(11, 16)}).`
      );
    }
    return lines.join('\n');
  }

  // Agrupar por fecha para proponer un plan de trabajo distribuido
  const groups = new Map();
  for (const t of sorted.slice(0, 6)) {
    const d = t.due_at.slice(0, 10);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(t);
  }

  const bullets = [
    `Analicé tus **${pendingTasks.length} tareas pendientes**. Aquí tienes un plan sugerido de organización por urgencia:`
  ];

  let step = 1;
  for (const [dateKey, items] of groups.entries()) {
    const tag = dateKey === today ? `Hoy (${dateKey})` : dateKey;
    const summary = items
      .map((i) => `"${i.title}" [${i.subject_name} · ${PRIORITY_LABEL[i.priority]} · ${i.due_at.slice(11, 16)}]`)
      .join('; ');
    bullets.push(`• **Bloque ${step} — ${tag}:** Atiende ${summary}.`);
    step += 1;
  }

  bullets.push(
    `• **Consejo clave:** Comienza por **${topTask.title}** para asegurar tus puntos de entrega a tiempo y evitar acumulación.`
  );

  return bullets.join('\n');
}

/**
 * Intenta consultar opcionalmente Gemini si existe GEMINI_API_KEY en el entorno;
 * ante cualquier ausencia de llave o fallo de red, utiliza el motor local determinista.
 */
async function tryOptionalGemini(userMessage, pendingTasks) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const taskSummary =
    pendingTasks.length === 0
      ? 'El estudiante no tiene tareas pendientes actualmente.'
      : pendingTasks
          .slice(0, 8)
          .map((t) => `- ${t.title} | Materia: ${t.subject_name} | Prioridad: ${t.priority} | Vence: ${t.due_at}`)
          .join('\n');

  const systemPrompt = [
    'Eres el Asistente Académico Inteligente de una plataforma web escolar (UPFIM).',
    'REGLA INQUEBRANTABLE: SOLO puedes ayudar con organización del tiempo, priorización de tareas y uso de la plataforma.',
    'NUNCA resuelvas ecuaciones, tareas, ensayos, código ni preguntas de contenido de materias escolares; si te lo piden, declina amablemente y sugiere agendar un bloque de estudio.',
    'Responde en español, de forma breve y estructurada con viñetas (•).',
    `Tareas pendientes actuales del estudiante:\n${taskSummary}`
  ].join('\n\n');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }]
        })
      }
    );
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Genera la respuesta del Asistente Virtual Inteligente respetando límites de alcance (HU-39..HU-41).
 */
export async function generateAssistantReply(db, user, message, timeZone = DEFAULT_TIMEZONE) {
  const clean = (message || '').trim();
  if (!clean) {
    return 'Escribe una pregunta sobre cómo organizar tus tareas o usar algún módulo de la plataforma.';
  }

  // 1. Guardrail estricto: nunca resolver contenido escolar (HU-41)
  if (isAcademicContentRequest(clean)) {
    return [
      'Mi función se limita a apoyarte con la **organización de tus actividades y el uso del sitio web**, por lo que no puedo resolver ejercicios ni responder contenidos de tus materias escolares.',
      '• **Sugerencia:** Crea una tarea en tu tablero o agenda un bloque de **25 minutos** en el Temporizador de Enfoque para repasar esa asignatura, o escribe a tu docente en el **Chat Privado** si tienes dudas puntuales.'
    ].join('\n');
  }

  // 2. Ayuda de uso de módulos de la plataforma (HU-40)
  const lower = clean.toLowerCase();
  const helpReply = buildPlatformHelpReply(lower);
  if (helpReply && !/organiz|plan|empiezo|primero|tengo \d+ tareas/.test(lower)) {
    return helpReply;
  }

  // 3. Respuesta opcional vía API si está configurada GEMINI_API_KEY
  const pendingTasks = db
    .prepare(
      'SELECT title, subject_name, due_at, priority FROM tasks WHERE user_id = ? AND completed = 0 ORDER BY due_at ASC'
    )
    .all(user.id);
  const aiReply = await tryOptionalGemini(clean, pendingTasks);
  if (aiReply) {
    return aiReply;
  }

  // 4. Planificador contextual local sobre tareas reales del estudiante (HU-39)
  return buildOrganizationPlanReply(db, user, clean, timeZone);
}
