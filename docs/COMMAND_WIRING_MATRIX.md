# Command Wiring Matrix

## Renderer to main IPC

| Renderer action | IPC channel | Main handler | Notes |
|---|---|---|---|
| Browse/import file | `dialog:pick-file` | `registerOCRIpc` | Opens native file picker |
| Import project from file path | `ocr:prepare-project` | `OCRImportService.prepareProject()` | Creates persisted project and page assets |
| Import project from clipboard buffer | `ocr:prepare-project-buffer` | `registerOCRIpc` + `OCRImportService` | Saves temporary file first |
| List history | `ocr:list-projects` | `OCRProjectService.listProjects()` | Returns persisted project summaries |
| Open project | `ocr:get-project` | `OCRProjectService.getProject()` | Restore only; no auto-run |
| Start OCR | `ocr:start-run` | `OCRRunManager.startRun()` | Explicit start only |
| Pause OCR | `ocr:pause-run` | `OCRRunManager.pauseRun()` | Safe batch boundary pause |
| Resume OCR | `ocr:resume-run` | `OCRRunManager.resumeRun()` | Continues incomplete work only |
| Stop OCR | `ocr:stop-run` | `OCRRunManager.stopRun()` | Leaves recoverable persisted state |
| Retry failed pages | `ocr:retry-failed` | `OCRRunManager.retryFailedPages()` | Creates new retry run |
| Retry page range | `ocr:retry-range` | `OCRRunManager.retryPageRange()` | Creates new retry run for range |
| Detect language | `ocr:detect-language` | `OCRProjectService.detectLanguage()` | Saves detected language on project |
| Estimate cost | `ocr:estimate-project` | `OCRProjectService.estimateProject()` | Uses local file sizes |
| List Ollama models | `ocr:list-ollama-models` | `OCRProjectService.listOllamaModels()` | No renderer-side network logic in Electron mode |
| Test provider key | `ocr:test-provider` | `OCRProjectService.testProvider()` | Smoke test against provider |
| Persist edited page text | `ocr:update-page-text` | `OCRProjectService.updatePageText()` | Debounced from renderer |
| Delete project | `ocr:delete-project` | `OCRProjectService.deleteProject()` | Blocks active-run deletion |
| Export OCR text | `ocr:export-result` | `OCRProjectService.buildExport()` + save dialog | TXT or DOCX |
| Browse/import translation file | `dialog:pick-translation-file` | `registerOCRIpc` | Opens native file picker for text/document sources |
| Import translation project from file path | `translation:import-file` | `TranslationImportService.prepareProject()` | Creates persisted translation project |
| Import translation project from OCR project | `translation:import-ocr-project` | `TranslationImportService.prepareProjectFromOCR()` | Uses persisted OCR results as source |
| List translation history | `translation:list-projects` | `TranslationProjectService.listProjects()` | Returns persisted translation project summaries |
| Open translation project | `translation:get-project` | `TranslationProjectService.getProject()` | Restore only; no auto-run |
| Update translation project settings | `translation:update-settings` | `TranslationProjectService.updateSettings()` | Persists source/target/provider/model/chunk size |
| Persist edited translated chunk | `translation:update-chunk-text` | `TranslationProjectService.updateChunkTranslation()` | Debounced from renderer |
| Start translation | `translation:start-run` | `TranslationRunManager.startRun()` | Explicit start only |
| Pause translation | `translation:pause-run` | `TranslationRunManager.pauseRun()` | Safe chunk-boundary pause |
| Resume translation | `translation:resume-run` | `TranslationRunManager.resumeRun()` | Continues incomplete work only |
| Stop translation | `translation:stop-run` | `TranslationRunManager.stopRun()` | Leaves recoverable persisted state |
| Retry failed chunks | `translation:retry-failed` | `TranslationRunManager.retryFailedChunks()` | Creates new retry run |
| Retry chunk range | `translation:retry-range` | `TranslationRunManager.retryRange()` | Creates new retry run for range |
| Estimate translation cost | `translation:estimate-cost` | `TranslationProjectService.estimateCost()` | Paid providers only |
| List translation Ollama models | `translation:list-ollama-models` | `TranslationProjectService.listOllamaModels()` | No renderer-side network logic in Electron mode |
| Test translation provider/runtime | `translation:test-provider` | `TranslationProjectService.testProvider()` | Health-check style validation |
| List OCR projects importable into Translator | `translation:list-importable-ocr-projects` | `TranslationProjectService.listImportableOcrProjects()` | Used by Translator import flow |
| Fetch translation failure diagnostics | `translation:get-failure-diagnostics` | `TranslationProjectService.fetchFailureDiagnostics()` | Per-chunk failure info |
| Delete translation project | `translation:delete-project` | `TranslationProjectService.deleteProject()` | Blocks active-run deletion |
| Export translation result | `translation:export-result` | `TranslationProjectService.buildExport()` + save dialog | TXT or JSON |
| Send translation to Editor | `translation:send-to-editor` | `TranslationProjectService.sendToEditor()` | Creates/updates persisted editor document |
| Open editor document | `editor:get-document` | `EditorDocumentService.getDocument()` | Restore only |
| Persist editor document text | `editor:update-document` | `EditorDocumentService.updateDocument()` | Debounced from renderer |
| List history projects | `history:list-projects` | `ProjectHistoryService.listProjects()` | Returns canonical OCR/translation/mixed history summaries |
| Get history item details | `history:get-project-details` | `ProjectHistoryService.getProjectDetails()` | Lazy detail payload for the selected history item |
| Search history | `history:search-projects` | `ProjectHistoryService.searchProjects()` | Search/filter entry point backed by persisted state |
| Filter/sort history | `history:filter-projects` | `ProjectHistoryService.filterProjects()` | Filter/sort entry point backed by persisted state |
| Delete history item | `history:delete-project` | `ProjectHistoryService.deleteProject()` | Safe scope depends on OCR-only / translation-only / mixed item |
| Open from History | `history:open-project` | `ProjectHistoryService.openProject()` | Records `lastOpenedAt` and returns restore target only; no auto-run |
| Get one live history summary | `history:get-active-summary` | `ProjectHistoryService.getActiveSummary()` | Used to refresh the currently selected history item |
| Subscribe to History updates | `history:subscribe-updates` | `registerOCRIpc` | Enables renderer-side `history:updated` listener |
| Unsubscribe from History updates | `history:unsubscribe-updates` | `registerOCRIpc` | Stops renderer-side `history:updated` listener |

## Main to renderer events

| Event | Payload | Purpose |
|---|---|---|
| `ocr:state-updated` | `{ projectId, runId, snapshot }` | Persisted project/run/page progress and restore state |
| `translation:state-updated` | `{ projectId, runId, snapshot }` | Persisted translation project/run/chunk progress and restore state |
| `history:updated` | `{ scope, projectId?, documentId?, changedAt }` | Signals that persisted history-visible state changed and the History screen should refresh |
