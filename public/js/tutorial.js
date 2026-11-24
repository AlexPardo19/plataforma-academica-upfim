import { apiFetch } from './api.js';

const STUDENT_STEPS = [
  {
    icon: '📅',
    title: 'Agenda Semanal y Diaria',
    desc: 'Organiza tus entregas de Lunes a Domingo con etiquetas por materia, prioridad (Alta, Media, Baja) y notas detalladas. Usa los filtros o el buscador para encontrar cualquier pendiente al instante.'
  },
  {
    icon: '🔥',
    title: 'Racha de Cumplimiento y Temas',
    desc: 'Ingresa cada día para sumar +1 día consecutivo y completa tareas antes de su fecha límite para acumular puntos. Haz clic en el widget de llama en la barra superior para personalizar su diseño.'
  },
  {
    icon: '🤖',
    title: 'Asistente Académico Inteligente',
    desc: 'Abre la burbuja inferior derecha para pedir planes de organización o ayuda sobre el uso del sitio. Recuerda que está diseñado para guiarte en tu estudio, no para resolver ejercicios escolares.'
  },
  {
    icon: '💬',
    title: 'Recordatorios Internos y Chat Docente',
    desc: 'Recibirás alertas dentro del sitio cuando una entrega esté próxima a vencer (puedes posponerlas 1 hora). Si tienes dudas académicas personales, escribe por texto plano a tu docente en Mensajes.'
  }
];

const TEACHER_STEPS = [
  {
    icon: '👥',
    title: 'Supervisión por Grupo',
    desc: 'Selecciona cualquiera de tus grupos académicos para visualizar el porcentaje general de cumplimiento y consultar el expediente de tareas registradas por cada estudiante (modo exclusiva consulta).'
  },
  {
    icon: '📚',
    title: 'Mis Materias y Horario Cuatrimestral',
    desc: 'Consulta tus asignaturas asignadas, carga horaria y el cuadrante semanal de Lunes a Viernes. Haz clic en cualquier bloque horario para ver el aula y edificio asignado.'
  },
  {
    icon: '💬',
    title: 'Chat Privado con Estudiantes',
    desc: 'Desde el directorio de alumnos o el botón Mensajes de la barra superior puedes iniciar conversaciones privadas por texto plano para resolver dudas puntuales en tiempo real.'
  }
];

let currentStep = 0;
let activeSteps = STUDENT_STEPS;

const modal = document.getElementById('tutorial-modal');
const stepBadge = document.getElementById('tutorial-step-badge');
const iconEl = document.getElementById('tutorial-icon');
const titleEl = document.getElementById('tutorial-title');
const descEl = document.getElementById('tutorial-desc');
const prevBtn = document.getElementById('tutorial-prev-btn');
const nextBtn = document.getElementById('tutorial-next-btn');
const skipBtn = document.getElementById('tutorial-skip-btn');
const skipX = document.getElementById('tutorial-skip-x');

function renderStep() {
  const step = activeSteps[currentStep];
  stepBadge.textContent = `Paso ${currentStep + 1} de ${activeSteps.length}`;
  iconEl.textContent = step.icon;
  titleEl.textContent = step.title;
  descEl.textContent = step.desc;
  prevBtn.disabled = currentStep === 0;
  nextBtn.textContent = currentStep === activeSteps.length - 1 ? 'Finalizar' : 'Siguiente';
}

async function closeTutorial(markCompleted = true) {
  modal.classList.add('hidden');
  if (markCompleted) {
    try {
      await apiFetch('/api/profile/tutorial', { method: 'POST', body: { completed: true } });
    } catch {
      // No bloquear cierre en UI
    }
  }
}

export function openTutorial(role = 'student') {
  activeSteps = role === 'teacher' ? TEACHER_STEPS : STUDENT_STEPS;
  currentStep = 0;
  renderStep();
  modal.classList.remove('hidden');
}

export function initTutorialHandlers() {
  prevBtn.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep -= 1;
      renderStep();
    }
  });

  nextBtn.addEventListener('click', () => {
    if (currentStep < activeSteps.length - 1) {
      currentStep += 1;
      renderStep();
    } else {
      closeTutorial(true);
    }
  });

  skipBtn.addEventListener('click', () => closeTutorial(true));
  skipX.addEventListener('click', () => closeTutorial(true));
}
