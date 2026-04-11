# Decisions

## 2026-04-09 - Electron main owns OCR orchestration

Decision:
- Electron desktop mode no longer starts OCR through renderer HTTP calls

Why:
- The old browser-server pattern blurred responsibilities and allowed stale `processing` state to survive without authoritative recovery

Consequence:
- Renderer issues explicit commands only
- Main owns persistence, recovery, worker dispatch, and state transitions

## 2026-04-09 - Restore is separated from execution

Decision:
- Opening a project restores persisted state only

Why:
- Restoring and running were previously too easy to confuse, which created accidental restart behavior

Consequence:
- Resume requires an explicit command
- Reconciled stale runs become `Interrupted`, not phantom `Running`

## 2026-04-09 - Persisted project storage replaces base64-in-JSON runtime state for Electron mode

Decision:
- Page assets are stored as files under `data/projects/<projectId>/`
- Project/run/page state is stored in `data/ocr_projects.json`

Why:
- Durable project storage is easier to debug and safer to resume than a transient jobs-only model

Consequence:
- Preview panels can load file-backed assets directly
- Prepared assets can be reused across retries and resumes

## 2026-04-09 - JSON store retained as the current local database

Decision:
- The rebuild uses a persisted JSON store as the current local database layer

Why:
- It allows the orchestration/state rebuild to land cleanly without adding a second major migration at the same time

Consequence:
- The state model is explicit now
- A later SQLite migration can be added behind the same service boundaries

## 2026-04-09 - Translator follows the same main-process ownership model as OCR

Decision:
- Translation is orchestrated in Electron main and not in the renderer

Why:
- The Translator screen needed the same guarantees as OCR: explicit start only, route independence, persistence, retryability, and restart recovery

Consequence:
- Renderer issues translation commands only
- Main owns translation project/run/chunk persistence, provider dispatch, and reconciliation

## 2026-04-09 - Translation projects are persisted separately from OCR projects

Decision:
- Translation projects and runs are stored in `data/translation_projects.json`
- Editor documents are stored in `data/editor_documents.json`

Why:
- Translation has different source units, run settings, retries, and output editing needs than OCR

Consequence:
- OCR and translation can share history while keeping their state models explicit
- OCR output can be imported into Translator without turning translation into UI-only temporary state

## 2026-04-09 - Translation import is normalized and chunked before any run can start

Decision:
- TXT/PDF/DOC/DOCX/text imports are normalized and chunked into a real project before translation starts

Why:
- Translation needed deterministic, persisted chunk boundaries and reliable resume/retry behavior

Consequence:
- Opening/importing content never auto-starts translation
- Retry-failed and retry-range work at the persisted chunk level

## 2026-04-09 - History is a main-process query layer, not a renderer-composed list

Decision:
- History is built in Electron main by `ProjectHistoryService`

Why:
- The renderer-only merge of OCR and translation lists could not safely represent mixed workflows, delete scope, live persisted status, or editor readiness

Consequence:
- Renderer requests history summaries and details through dedicated History IPC
- Search/filter/sort operate on persisted state, not transient UI assumptions

## 2026-04-09 - Mixed OCR-to-translation history items preserve the linked OCR source on delete

Decision:
- A mixed history item represents a translation project linked to an OCR project
- Deleting that mixed history item deletes the translation/output side and preserves the linked OCR source project

Why:
- It is the safer default because OCR output can be reused and should not be destroyed when the user deletes one translation/output workflow record

Consequence:
- Mixed workflows do not show duplicate ghost entries
- After deleting a mixed item, the preserved OCR project can reappear in History as an OCR-only item
