# Documentación del Proyecto — Plataforma Web Académica de Gestión de Tareas, Racha y Chat Inteligente (UPFIM)

> **Estado general:** En construcción conforme a solicitud expresa.  
> La documentación extensa del proyecto permanece **pendiente** por ahora; actualmente se entrega completo el **Análisis Causa–Efecto (Diagrama de Ishikawa)** junto con el registro técnico de desambiguación aplicado al código base.

---

## Índice de Estado Documental

| Apartado | Estado | Archivo(s) | Notas |
| :--- | :---: | :--- | :--- |
| **1. Análisis Causa–Efecto (Diagrama de Ishikawa)** | **[COMPLETADO]** | [diagrama-ishikawa.md](./diagrama-ishikawa.md), [diagrama-ishikawa.svg](./diagrama-ishikawa.svg), [diagrama-ishikawa.html](./diagrama-ishikawa.html) | Reestructura el borrador manuscrito de 20 puntos en 6 espinas maestras (6M de Ingeniería de Software) con matriz de trazabilidad y mitigaciones implementadas. |
| **2. Especificación de Requerimientos (SRS)** | **[PENDIENTE]** | — | Se elaborará a partir de las 50 Historias de Usuario (`Historias_de_Usuario_Scrum_50_v2.xlsx`) y reglas desambiguadas. |
| **3. Arquitectura y Manual Técnico** | **[PENDIENTE]** | — | Pendiente de redactar (el modelo de datos SQLite, endpoints REST y SSE ya están implementados en `server/`). |
| **4. Manual de Usuario (Estudiante y Docente)** | **[PENDIENTE]** | — | Pendiente de redactar (el tutorial interactivo emergente dentro de la app ya cubre el onboarding). |
| **5. Reporte de Sprints, PERT/CPM y Pruebas QA** | **[PENDIENTE]** | — | Pendiente de redactar (suite automatizada ya operativa con `npm test`). |
| **6. Auditoría de Mejoras y Blindado de Datos SQLite 3** | **[COMPLETADO]** | [blindado-y-mejoras.md](./blindado-y-mejoras.md) | Diagnóstico de 12 vulnerabilidades/mejoras, cifrado `AES-256-GCM`, sesiones `SHA-256`, bitácora inmutable y respaldos `VACUUM INTO`. |

---

## Resumen Ejecutivo de Ambigüedades Resueltas en la Arquitectura

Durante la revisión de los insumos previos (`Sitio de Registro de Tareas..docx`, `Historias_de_Usuario_Scrum_50_v2.xlsx`, `Reporte Analítico...pdf` y apuntes de cuaderno), se detectaron y resolvieron 7 ambigüedades críticas antes de escribir la plataforma:

1. **Vínculo Alumno – Grupo – Materias – Docente sin ERP institucional:**  
   Catálogo académico local en SQLite (`groups`, `subjects`, `schedules`) con grupos reales (`7TIDG2`, `4° B`), materias con código/color/carga horaria y cuadrante Lunes–Viernes con aula y edificio. El docente consulta grupos, materias y horarios locales (y puede capturar nuevas materias/bloques), pero tiene estrictamente bloqueado asignar tareas o calificar alumnos (`HU-46`).
2. **Desfase de zona horaria en fechas límite y corte de rachas (`#5` del Ishikawa):**  
   Todas las validaciones de "hoy", vencimientos (`HU-17`, `HU-25`) y racha diaria (`HU-29`, `HU-32`) usan la zona horaria enviada en `X-Client-Timezone` (por defecto `America/Mexico_City`) mediante `Intl.DateTimeFormat('en-CA', { timeZone })`, evitando cortes erróneos por UTC después de las 18:00 hrs.
3. **Recuperación de contraseña (`HU-04`) sin romper la restricción de cero correos externos (`HU-28`):**  
   Se generan tokens criptográficos (`crypto.randomBytes(32)`) con vigencia de 15 minutos en SQLite y una bandeja local segura de demostración para completar el flujo completo sin servidor SMTP externo.
4. **Algoritmo autónomo de racha y puntos anti-exploit (`HU-29`..`HU-37`):**  
   Completar una tarea antes de su vencimiento otorga `30 / 20 / 10` puntos según prioridad (`high / medium / low`) y `0` si ya venció; `points_awarded` queda guardado en la tarea para descontar exactamente lo otorgado si el alumno la desmarca (`HU-13`). La galería incluye 6 temas visuales (con `Fuego Dorado` desbloqueado a 15 días, como especifica `HU-35`).
5. **Motor híbrido del Asistente Virtual Inteligente (`HU-38`..`HU-42`):**  
   Funciona 100% sin llaves externas (y soporta `GEMINI_API_KEY` opcional). Incluye guardrail estricto (`HU-41`) que declina resolver ejercicios/tareas escolares (p. ej. `2x + 5 = 15`) y reorienta a planificar estudio, planificador contextual sobre las tareas reales en SQLite (`HU-39`) y guía de uso del sitio (`HU-40`).
6. **Temporizador de concentración sin deriva (`#9` del Ishikawa):**  
   Reloj Pomodoro vinculable a cualquier tarea pendiente calculado contra una marca de tiempo objetivo (`targetEndMs`) en `localStorage`, inmune a la suspensión de pestañas del navegador.
7. **Stack ligero de cero dependencias externas:**  
   Node.js ESM nativo (`node:http`, `node:sqlite`, `node:crypto`, SSE) + Frontend SPA modular en HTML/CSS/JS puro. Arranque directo con `npm start` y verificación integral con `npm test`.
