# OCR Rebuild Audit

Date: 2026-04-09

## Current Diagnosis

The current Electron app does not have a real Electron-owned OCR orchestration layer.

What exists now:
- `electron.js` starts an Express server and opens a `BrowserWindow` pointed at `http://localhost:3444`
- `index.html` drives import, OCR, pause/resume/retry, history loading, and export through `fetch('/api/...')`
- `preload.js` only exposes wake-lock / shutdown IPC
- `server.js` mixes import, persistence, OCR execution, retry logic, polling responses, and page-image delivery in one process
- OCR execution state is persisted in `data/ocr_jobs.json`, but the Electron main process does not own or reconcile it

## What Is Broken

1. Renderer is coupled directly to execution:
- OCR commands are sent from the renderer straight to Express routes
- Route/UI code also owns progress polling behavior

2. Electron main process is not the source of truth:
- main only manages window lifecycle plus wake-lock IPC
- main does not own job queueing, run lifecycle, recovery, or worker state

3. Restore and execution are mixed:
- opening a job/project in the UI immediately re-enters polling logic if persisted status says `processing`
- there is no authoritative recovery pass on startup to reconcile stale `processing` jobs after crash/exit

4. Active execution is screen-adjacent instead of renderer-independent:
- the renderer decides when to start polling and when to rehydrate run state
- navigation is safer than before, but the actual architecture still assumes the renderer is the primary command path

5. Persistence model is too weak for deterministic recovery:
- there are jobs, but not explicit persisted project/run/page state machines
- page assets are stored inline as base64 in JSON rather than durable project storage
- there is no persisted worker process state
- there is no explicit interrupted/recoverable state on restart

6. Worker boundary is blurred:
- `server.js` directly calls OCR providers
- PaddleOCR itself shells out to Python, but there is no Node-managed OCR worker bridge with lifecycle monitoring

## Why It Is Broken

The app currently follows a browser-server pattern wrapped by Electron instead of a true Electron desktop pattern:
- renderer sends HTTP commands
- Express owns the long-running OCR lifecycle
- main process is bypassed for nearly all OCR concerns

That makes the OCR lifecycle fragile because:
- app startup does not reconcile stale in-progress runs
- renderer restore code can treat persisted `processing` state as if work is still alive
- route/UI logic still has too much responsibility for execution visibility and coordination

## Architectural Correction Being Applied

The rebuild moves OCR orchestration into the Electron main process / Node layer.

Target split:
- Renderer: explicit commands + state display only
- Main process: authoritative OCR command handling, queueing, persistence, recovery, and event publication
- Worker bridge: child-process execution for OCR page work
- Persistence: authoritative local project/run/page state written after every meaningful transition

Electron mode will no longer rely on renderer `fetch('/api/...')` as the execution source of truth.

## Authoritative State Model

The rebuild will persist and enforce explicit states at three levels.

### Worker Process State
- `Stopped`
- `Starting`
- `Idle`
- `Busy`
- `Paused`
- `Error`

### OCR Run State
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

### Page OCR State
- `Pending`
- `Prepared`
- `Queued`
- `Processing`
- `Completed`
- `Failed`
- `Skipped`
- `Cancelled`

These persisted states will become the source of truth for:
- which actions are legal
- which buttons the renderer shows
- whether a run is active, recoverable, or finished
- how app restart recovery behaves

## Immediate Refactor Targets

1. Add a main-process persistence service for projects/runs/pages
2. Add a main-process OCR run manager and queue manager
3. Add a worker bridge using child processes for OCR work
4. Reconcile stale runs on app startup
5. Replace Electron-mode renderer `fetch` execution paths with IPC commands/subscriptions
6. Keep project open/restore logic separate from OCR start/resume commands
