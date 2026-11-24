import { apiFetch, escapeHtml } from './api.js';
import { openChatModal } from './chat.js';

const DAY_NAMES = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
const PRIO_LABEL = { high: 'Alta', medium: 'Media', low: 'Baja' };

const groupsPanel = document.getElementById('teacher-groups-tab');
const subjectsPanel = document.getElementById('teacher-subjects-tab');
const schedulePanel = document.getElementById('teacher-schedule-tab');

let selectedGroupId = null;
let selectedStudentId = null;
let cachedGroups = [];
let cachedSubjects = [];

async function loadGroupsAndStudents() {
  const { groups } = await apiFetch('/api/teacher/groups');
  cachedGroups = groups || [];
  if (!selectedGroupId && cachedGroups.length > 0) {
    selectedGroupId = cachedGroups[0].id;
  }

  let students = [];
  if (selectedGroupId) {
    const res = await apiFetch(`/api/teacher/groups/${selectedGroupId}/students`);
    students = res.students || [];
  }

  let studentDetail = null;
  if (selectedStudentId && students.some((s) => s.id === selectedStudentId)) {
    studentDetail = await apiFetch(`/api/teacher/students/${selectedStudentId}/tasks`);
  } else if (students.length > 0) {
    selectedStudentId = students[0].id;
    studentDetail = await apiFetch(`/api/teacher/students/${selectedStudentId}/tasks`);
  }

  groupsPanel.innerHTML = `
    <div class="teacher-grid">
      <div class="card teacher-list-card">
        <h3>Grupos Asignados</h3>
        <p class="small-text muted">Selecciona un grupo para consultar el avance general y sus alumnos.</p>
        ${cachedGroups
          .map(
            (g) => `
          <button type="button" class="group-pill-card ${g.id === selectedGroupId ? 'active' : ''}" data-group-id="${g.id}">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>Grupo ${escapeHtml(g.name)}</strong>
              <span class="chip-mini">${g.completionRate}% entrega</span>
            </div>
            <div class="small-text muted">${g.studentCount} alumnos · ${g.completedTasks}/${g.totalTasks} tareas</div>
            <div class="progress-bar"><div class="progress-fill" style="width:${g.completionRate}%"></div></div>
          </button>
        `
          )
          .join('')}
      </div>

      <div class="card teacher-detail-card">
        <h3>Estudiantes del Grupo</h3>
        ${
          students.length === 0
            ? '<div class="empty-state">No hay estudiantes inscritos en este grupo.</div>'
            : `
          <div class="cards-3" style="margin-bottom: 18px;">
            ${students
              .map(
                (s) => `
              <div class="card" style="padding:12px; border-color:${s.id === selectedStudentId ? 'var(--primary)' : 'var(--border)'}">
                <strong>${escapeHtml(s.name)}</strong>
                <div class="small-text muted">${escapeHtml(s.email)}</div>
                <div class="small-text" style="margin:6px 0;">
                  🔥 Racha: <strong>${s.streakDays}d</strong> · Avance: <strong>${s.completionRate}%</strong> (${s.completedTasks}/${s.totalTasks})
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  <button type="button" class="btn secondary small" data-inspect-student="${s.id}">Ver expediente</button>
                  <button type="button" class="btn primary small" data-chat-student="${s.id}">Iniciar chat</button>
                </div>
              </div>
            `
              )
              .join('')}
          </div>
        `
        }

        ${
          studentDetail
            ? `
          <div style="border-top:1px solid var(--border); padding-top:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
              <div>
                <h4 style="margin:0;">Expediente de ${escapeHtml(studentDetail.student.name)} (Solo Lectura)</h4>
                <small class="muted">Portal de consulta exclusiva: sin asignación ni calificación de tareas.</small>
              </div>
              <button type="button" class="btn primary small" data-chat-student="${studentDetail.student.id}">Enviar mensaje privado</button>
            </div>
            ${
              studentDetail.tasks.length === 0
                ? '<div class="muted small-text">Este estudiante aún no ha registrado tareas.</div>'
                : `
              <div class="cards-3">
                ${studentDetail.tasks
                  .map(
                    (t) => `
                  <article class="task-card ${t.completed ? 'completed' : ''}" style="border-left-color:${escapeHtml(t.subject_color)}">
                    <div class="task-title">${escapeHtml(t.title)}</div>
                    <div class="task-badges">
                      <span class="subject-tag" style="background:${escapeHtml(t.subject_color)}">${escapeHtml(t.subject_name)}</span>
                      <span class="prio-tag prio-${t.priority}">${PRIO_LABEL[t.priority] || t.priority}</span>
                    </div>
                    <div class="task-meta">
                      <span>Límite: ${escapeHtml(t.due_at.replace('T', ' '))}</span>
                      <strong>${t.completed ? '✅ Completada' : '⏳ Pendiente'}</strong>
                    </div>
                    ${t.description ? `<div class="task-notes">${escapeHtml(t.description)}</div>` : ''}
                  </article>
                `
                  )
                  .join('')}
              </div>
            `
            }
          </div>
        `
            : ''
        }
      </div>
    </div>
  `;

  groupsPanel.querySelectorAll('[data-group-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedGroupId = Number(btn.dataset.groupId);
      selectedStudentId = null;
      loadGroupsAndStudents();
    });
  });

  groupsPanel.querySelectorAll('[data-inspect-student]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedStudentId = Number(btn.dataset.inspectStudent);
      loadGroupsAndStudents();
    });
  });

  groupsPanel.querySelectorAll('[data-chat-student]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openChatModal(Number(btn.dataset.chatStudent));
    });
  });
}

async function loadSubjects() {
  const [subRes, grpRes] = await Promise.all([apiFetch('/api/teacher/subjects'), apiFetch('/api/groups')]);
  cachedSubjects = subRes.subjects || [];
  const groups = grpRes.groups || [];

  subjectsPanel.innerHTML = `
    <div class="card" style="padding:18px; margin-bottom:16px;">
      <h3 style="margin-top:0;">Mis Materias Asignadas del Cuatrimestre</h3>
      <div class="cards-3">
        ${cachedSubjects
          .map(
            (s) => `
          <article class="card" style="padding:14px; border-top:4px solid ${escapeHtml(s.color)}">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="chip-mini">${escapeHtml(s.code)}</span>
              <strong>Grupo ${escapeHtml(s.groupName)}</strong>
            </div>
            <h4 style="margin:8px 0 4px;">${escapeHtml(s.name)}</h4>
            <div class="small-text muted">${s.enrolledCount} alumnos inscritos · ${s.weeklyHours} hrs/semana</div>
          </article>
        `
          )
          .join('')}
      </div>
    </div>

    <div class="card" style="padding:18px;">
      <h4 style="margin-top:0;">Capturar Materia Local (sin conexión institucional)</h4>
      <form id="teacher-add-subject-form" class="toolbar-filters">
        <input type="text" id="sub-code" placeholder="Clave (ej. TI-705)" required style="max-width:140px;" />
        <input type="text" id="sub-name" placeholder="Nombre de la asignatura" required style="flex:1;" />
        <select id="sub-group" required>
          ${groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
        </select>
        <input type="number" id="sub-hours" min="1" max="15" value="4" style="max-width:90px;" title="Horas semanales" />
        <input type="color" id="sub-color" value="#0d9488" style="max-width:56px; padding:3px;" />
        <button type="submit" class="btn primary small">Agregar materia</button>
      </form>
    </div>
  `;

  document.getElementById('teacher-add-subject-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/teacher/subjects', {
      method: 'POST',
      body: {
        code: document.getElementById('sub-code').value,
        name: document.getElementById('sub-name').value,
        groupId: Number(document.getElementById('sub-group').value),
        weeklyHours: Number(document.getElementById('sub-hours').value),
        color: document.getElementById('sub-color').value
      }
    });
    await loadSubjects();
  });
}

async function loadSchedule() {
  const [schRes, subRes] = await Promise.all([apiFetch('/api/teacher/schedule'), apiFetch('/api/teacher/subjects')]);
  const blocks = schRes.schedule || [];
  const subjects = subRes.subjects || [];

  schedulePanel.innerHTML = `
    <div class="card" style="padding:18px; margin-bottom:16px;">
      <h3 style="margin-top:0;">Mi Horario del Cuatrimestre (Lunes a Viernes)</h3>
      <p class="small-text muted">Haz clic en cualquier bloque de clase para desplegar el aula y edificio asignado.</p>
      <div class="schedule-grid">
        ${[1, 2, 3, 4, 5]
          .map((day) => {
            const dayBlocks = blocks.filter((b) => b.dayOfWeek === day);
            return `
            <div class="day-col">
              <div class="day-header"><strong>${DAY_NAMES[day]}</strong><small>${dayBlocks.length} clases</small></div>
              ${
                dayBlocks.length === 0
                  ? '<div class="small-text muted">Sin clases</div>'
                  : dayBlocks
                      .map(
                        (b) => `
                  <div class="schedule-block" style="border-left-color:${escapeHtml(b.subjectColor)}" data-toggle-block="${b.id}">
                    <div class="small-text muted">${escapeHtml(b.startTime)} – ${escapeHtml(b.endTime)}</div>
                    <strong>${escapeHtml(b.subjectName)}</strong>
                    <div class="small-text">${escapeHtml(b.subjectCode)} · Grupo ${escapeHtml(b.groupName)}</div>
                    <div class="schedule-extra hidden" id="sch-extra-${b.id}">
                      📍 <strong>${escapeHtml(b.classroom)}</strong><br/>${escapeHtml(b.building)}
                    </div>
                  </div>
                `
                      )
                      .join('')
              }
            </div>
          `;
          })
          .join('')}
      </div>
    </div>

    <div class="card" style="padding:18px;">
      <h4 style="margin-top:0;">Capturar Bloque Horario Local</h4>
      <form id="teacher-add-schedule-form" class="toolbar-filters">
        <select id="sch-subject" required>
          ${subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.groupName)})</option>`).join('')}
        </select>
        <select id="sch-day" required>
          ${[1, 2, 3, 4, 5].map((d) => `<option value="${d}">${DAY_NAMES[d]}</option>`).join('')}
        </select>
        <input type="time" id="sch-start" value="13:00" required />
        <input type="time" id="sch-end" value="15:00" required />
        <input type="text" id="sch-room" placeholder="Aula (ej. Aula 105)" required />
        <input type="text" id="sch-building" placeholder="Edificio" required />
        <button type="submit" class="btn primary small">Agregar bloque</button>
      </form>
    </div>
  `;

  schedulePanel.querySelectorAll('[data-toggle-block]').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.toggleBlock;
      document.getElementById(`sch-extra-${id}`)?.classList.toggle('hidden');
    });
  });

  document.getElementById('teacher-add-schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/teacher/schedule', {
      method: 'POST',
      body: {
        subjectId: Number(document.getElementById('sch-subject').value),
        dayOfWeek: Number(document.getElementById('sch-day').value),
        startTime: document.getElementById('sch-start').value,
        endTime: document.getElementById('sch-end').value,
        classroom: document.getElementById('sch-room').value,
        building: document.getElementById('sch-building').value
      }
    });
    await loadSchedule();
  });
}

export async function loadTeacherPortal() {
  await loadGroupsAndStudents();
}

export function initTeacherHandlers() {
  const tabBtns = document.querySelectorAll('[data-teacher-tab]');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.teacherTab;
      groupsPanel.classList.toggle('hidden', target !== 'groups');
      subjectsPanel.classList.toggle('hidden', target !== 'subjects');
      schedulePanel.classList.toggle('hidden', target !== 'schedule');

      if (target === 'groups') await loadGroupsAndStudents();
      if (target === 'subjects') await loadSubjects();
      if (target === 'schedule') await loadSchedule();
    });
  });
}
