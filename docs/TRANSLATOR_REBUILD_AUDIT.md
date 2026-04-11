# Translator Rebuild Audit

## What was broken

- The Electron app had no real Translator screen or translation orchestration layer
- Translation state did not exist as a persisted project/run/chunk model
- There was no safe distinction between opening source content and explicitly starting translation
- There was no main-process translation worker ownership, retry model, or crash recovery path
- Translation could not integrate with OCR projects, History, or Editor as persisted workflow objects

## Why it was broken

- The app had only an OCR runtime rebuild; translation had not been moved into the same Electron-main ownership model
- Renderer UI state would have had to become the source of truth if translation were added as a shallow patch
- There was no import pipeline for text/document sources that created real persisted translation projects

## Architectural correction

- Added a main-process translation runtime alongside OCR
- Added persisted translation projects, runs, and chunks in `data/translation_projects.json`
- Added a translation worker bridge and child worker process
- Added deterministic import + normalization + chunking services
- Added explicit `Created/Ready/Running/Paused/Stopped/Interrupted/...` run states and per-chunk persisted states
- Added restart reconciliation so stale `Running` translation runs become `Interrupted`
- Added a dedicated Translator route in the renderer that only sends commands and renders persisted snapshots

## Authoritative state model

### Worker state
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

### Chunk state
- `Pending`
- `Queued`
- `Processing`
- `Completed`
- `Failed`
- `Skipped`
- `Cancelled`

Renderer state is not authoritative for translation execution.
