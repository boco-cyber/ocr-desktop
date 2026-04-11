# UI Screen Map

## OCR
- Import document
- Show preparation progress
- Show OCR settings: provider, language, OCR mode, range, concurrency, prompt
- Start OCR
- Pause / Resume / Stop
- Retry failed pages
- Retry page range
- Show page progress grid
- Show page preview panel
- Show recognized text panel
- Save/export OCR text

Rules:
- Opening a project restores persisted OCR state only
- Entering the OCR screen never starts OCR automatically
- OCR controls remain OCR-only

## Translator
- Open a saved translation project
- Import TXT/PDF/DOC/DOCX/text files into a persisted translation project
- Import persisted OCR projects as translation source
- Show translation settings: source language, target language, provider, model, chunk size, cost estimate
- Start translation
- Pause / Resume / Stop
- Retry failed chunks
- Retry chunk range
- Show chunk list with per-chunk status
- Show source text pane
- Show translated output pane
- Send translated output to Editor
- Export translated text

Rules:
- Opening a translation project restores persisted translation state only
- Entering the Translator screen never starts translation automatically
- Translation controls remain translation-only
- Background translation is independent from the active route

## Editor
- Open translated output sent from Translator
- Edit persisted document text
- Save edits
- Export editor text

Rules:
- Editor does not start OCR or translation
- Editor is fed from persisted project output, not transient route memory

## History
- Show a history-only action bar: Refresh, Open Project, Delete Project, Continue, Open in OCR, Open in Translator, Open in Editor, Export, Search, Filter / Sort
- Search/filter/sort persisted history by workflow type, status, source type, engine/provider, output availability, and recent activity
- Show canonical history items for:
  - OCR-only projects
  - Translation-only projects
  - Mixed OCR-to-translation workflows
- Show persisted metadata at a glance: title, source file, workflow type, dates, statuses, progress summary, counts, provider summary, failures
- Show a detail panel with local references, OCR/translation status, counts, output availability, and delete scope
- Open an existing project into OCR, Translator, or Editor without auto-starting execution
- Continue incomplete work by navigating to the correct screen only
- Delete a project safely from persisted storage with an explicit confirmation step

Rules:
- Opening from History restores state only
- Continue from History restores state only and never auto-runs OCR or translation
- History reflects persisted state from Electron main, not renderer memory
- Background OCR/translation/editor changes refresh History through `history:updated`
- Mixed-item delete removes translation/output state and preserves the linked OCR source project

## Settings
- API keys
- Ollama URL and model discovery

Rules:
- Settings do not start OCR
- OCR execution does not depend on the Settings route staying open
