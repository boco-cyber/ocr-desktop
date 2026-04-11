# System Workflow

## Electron OCR flow

1. Renderer imports a file with `ocr:prepare-project`
2. Electron main creates a persisted project and page assets under `data/projects/<projectId>/`
3. Import state updates are emitted on `ocr:state-updated`
4. Renderer shows preparation progress and page previews
5. OCR does not start automatically
6. User explicitly presses `Start OCR`
7. Renderer sends `ocr:start-run`
8. Main validates project readiness, worker health, language resolution, and run-state legality
9. Main persists a new OCR run in `Ready`, then launches the run loop in the background
10. Run manager marks pages `Queued`/`Processing` and dispatches them to `OCRWorkerBridge`
11. Child worker processes OCR page jobs and returns text or diagnostics
12. Main persists page/run transitions and emits `ocr:state-updated`
13. Renderer updates preview, progress, and recognized text panels from persisted snapshots
14. Pause, resume, stop, retry-failed, and retry-range all go through explicit IPC commands to main
15. Export reads persisted page text and writes TXT or DOCX through a save dialog

## Restart recovery

1. App starts
2. `createOCRRuntime()` loads the persisted store
3. `OCRRunManager.reconcileInterruptedRuns()` converts stale `Running`/`Pausing`/`Stopping` runs to `Interrupted`
4. Any `Queued`/`Processing` pages in those runs are reset to `Prepared`
5. Opening the project restores that snapshot only
6. OCR resumes only if the user explicitly presses `Resume`

## Electron translation flow

1. Renderer imports a text/document source with `translation:import-file` or imports persisted OCR output with `translation:import-ocr-project`
2. Electron main creates a persisted translation project under `data/translation-projects/<projectId>/`
3. `TextNormalizationService` decodes and normalizes imported text
4. `TextChunkingService` creates deterministic persisted chunks
5. Import state updates are emitted on `translation:state-updated`
6. Translation does not start automatically
7. User explicitly presses `Start Translation`
8. Renderer sends `translation:start-run`
9. Main validates project readiness, worker/provider availability, selected languages, and run-state legality
10. Main persists a new translation run in `Ready`, then launches the background run loop
11. Run manager marks chunks `Queued`/`Processing` and dispatches them through `TranslationWorkerBridge`
12. Child translation worker routes the chunk to NLLB, Ollama, or an optional paid provider
13. Main persists chunk/run transitions and emits `translation:state-updated`
14. Renderer updates the chunk list, source pane, and translated output pane from persisted snapshots
15. Pause, resume, stop, retry-failed, retry-range, export, and send-to-editor all go through explicit IPC commands

## Translation restart recovery

1. App starts
2. `createOCRRuntime()` loads the translation store
3. `TranslationRunManager.reconcileInterruptedRuns()` converts stale `Running`/`Pausing`/`Stopping` runs to `Interrupted`
4. Any `Queued`/`Processing` chunks in those runs are reset to `Pending`
5. Opening a translation project restores that snapshot only
6. Translation resumes only if the user explicitly presses `Resume`

## History flow

1. Renderer opens `#page-history`
2. Renderer asks Electron main for `history:list-projects`
3. `ProjectHistoryService` loads persisted OCR, translation, and editor state
4. Main builds canonical history items:
   - OCR-only project items
   - Translation-only project items
   - Mixed OCR-to-translation items by merging a translation project with its linked OCR project
5. Renderer shows the list only from those returned summaries; renderer state is not authoritative
6. Selecting a history item requests `history:get-project-details`
7. Main returns detail-only data on demand: statuses, counts, references, availability, actions, and export options
8. `history:open-project` records `lastOpenedAt` and returns a target route only
9. Renderer navigates to OCR, Translator, or Editor and restores the latest persisted snapshot
10. Opening or continuing from History never auto-starts OCR or translation

## History background updates

1. OCR, translation, and editor services continue to emit their own persisted-state updates while work runs in the background
2. `registerOCRIpc()` forwards those changes as `history:updated`
3. Renderer refreshes the history list/details when the History page is active
4. History reflects live persisted state, but History never owns or drives execution

## History delete behavior

1. Renderer asks for explicit confirmation before delete
2. Renderer sends `history:delete-project`
3. Main resolves delete scope from the canonical history item:
   - OCR-only item: delete the OCR project and its stored page assets
   - Translation-only item: delete the translation project and its linked editor document
   - Mixed item: delete the translation/output history item and keep the linked OCR source project
4. Delete removes persisted records and project folders consistently
5. If a linked run is still active, the underlying OCR/translation delete service rejects the delete until the run is stopped
