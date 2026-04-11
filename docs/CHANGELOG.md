# Changelog

## 2026-04-10 (session 2)

### NLLB local translation — re-added
- Restored `nllb` as a working translation provider (was removed in session 1)
- `workers/nllb-translate.py` was intact and unchanged — re-wired to `TranslationProviderRouter`
- Added `translateWithNllb()`, `parsePythonCommand()`, `runNllbRequest()` functions to `TranslationProviderRouter.js`
- NLLB health check now verifies Python by spawning the worker with `type: health-check`
- `NLLB_LANGUAGE_CODES` map in `translationHelpers.js` used to convert language names to NLLB codes
- `SettingsService`: added `nllb` to `TRANSLATION_PROVIDER_MODELS` with 3 model sizes (600M / 1.3B / 3.3B)
- `SettingsService`: added `nllbPythonPath`, `nllbDevice`, `nllbMemoryGb` to `DEFAULT_SETTINGS.runtimes`
- `SettingsService.getRuntimeConfig()` now exposes all NLLB runtime fields
- Added NLLB settings panel (`sp-nllb`) with Python path, device selector, memory limit, and "Test Python" button
- Added NLLB sidebar nav entry with health-check badge
- Added `translationNllbSection` div in Translator sidebar shown when NLLB is selected
- Added `NLLB (Local / Free)` option to translator provider dropdown and Settings default provider dropdown
- `onTranslationProviderChange()`: removed migration guard that was converting `nllb` → `ollama`, now accepts `nllb` as valid
- `getTranslationModelValue()`: returns `translationNllbModelSelect` value when provider is `nllb`
- `runSettingsRuntimeTest()`: added `nllb` branch to build payload with Python path

### PaddleOCR restored as real OCR provider
- `providers/paddleocr.js` restored to Python subprocess implementation (persistent server via `paddleocr_worker.py`)
- Worker cached per `lang:device` key; processes OCR requests line-by-line over stdin/stdout JSON
- Created `providers/tesseract.js` (moved Tesseract.js code from paddleocr.js)
- `workers/ocr-worker.js`: added `tesseract` provider, passes `runtimeConfig` to provider
- `OCRProjectService`: added `tesseract` provider, correct free-tier labels for all local providers
- `SettingsService`: added `tesseract` to `OCR_PROVIDER_MODELS`, `paddleDevice` to `getRuntimeConfig()`
- `SettingsService.testRuntime('paddleocr')`: now actually tests Python instead of no-op
- `SettingsService.testRuntime('tesseract')`: no-op (always available)
- OCR provider dropdown: now shows PaddleOCR and Tesseract as separate options
- Settings panel `sp-paddleocr`: restored Python path field + Test button
- Added new `sp-tesseract` settings panel (info-only, no setup needed)
- Added Tesseract sidebar nav entry (always shows ✓ badge)
- `onProviderChange()`: handles `tesseract` as local provider (no API key, no model)
- `rebuildLangSelect()`: uses `PADDLE_LANGUAGES` for both `paddleocr` and `tesseract`
- All `isLocal` guards updated to include `tesseract`

### Unsupported provider nllb — migration fix (from session 1 fix, now cleaned up)
- Projects saved with `nllb` provider now correctly show NLLB in the dropdown instead of being redirected to Ollama
- `TranslationProviderRouter`: removed `nllb` → `ollama` fallback (not needed since NLLB is re-added)

## 2026-04-10

### Remove Python subprocesses — no middle man

#### OCR: PaddleOCR → Tesseract.js
- Replaced `providers/paddleocr.js` (Python subprocess via `paddleocr_worker.py`) with a pure Node.js Tesseract.js implementation
- `paddleocr_worker.py` is now a legacy file (unused); all OCR runs through `tesseract.js` directly in-process
- Added `tesseract.js ^5.1.1` to `package.json` dependencies
- Worker pool per language: one Tesseract worker is created per language and reused across pages
- Language detection (`detectScriptFromImage`) in both `server.js` and `ocrHelpers.js` now uses Tesseract.js instead of spawning Python
- Fixed script detection `ocrValue` map to use standard ISO-639-1 codes (`zh`, `ko`, `he`) instead of PaddleOCR-specific codes (`ch`, `korean`, `en` for Hebrew)
- `OCRRunManager.validateProviderAvailability()` now no-ops (Tesseract.js is always available)
- Removed Python pre-flight check from `OCRProjectService.detectLanguage()` for the `paddleocr` provider

#### Translation: NLLB removed
- Removed `workers/nllb-translate.py` Python subprocess from `TranslationProviderRouter`
- Removed NLLB from all provider dropdowns (OCR, translator, settings)
- Removed NLLB settings panel, sidebar nav entries, and model sub-panels from `index.html`
- Removed `NLLB_LANGUAGE_CODES` import from `TranslationProviderRouter`
- Removed `nllbPythonPath`, `nllbDevice`, `nllbMemoryGb` from `DEFAULT_SETTINGS.runtimes`
- Removed `nllb` from `TRANSLATION_PROVIDER_MODELS` and `TRANSLATION_MODELS`
- Default translation provider changed from `nllb` to `ollama`
- Translation continues to work via Anthropic, OpenAI, Gemini, and Ollama

#### Settings screen cleanup
- "PaddleOCR" renamed to "Tesseract OCR" throughout UI
- PaddleOCR settings panel replaced with a simple Tesseract info panel (no setup, always available)
- Removed device selector (Auto/GPU/CPU), Python path override, and memory limit fields from the local OCR settings panel
- Tesseract sidebar badge permanently shows ✓ (no health check needed)

## 2026-04-09

### History screen rebuild
- Added `ProjectHistoryService` in Electron main to build combined history summaries from persisted OCR, translation, and editor stores
- Added History IPC for:
  - `history:list-projects`
  - `history:get-project-details`
  - `history:search-projects`
  - `history:filter-projects`
  - `history:delete-project`
  - `history:open-project`
  - `history:get-active-summary`
  - `history:subscribe-updates`
  - `history:unsubscribe-updates`
- Rebuilt `#page-history` into a real working screen with:
  - history-only action bar
  - search/filter/sort controls
  - persisted list/grid of saved projects
  - detail panel with workflow state, counts, references, exports, and delete scope
- Added mixed history items that merge a translation project with its linked OCR project so OCR-to-translation workflows do not show duplicate ghost entries
- Added `lastOpenedAt` tracking for OCR projects, translation projects, and editor documents when History routes the user back into saved work
- Added editor-document cleanup when deleting translation or mixed history items
- Added `history:updated` events so background OCR/translation/editor changes can refresh History without making History the owner of job execution

### OCR orchestration rebuild
- Replaced Electron's old `server.js` bootstrap path with a main-process OCR runtime in Electron mode
- Added persisted project/run/page state storage in `data/ocr_projects.json`
- Added main-process OCR services:
  - `OCRPersistenceService`
  - `OCRImportService`
  - `OCRRunManager`
  - `OCRWorkerBridge`
  - `OCRProjectService`
- Added child-process OCR worker execution in `workers/ocr-worker.js`
- Added startup reconciliation so stale `Running`/`Pausing`/`Stopping` runs become `Interrupted`
- Added Electron IPC contract for import, start, pause, resume, stop, retry, history, export, language detect, model discovery, and page text persistence
- Rewired the renderer to use Electron IPC in desktop mode instead of HTTP routes
- Kept OCR route restore separate from OCR execution; opening a project now restores state only
- Preserved OCR screen scope: OCR controls, preview, progress, retries, and OCR export only

### Reliability fixes
- Serialized persistence mutations to prevent page completion races during parallel OCR
- Added structured orchestration logs at `data/logs/app-orchestration.log`
- Added worker stderr capture to improve failure diagnostics
- Added debounced page-text persistence from the live editor

### Packaging
- Added `main/**/*` and `workers/**/*` to Electron build inclusion

### Translator rebuild
- Added a persisted translation runtime in Electron main alongside OCR
- Added translation project storage in `data/translation_projects.json`
- Added editor document storage in `data/editor_documents.json`
- Added main-process translation services:
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
- Added child translation worker execution in `workers/translation-worker.js`
- Added local NLLB bridge support in `workers/nllb-translate.py`
- Added Translator route and Editor route to the renderer
- Added translation-specific IPC for import, OCR-project import, start, pause, resume, stop, retry, estimate, export, editor handoff, and chunk persistence
- Added restart reconciliation so stale translation runs become `Interrupted`
- Added combined project history for OCR and translation projects
