# OCR Desktop — Agent Handbook

Complete developer reference for AI agents and human contributors.
**Keep this file updated** when making architectural changes.

---

## Project Overview

OCR Desktop is a **Windows desktop app** (Electron + Node.js) for local-first OCR and translation work on scanned books, PDFs, images, and imported text/document sources. It supports AI vision OCR providers (Anthropic, OpenAI, Gemini, Ollama, PaddleOCR) and translation backends (local NLLB, Ollama, and optional paid providers).

The primary desktop architecture is now:
- **Electron main process** (`electron.js`) — owns app startup, app runtime bootstrap, IPC, and wake-lock/shutdown behavior
- **Main-process services** (`main/`) — own persisted OCR/translation/editor storage, run orchestration, worker dispatch, export, recovery, and diagnostics
- **Single-page renderer UI** (`index.html`) — vanilla JS, no framework, dark theme; issues explicit commands and renders persisted state
- **Child workers** (`workers/ocr-worker.js`, `workers/translation-worker.js`) — perform assigned OCR or translation work only when the main process dispatches it

`server.js` remains in the repo only as a browser/dev fallback path. Electron desktop mode no longer depends on it for OCR execution.

---

## Folder Structure

```
ocr-desktop/
├── electron.js          # Electron app wrapper — boots the main-process OCR runtime and creates the BrowserWindow
├── preload.js           # Electron preload — exposes safe IPC bridge for OCR/project commands and power controls
├── server.js            # Legacy browser/dev server path (Electron mode does not use this for OCR orchestration)
├── index.html           # Single-page UI — upload zone, progress, result viewer, job history
├── package.json         # Dependencies + electron-builder config
├── START.bat            # Windows dev launcher (npm install if needed, opens browser)
├── AGENTS.md            # This file
├── .gitignore
│
├── main/                # Electron main-process app runtime
│   ├── createOCRRuntime.js   # Runtime bootstrap — OCR, translation, editor services, and recovery
│   ├── registerOCRIpc.js     # IPC contract registration for OCR/translation/editor actions
│   └── services/
│       ├── logger.js         # JSON-lines orchestration logger
│       ├── history/
│       │   └── ProjectHistoryService.js # Combined OCR/translation/editor history queries, open routing, and delete scope
│       ├── editor/
│       │   └── EditorDocumentService.js
│       ├── ocr/
│       │   ├── OCRPersistenceService.js # Persisted project/run/page store
│       │   ├── OCRImportService.js      # File import, page extraction, thumbnails, prepared assets
│       │   ├── OCRRunManager.js         # Start/pause/resume/stop/retry orchestration
│       │   ├── OCRWorkerBridge.js       # Child worker launch, health check, page dispatch
│       │   ├── OCRProjectService.js     # Queries, exports, language detect, page text persistence
│       │   ├── ocrHelpers.js            # OCR prompt + language/script helpers
│       │   └── stateModel.js            # Authoritative worker/run/page states
│       └── translation/
│           ├── TranslationPersistenceService.js
│           ├── TranslationImportService.js
│           ├── TextNormalizationService.js
│           ├── TextChunkingService.js
│           ├── TranslationCostEstimator.js
│           ├── TranslationRunManager.js
│           ├── TranslationWorkerBridge.js
│           ├── TranslationProviderRouter.js
│           ├── TranslationProjectService.js
│           ├── translationHelpers.js
│           └── stateModel.js
│
├── workers/
│   ├── ocr-worker.js      # Child-process OCR worker — runs one assigned page at a time
│   ├── translation-worker.js # Child-process translation worker — routes one assigned chunk at a time
│   └── nllb-translate.py  # Local NLLB Python bridge
│
├── providers/           # One file per AI provider — each exports { ocr() }
│   ├── anthropic.js     # claude-sonnet-4-6 (and other claude models with vision)
│   ├── openai.js        # gpt-4o, gpt-4o-mini (high-detail vision)
│   ├── gemini.js        # gemini-1.5-pro, gemini-1.5-flash (inline_data vision)
│   ├── paddleocr.js     # Local PaddleOCR provider — spawns Python worker
│   ├── paddleocr_worker.py # Python helper process for PaddleOCR recognition
│   └── ollama.js        # Local Ollama vision models (llava, moondream, bakllava, etc.)
│
├── converters/          # File → array of base64 PNG pages
│   ├── image.js         # JPG, PNG, TIFF (multi-frame), BMP, WebP → [{ index, imageBase64 }]
│   └── pdf.js           # PDF → pages via pdf2pic (Ghostscript) with pdfjs-dist fallback
│
├── output/              # Result formatters
│   └── docx.js          # OCR text → .docx buffer (docx npm package)
│
└── data/                # Runtime data (gitignored)
    ├── ocr_projects.json         # Persistent Electron OCR project/run/page store
    ├── translation_projects.json # Persistent translation project/run/chunk store
    ├── editor_documents.json     # Persisted editor documents
    ├── logs/                     # Orchestration logs
    ├── projects/                 # OCR per-project source/pages/thumbs/prepared assets
    └── translation-projects/     # Translation source copies + normalized text
```

---

## Running the App

### Development (browser fallback)
```bash
cd ocr-desktop
npm install
node server.js
# → open http://localhost:3444
```

### Development (Electron window)
```bash
npm run electron
```

### Windows desktop launcher
```
Double-click START.bat
```

### Build installer .exe
```bash
npm run build
# Output: dist-electron/ocr-desktop-setup-<version>.exe
```

### Build portable .exe
```bash
npm run build:portable
# Output: dist-electron/ocr-desktop-portable-<version>.exe
```

---

## Provider Interface

All providers in `providers/` export a single async function:

```js
async function ocr({ apiKey, model, imageBase64, prompt, baseUrl })
  → Promise<string>  // extracted text, empty string if no text found
```

| Param | Description |
|---|---|
| `apiKey` | API key string (empty/undefined for Ollama) |
| `model` | Model name string (falls back to provider default if falsy) |
| `imageBase64` | Raw base64-encoded PNG image (no `data:` URI prefix) |
| `prompt` | Full OCR instruction prompt (built by `buildOCRPrompt()` in server.js) |
| `baseUrl` | Ollama only: base URL, default `http://localhost:11434` |

### Adding a new provider

1. Create `providers/myprovider.js` implementing the `{ ocr() }` interface above
2. Register it in `server.js`: `const myProvider = require('./providers/myprovider')` and add to `PROVIDERS` object
3. Add its models to `MODELS` object in `index.html`
4. Add the provider option to the `<select id="providerSelect">` in `index.html`

---

## Electron State Model

Desktop mode persists OCR projects/runs in `data/ocr_projects.json`, translation projects/runs in `data/translation_projects.json`, and editor documents in `data/editor_documents.json`.

History is queried from those same stores through `main/services/history/ProjectHistoryService.js`; the renderer does not compose authoritative history state from transient UI memory.

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

## Persisted Project Shape

Projects and runs are stored separately in the local Electron store:

```js
{
  projects: {
    [projectId]: {
      id, title, sourceFileName, sourceCopyPath,
      importState, importError, detectedLanguage,
      pageIds, pages, latestRunId, runIds
    }
  },
  runs: {
    [runId]: {
      id, projectId, state, workerState,
      languageMode, resolvedLanguage, options,
      selectedPageIds, progress, pageStates
    }
  }
}
```

Page images, prepared assets, and thumbnails are stored on disk under `data/projects/<projectId>/`.

---

## API Routes

| Method | Path | Body / Params | Response |
|---|---|---|---|
| POST | `/api/upload` | multipart `file` | `{ jobId, pageCount, filename }` |
| POST | `/api/ocr` | `{ jobId, provider, model, apiKey, language, ocrMode, customPrompt, ollamaBaseUrl, concurrency, pageFrom, pageTo }` | `{ jobId, pageCount, selectedCount, concurrency }` |
| GET | `/api/status/:jobId` | — | `{ status, progress, done, failed, total, pageCount, pageFrom, pageTo, fatalError, pages }` |
| GET | `/api/result/:jobId` | — | `{ jobId, originalName, status, pageCount, pages, fullText }` |
| POST | `/api/pause/:jobId` | — | `{ ok: true, status: "paused" }` |
| POST | `/api/resume/:jobId` | `{ provider?, model?, apiKey?, language?, ocrMode?, customPrompt?, ollamaBaseUrl?, concurrency? }` | `{ ok: true, status: "processing" }` |
| POST | `/api/cancel/:jobId` | — | `{ ok: true }` |
| POST | `/api/retry/:jobId` | `{ provider?, model?, apiKey?, language?, ocrMode?, customPrompt?, ollamaBaseUrl?, concurrency?, pageFrom?, pageTo?, failedOnly? }` | `{ jobId, retrying, pageFrom, pageTo }` |
| GET | `/api/download/:jobId/txt` | — | Plain text file download |
| GET | `/api/download/:jobId/docx` | — | DOCX file download |
| GET | `/api/jobs` | — | `{ jobs: [summary] }` |
| DELETE | `/api/jobs/:jobId` | — | `{ ok: true }` |
| GET | `/api/ollama/models?baseUrl=` | — | `{ models: [{ name, size, isVision }], error? }` |

---

## OCR Prompt

The default prompt (built in `buildOCRPrompt()` in `server.js`):

```
You are a professional OCR (Optical Character Recognition) system. [The document is written in LANGUAGE.] [This is page N of TOTAL.] Extract ALL text from this image exactly as it appears. Preserve the original layout, visual hierarchy, line breaks, paragraph spacing, indentation, and structural formatting as faithfully as possible. When titles, subtitles, headers, footers, footnotes, or body text are visually distinct, preserve that distinction in the plain-text output. Output ONLY the extracted text — no commentary, no descriptions, no metadata. If the image contains no readable text, output an empty string.
```

Users can override this with a custom prompt in the sidebar.

### OCR Modes

`OCR_MODE_PROMPTS` in `server.js` / `OCR_MODES` in `index.html` define preset instructions for specialized extraction. In addition to book/photo/table/handwriting/receipt/numbers/noheaders, the app includes:

- `structure` — asks AI vision providers to label recognized blocks with `[TITLE]`, `[SUBTITLE]`, `[BODY]`, `[HEADER]`, `[FOOTER]`, and `[FOOTNOTE]` tags in reading order

**Note:** PaddleOCR ignores prompt text, so structured labeling only applies to AI vision providers (Anthropic, OpenAI, Gemini, Ollama vision models).

---

## Converters

### `converters/image.js`
- Input: file path + extension
- Uses `sharp` to read JPG, PNG, TIFF, BMP, WebP
- Multi-frame TIFFs: extracts each frame via `sharp(path, { page: n })`
- Resizes to max 2000px on longest edge (keeps base64 under ~3MB)
- Converts all formats to PNG before base64 encoding
- Output: `[{ index, imageBase64, width, height }]`

### `converters/pdf.js`
- Strategy 1: `pdf2pic` — requires Ghostscript installed on system, produces 200 DPI PNGs
- Strategy 2 (fallback): `pdfjs-dist` + `canvas` — pure Node, ~144 DPI, no system dependencies
- Automatically falls back if pdf2pic fails (e.g., Ghostscript not installed)
- Output: `[{ index, imageBase64, width, height }]`

---

## Ollama Model Detection

`GET /api/ollama/models?baseUrl=URL` proxies to Ollama's `GET /api/tags` endpoint.

Known vision model patterns (regex): `llava|moondream|bakllava|vision|minicpm|qwen.*vl|phi.*vision|cogvlm`

Models matching this pattern get `isVision: true` in the response and are sorted first in the UI dropdown with a 👁 badge.

If a non-vision model is selected and the user tries to OCR, Ollama returns an error — `providers/ollama.js` catches this and throws a clear message: *"This Ollama model does not support image input..."*

---

## UI Architecture (`index.html`)

Single HTML file, vanilla JS, no framework or bundler.

**Sections:**
- `#page-ocr` — OCR import, progress, preview, recognized text, OCR export
- `#page-translator` — translation project actions, chunk list, source/translation review, translation export, editor handoff
- `#page-editor` — persisted editor text from Translator output
- `#page-history` — persisted OCR + translation project history
- `#page-settings` — API keys and Ollama defaults
- `#sidebar-ocr` / `#sidebar-translation` / `#sidebar-generic` — route-specific sidebars; OCR and translation controls must not mix

**State:**
- `currentJobId` — active job UUID
- `pollInterval` — setInterval handle for status polling (every 1500ms)
- `resultPages` — array of `{ index, text, status }` for tab switching
- `activePageTab` — current tab index (-1 = all)
- `currentTranslationProjectId` — active translation project id
- `currentTranslationRunId` — active translation run id
- `currentTranslationSnapshot` — latest persisted translation snapshot
- `currentEditorDocumentId` — active editor document id
- `historyState` — active history filters, list results, selected item, and loaded detail snapshot

**localStorage keys:**
- `ocrSettings` — `{ provider, apiKey, model, ollamaBaseUrl, lang }`
- `translationSettings` — `{ sourceLanguage, targetLanguage, provider, model, chunkSize, ollamaBaseUrl }`

---

## Known Limitations & Planned Features

- [ ] **Auto language detection** — detect document language from first-page OCR result and auto-fill the language hint for subsequent pages
- [ ] **Preserve text styles** — bold, italic, tables from AI output (requires structured AI response)
- [ ] **Progress persistence** — server restart during OCR orphans in-progress jobs
- [ ] **Large PDF warning** — warn user when pageCount > 30 (base64 storage in JSON gets large)
- [ ] **Ghostscript bundling** — bundle GS binary in electron extraResources for better PDF quality without user installation
- [ ] **Text-based PDF detection** — detect if PDF has embedded text (use pdfjs-dist text layer) and skip OCR for those pages, only OCR image-only pages
- [ ] **Batch upload** — multiple files in one session
- [ ] **Per-page confidence** — ask AI to rate OCR confidence; flag low-confidence pages

---

## Recent Feature Additions

### History Screen Rebuild
- Added `main/services/history/ProjectHistoryService.js` to build combined history summaries from persisted OCR, translation, and editor state
- Added History IPC for list, detail, search, filter, delete, open, active-summary, and update subscription flows
- Rebuilt `#page-history` into a real Electron productivity screen with:
  - history-only action bar
  - search/filter/sort controls
  - persisted project list
  - detail panel with workflow status, counts, local references, export actions, and delete scope
- Added mixed history items that merge a translation project with its linked OCR project for OCR-to-translation workflows
- Added `lastOpenedAt` tracking for OCR projects, translation projects, and editor documents when History reopens saved work
- Added editor-document cleanup when deleting translation history items so delete does not leave orphaned editor records
- Added `history:updated` events so the History screen can refresh while OCR, translation, or editor updates continue in the background

### Clipboard Paste (Ctrl+V)
A `paste` event listener on `document` intercepts clipboard image data. When an image item is detected, it is extracted as a `File` and passed to the existing `uploadFile(file)` function. The drop zone shows a "or paste a screenshot (Ctrl+V)" hint.

### In-Page Search (Ctrl+F)
A collapsible search bar (`#searchBar`) sits above the thumbnail strip inside `resultCard`. It is hidden by default and revealed by `openSearchBar()`. The bar contains a text input (`#searchInput`), a "× Clear" button that calls `closeSearchBar()`, a result count label (`#searchCount`), and Prev/Next buttons.

- `searchInResults()` — iterates `resultPages`, counts matches per page, populates `searchMatches`, navigates to the first match via `showReviewPage()`, and highlights the match position in `#pageEditor` using `setSelectionRange`.
- `searchNext()` / `searchPrev()` — cycle through `searchMatches`, calling `_navigateToSearchMatch()` for each step.

### Keyboard Shortcuts
Added to a new `keydown` listener on `document` (the existing file had none):

| Shortcut | Action | Condition |
|---|---|---|
| `Ctrl+F` | Open search bar | resultCard visible |
| `Ctrl+S` | `downloadSelected()` | resultCard visible |
| `Ctrl+Shift+C` | `copyAll()` | resultCard visible |
| `Escape` | Close search bar | search bar open |
| `ArrowLeft` | `navigatePage(-1)` | resultCard visible, focus not in input/textarea |
| `ArrowRight` | `navigatePage(1)` | resultCard visible, focus not in input/textarea |

### Preview Zoom (Buttons + Mousewheel)
- State variable `previewZoom = 1.0` tracks current zoom level.
- "+" and "−" buttons in `.preview-pane-header` call `zoomPreview(±0.25)`.
- `zoomPreview(delta)` clamps zoom to 0.5–3.0, sets `previewImg.style.transform = scale(...)` with `transformOrigin = 'top left'`, and updates `#previewZoomLabel`.
- A `wheel` event listener on `#previewImgWrap` (added on `DOMContentLoaded`) also calls `zoomPreview` when the result card is visible.

### Page Range Selection
- A "⚙ Range" button in `#fileCard` toggles `#pageRangePanel` (a flex row with "From page" / "To page" number inputs and a Reset button).
- `startOCR()` reads `#pageRangeFrom` and `#pageRangeTo`, converts to 0-based indices, and sends `pageFrom` / `pageTo` in the JSON body to `POST /api/ocr`.
- `server.js` reads and validates `pageFrom` / `pageTo`, stores them in `job.config`, and limits progress accounting / OCR work to that selected range.
- `POST /api/retry/:jobId` also accepts `pageFrom` / `pageTo` with `failedOnly:false` so the user can retry an arbitrary page range later.

### Pause / Resume
- `POST /api/pause/:jobId` changes the job status to `paused`; the active OCR worker finishes the current chunk and then waits.
- `POST /api/resume/:jobId` switches status back to `processing` and continues the current OCR range using the latest provider settings from the UI.
- `#progressCard` exposes Pause, Resume, Stop, Retry Failed, and Retry Range controls during OCR.

### DOCX RTL Support
- `buildDocx` in `output/docx.js` now accepts a third options argument `{ rtl = false }`.
- When `rtl=true`: each body `Paragraph` gets `bidirectional: true`, and the font is `'Arial'` instead of `'Calibri'` for better Arabic/Hebrew rendering.
- `GET /api/download/:jobId/docx` in `server.js` passes `{ rtl: job.rtl || false }` to `buildDocx`.

### Keep PC Awake + Shutdown When Done (Electron only)
- **`preload.js`** — new contextBridge script exposing `window.electronAPI` with two methods:
  - `ocrStarted()` — sends `'ocr-started'` IPC to main process
  - `ocrFinished(shutdown)` — sends `'ocr-finished'` IPC with boolean shutdown flag
- **`electron.js`** — imports `powerSaveBlocker` and `ipcMain`:
  - On `'ocr-started'`: calls `powerSaveBlocker.start('prevent-app-suspension')` to keep PC awake
  - On `'ocr-finished'`: releases the blocker; if `shutdown=true` waits 30 seconds then runs `shutdown /s /t 0` (Windows) or `shutdown -h now` (Linux/Mac)
  - `BrowserWindow` now loads `preload.js` via `webPreferences.preload`
- **`index.html`**:
  - "Shutdown when done" checkbox (`#shutdownCheck`) added to the result card bottom toolbar
  - `startOCR()` calls `window.electronAPI?.ocrStarted()` after kicking off OCR
  - When polling detects `status === 'done'/'failed'/'cancelled'`, calls `window.electronAPI?.ocrFinished(shutdown)` — `shutdown` is only `true` if status is `done` and checkbox is checked
  - Shows a 30-second warning toast when shutdown is triggered
  - `window.electronAPI` is `undefined` in browser mode — all calls are safely no-ops

---

## electron-builder Config Notes

- Default target: `nsis` Windows x64 installer
- Portable target is still available via `npm run build:portable`
- `asar: true` — code bundled in asar archive
- In packaged mode: Electron loads `server.js` / `preload.js` from `app.getAppPath()` so files resolve correctly from inside `app.asar`
- `providers/paddleocr_worker.py` is unpacked with `asarUnpack` because Python cannot execute a script directly from `app.asar`
- In Electron mode, the runtime data directory is passed in via `APP_DATA_DIR` and stored under `app.getPath('userData')/data`
- `node_modules/electron` and `node_modules/electron-builder` excluded from bundle to keep size down
- Installer output: `dist-electron/ocr-desktop-setup-<version>.exe`
- Portable output: `dist-electron/ocr-desktop-portable-<version>.exe`
