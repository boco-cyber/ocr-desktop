# Master Architecture

## Desktop mode architecture

Renderer (`index.html`)
↓ IPC via `preload.js`
Electron main (`electron.js`)
↓
App runtime (`main/createOCRRuntime.js`)
↓
Services
- `OCRPersistenceService`
- `OCRImportService`
- `OCRRunManager`
- `OCRWorkerBridge`
- `OCRProjectService`
- `ProjectHistoryService`
- `TranslationPersistenceService`
- `TranslationImportService`
- `TextNormalizationService`
- `TextChunkingService`
- `TranslationCostEstimator`
- `TranslationRunManager`
- `TranslationWorkerBridge`
- `TranslationProviderRouter`
- `TranslationProjectService`
- `EditorDocumentService`
↓
Child workers (`workers/ocr-worker.js`, `workers/translation-worker.js`)
↓
Local project storage (`data/projects/*`, `data/translation-projects/*`) + persisted state (`data/ocr_projects.json`, `data/translation_projects.json`, `data/editor_documents.json`)

## Source of truth

Electron main is authoritative for:
- project creation
- OCR run lifecycle
- translation run lifecycle
- combined history summaries and history detail queries
- worker health and dispatch
- retry logic
- persisted progress
- crash/restart reconciliation

Renderer is not authoritative for execution.
Renderer is also not authoritative for history truth.

## Browser fallback

`server.js` remains in the repo for the existing browser/dev path, but Electron desktop mode no longer uses it for OCR orchestration.

## History query architecture

Renderer (`#page-history`)
↓ `history:*` IPC via `preload.js`
Electron main (`registerOCRIpc.js`)
↓
`ProjectHistoryService`
↓
`OCRPersistenceService` + `TranslationPersistenceService` + `EditorDocumentService`

History list results are summary objects only. Detail payloads are lazy-loaded per selected history item.

## State model

### Worker process state
- `Stopped`
- `Starting`
- `Idle`
- `Busy`
- `Paused`
- `Error`

### OCR run state
- `Created`
- `Ready`
- `Running`
- `Pausing`
- `Paused`
- `Stopping`
- `Stopped`
- `Completed`
- `CompletedWithFailures`
- `Failed`
- `Interrupted`

### Page OCR state
- `Pending`
- `Prepared`
- `Queued`
- `Processing`
- `Completed`
- `Failed`
- `Skipped`
- `Cancelled`

### Translation worker state
- `Stopped`
- `Starting`
- `Idle`
- `Busy`
- `Paused`
- `Error`

### Translation run state
- `Created`
- `Ready`
- `Running`
- `Pausing`
- `Paused`
- `Stopping`
- `Stopped`
- `Completed`
- `CompletedWithFailures`
- `Failed`
- `Interrupted`

### Translation chunk state
- `Pending`
- `Queued`
- `Processing`
- `Completed`
- `Failed`
- `Skipped`
- `Cancelled`
