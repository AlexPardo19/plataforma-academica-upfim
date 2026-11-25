# Auditoría de Puntos de Mejora y Arquitectura de Blindado de Datos (SQLite 3)

**Proyecto:** Plataforma Web Académica UPFIM (`7TIDG2`)  
**Motor de Base de Datos:** SQLite 3 (`node:sqlite` / SQLite 3.51+ en modo `WAL`)

---

## 1. Diagnóstico de Vulnerabilidades y Puntos de Mejora Identificados

Durante la auditoría integral del código fuente (`server/` y `public/`) y del modelo relacional previo, se detectaron **12 brechas críticas y funcionales**:

| # | Categoría | Hallazgo Detectado en la Versión Previa | Impacto / Riesgo | Solución Aplicada en el Prototipo Blindado |
| :-: | :--- | :--- | :---: | :--- |
| **1** | **Credenciales en BD** | `sessions.token` y `password_resets.token` se almacenaban en **texto plano** dentro de SQLite. | **CRÍTICO** | Se almacena exclusivamente el hash `SHA-256` (`token_hash`) en [server/auth.js](../server/auth.js) y [server/db.js](../server/db.js). |
| **2** | **Privacidad en Reposo** | Los mensajes privados Docente–Alumno (`private_messages.content`) quedaban legibles en claro en el archivo `.sqlite`. | **ALTO** | Cifrado autenticado **AES-256-GCM** (`enc:v1:iv:tag:cipher`) en reposo con migración automática en [server/security.js](../server/security.js). |
| **3** | **Escalación de Rol** | Cualquier visitante podía enviar `role: "teacher"` en `/api/auth/register` y acceder al Portal Docente. | **CRÍTICO** | Verificación en tiempo constante (`timingSafeEqual`) de Código Institucional Docente (`TEACHER_ACCESS_CODE`) + alerta de auditoría. |
| **4** | **Fuga Horizontal (IDOR)** | Un docente podía consultar grupos, expedientes y chats de alumnos donde **no impartía materias**. | **ALTO** | Aislamiento estricto RBAC por carga académica real (`EXISTS subjects WHERE teacher_id = ? AND group_id = ?`) en [server/index.js](../server/index.js). |
| **5** | **XSS y CSS Injection** | `avatarUrl` se inyectaba vía `innerHTML` sin filtrar comillas y `subject_color` permitía inyectar propiedades CSS arbitrarias. | **CRÍTICO** | Validación estricta URL + renderizado DOM seguro (`createElement('img')`), validación `#RRGGBB` en API/Triggers/UI y cabecera **CSP**. |
| **6** | **Exposición de Token SSE** | `EventSource` enviaba el Bearer token maestro en la URL (`/api/events?token=...`). | **ALTO** | Emisión de **tickets efímeros de un solo uso (30 s)** (`POST /api/events/ticket`) + cookie `HttpOnly; SameSite=Strict`. |
| **7** | **Fuerza Bruta y DoS** | Sin límite de intentos de login ni tope de longitud de contraseña en `scryptSync`. | **ALTO** | Bloqueo temporal de cuenta (15 min tras 5 fallos) en SQLite, Rate Limiter por IP/ruta (`429 Retry-After`) y tope de 128 bytes. |
| **8** | **Trazabilidad Forense** | Sin registro de eventos de seguridad ni detección de manipulación directa sobre el archivo SQLite. | **MEDIO** | Tabla `audit_logs` encadenada con **SHA-256** tipo ledger y protegida con triggers `BEFORE UPDATE/DELETE` (`RAISE(ABORT)`). |
| **9** | **Atomicidad y Exploits** | Operaciones multi-tabla sin transacción y exploit de *farming* (crear tarea → completar +30 pts → borrar tarea infinitamente). | **MEDIO** | `withTransaction` (`BEGIN IMMEDIATE` + `SAVEPOINT`), reversión de puntos al borrar entregas del mismo día y tope diario. |
| **10** | **Validación Calendario** | La expresión regular previa aceptaba fechas inexistentes como `2026-02-31T99:99` y comodines `%`/`_` sin escapar en `LIKE`. | **MEDIO** | Validación gregoriana real (`isValidLocalDateTime`), escape `LIKE ... ESCAPE '\'` y límites de tamaño por columna. |
| **11** | **Colisión de Horarios** | El docente podía registrar materias duplicadas por grupo o bloques horarios traslapados el mismo día. | **MEDIO** | Índice único `idx_subjects_code_group`, validación `start_time < end_time` por trigger y detector de traslapes (`409`). |
| **12** | **Endurecimiento SQLite 3** | Faltaban `secure_delete`, `busy_timeout`, `trusted_schema=OFF`, permisos POSIX `0600` y respaldos en caliente. | **ALTO** | PRAGMAs activos al arranque, permisos `0700`/`0600` y respaldos consistentes mediante `VACUUM INTO` con rotación automática. |

---

## 2. Capas de Blindaje Implementadas en SQLite 3

1. **PRAGMAs de Producción y Seguridad (`server/db.js`):**
   - `PRAGMA journal_mode = WAL;` y `PRAGMA synchronous = NORMAL;`
   - `PRAGMA foreign_keys = ON;`
   - `PRAGMA secure_delete = ON;` (sobrescribe con `0x00` los registros eliminados en disco)
   - `PRAGMA busy_timeout = 5000;`
   - `PRAGMA trusted_schema = OFF;` y `PRAGMA temp_store = MEMORY;`
2. **Restricciones Declarativas y Triggers Inmutables:**
   - `trg_audit_logs_no_update` y `trg_audit_logs_no_delete` impiden alterar o borrar la bitácora incluso ejecutando SQL directo.
   - `trg_tasks_validate_insert/update`, `trg_schedules_validate_insert/update`, `trg_private_messages_no_self` y `trg_users_non_negative_streak` blindan la integridad desde el motor SQLite 3.
3. **Experiencia UX/UI Minimalista y Transparente:**
   - El blindaje en SQLite 3 opera de manera 100% transparente en el backend (`server/db.js`, `server/security.js`, `server/auth.js`) sin exponer tecnicismos de base de datos en la interfaz de usuario.
   - Se reemplazaron todos los menús nativos del sistema operativo (`<select>`, `<datalist>` e `<input type="color">`) por menús flotantes propios de la app web (`public/js/ui.js`) y se sustituyeron todos los emojis por iconografía vectorial minimalista monolínea (`public/js/icons.js`).
