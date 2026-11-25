import { apiFetch } from './api.js';
import { iconSvg } from './icons.js';

const STUDENT_STEPS = [
  {
    icon: 'calendar',
    title: 'Agenda semanal y diaria',
    desc: 'Organiza tus entregas de Lunes a Domingo con etiquetas por asignatura, prioridad y notas detalladas. Utiliza los selectores superiores o el buscador para filtrar al instante.'
  },
  {
    icon: 'flame',
    title: 'Racha de cumplimiento y estilos',
    desc: 'Ingresa cada día para sumar constancia y completa entregas antes de su fecha límite para obtener puntos. Pulsa el indicador de racha en la barra superior para personalizar su diseño.'
  },
  {
    icon: 'sparkles',
    title: 'Asistente académico',
    desc: 'Abre el botón inferior derecho para solicitar planes de estudio sobre tus entregas pendientes o ayuda de navegación. Está enfocado en tu organización, sin resolver tareas escolares.'
  },
  {
    icon: 'message',
    title: 'Recordatorios y mensajes directos',
    desc: 'Recibirás avisos internos cuando una actividad esté próxima a vencer (con opción de posponer 1 hora) y podrás conversar por texto plano con tus docentes.'
  }
];

const TEACHER_STEPS = [
  {
    icon: 'users',
    title: 'Supervisión por grupo',
    desc: 'Selecciona tus grupos asignados para visualizar el porcentaje general de cumplimiento y consultar el expediente de actividades registradas por cada estudiante.'
  },
  {
    icon: 'book',
    title: 'Asignaturas y horario cuatrimestral',
    desc: 'Consulta tus materias, carga horaria y el cuadrante semanal de Lunes a Viernes. Haz clic en cualquier bloque horario para ver el aula y edificio asignado.'
  },
  {
    icon: 'message',
    title: 'Mensajes privados con estudiantes',
    desc: 'Desde el listado de alumnos o el botón Mensajes de la barra superior puedes iniciar conversaciones privadas por texto plano en tiempo real.'
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
  iconEl.innerHTML = iconSvg(step.icon, { size: 24 });
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
