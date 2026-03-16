# OCR Desktop — Agent Handbook

Complete developer reference for AI agents and human contributors.
**Keep this file updated** when making architectural changes.

---

## Project Overview

OCR Desktop is a **portable Windows desktop app** (Electron + Node.js) that uses AI vision models to extract text from images and scanned PDFs. It supports multiple AI providers: Anthropic (Claude), OpenAI (GPT-4o), Google Gemini, and Ollama (local models).

The architecture is a **three-tier SPA**:
- **Electron shell** (`electron.js`) — wraps the web app in a native window
- **Express server** (`server.js`) — handles file upload, OCR job management, provider routing, downloads
- **Single-page UI** (`index.html`) — vanilla JS, no framework, dark theme

Port: **3444** (intentionally different from universal-translator on 3333)

---

## Folder Structure

```
ocr-desktop/
├── electron.js          # Electron app wrapper — forks server, polls until ready, creates window
├── server.js            # Express server — all routes, job engine, provider dispatch
├── index.html           # Single-page UI — upload zone, progress, result viewer, job history
├── package.json         # Dependencies + electron-builder config
├── START.bat            # Windows dev launcher (npm install if needed, opens browser)
├── AGENTS.md            # This file
├── .gitignore
│
├── providers/           # One file per AI provider — each exports { ocr() }
│   ├── anthropic.js     # claude-sonnet-4-6 (and other claude models with vision)
│   ├── openai.js        # gpt-4o, gpt-4o-mini (high-detail vision)
│   ├── gemini.js        # gemini-1.5-pro, gemini-1.5-flash (inline_data vision)
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
    ├── ocr_jobs.json    # Persistent job store — { jobs: { [uuid]: Job } }
    └── uploads/         # Multer temp upload dir — files deleted after conversion
```

---

## Running the App

### Development (browser)
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

### Build portable .exe
```bash
npm run build
# Output: dist-electron/ocr-desktop.exe
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

## Job Data Model

Jobs are stored in `data/ocr_jobs.json`:

```js
{
  id:           string,           // UUID v4
  originalName: string,           // uploaded filename
  uploadedAt:   ISO8601 string,
  status:       "uploaded" | "processing" | "done" | "failed" | "cancelled",
  pageCount:    number,
  pages: [{
    index:       number,          // 0-based
    imageBase64: string,          // base64 PNG (stored in job for retry)
    status:      "pending" | "processing" | "done" | "failed",
    error:       string | null,
  }],
  ocrResults:   string[],         // parallel to pages, null until page done
  config: {
    provider:      string,
    model:         string,
    language:      string,        // language hint for OCR prompt
    customPrompt:  string,        // optional user-defined prompt override
    ollamaBaseUrl: string,
  },
  fatalError:   string | null,    // set when job halts due to auth/billing error
}
```

**NOTE**: `imageBase64` for all pages is stored in the job JSON. For large multi-page PDFs this can make `ocr_jobs.json` very large. For documents > 30 pages, consider migrating to file-based image storage.

---

## API Routes

| Method | Path | Body / Params | Response |
|---|---|---|---|
| POST | `/api/upload` | multipart `file` | `{ jobId, pageCount, filename }` |
| POST | `/api/ocr` | `{ jobId, provider, model, apiKey, language, customPrompt, ollamaBaseUrl }` | `{ jobId, pageCount }` |
| GET | `/api/status/:jobId` | — | `{ status, progress, done, failed, total, fatalError, pages }` |
| GET | `/api/result/:jobId` | — | `{ jobId, originalName, status, pageCount, pages, fullText }` |
| POST | `/api/cancel/:jobId` | — | `{ ok: true }` |
| POST | `/api/retry/:jobId` | `{ provider?, model?, apiKey?, language?, ollamaBaseUrl? }` | `{ jobId, retrying }` |
| GET | `/api/download/:jobId/txt` | — | Plain text file download |
| GET | `/api/download/:jobId/docx` | — | DOCX file download |
| GET | `/api/jobs` | — | `{ jobs: [summary] }` |
| DELETE | `/api/jobs/:jobId` | — | `{ ok: true }` |
| GET | `/api/ollama/models?baseUrl=` | — | `{ models: [{ name, size, isVision }], error? }` |

---

## OCR Prompt

The default prompt (built in `buildOCRPrompt()` in `server.js`):

```
You are a professional OCR (Optical Character Recognition) system. [The document is written in LANGUAGE.] [This is page N of TOTAL.] Extract ALL text from this image exactly as it appears. Preserve the original layout, line breaks, paragraph spacing, indentation, and structural formatting as faithfully as possible. Output ONLY the extracted text — no commentary, no descriptions, no metadata. If the image contains no readable text, output an empty string.
```

Users can override this with a custom prompt in the sidebar.

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
- `#sidebar` — provider/model/key settings, language hint, custom prompt
- `#uploadZone` — drag-and-drop or click-to-browse, shows supported formats
- `#progressSection` — progress bar + page grid (colored boxes per page status), cancel button
- `#resultSection` — tabbed result viewer (All Pages + per-page tabs), copy/download buttons
- `#historySection` — recent job list with status badges, click to reload, delete button

**State:**
- `currentJobId` — active job UUID
- `pollInterval` — setInterval handle for status polling (every 1500ms)
- `resultPages` — array of `{ index, text, status }` for tab switching
- `activePageTab` — current tab index (-1 = all)

**localStorage keys:**
- `ocrSettings` — `{ provider, apiKey, model, ollamaBaseUrl, lang }`

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
- `server.js` reads and validates `pageFrom` / `pageTo`, stores them in `job.config`, and filters the page indices array: `indices.filter(i => i >= rangeFrom && i <= rangeTo)`.

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

- Target: `portable` Windows x64 (single .exe, no installer)
- `asar: true` — code bundled in asar archive
- In packaged mode: `app.isPackaged === true`, use `process.resourcesPath` for code files
- Data directory (`data/`) must be written to `path.dirname(process.execPath)` NOT inside asar
- `node_modules/electron` and `node_modules/electron-builder` excluded from bundle to keep size down
- Build output: `dist-electron/ocr-desktop.exe`
