const WorkerProcessState = Object.freeze({
  Stopped: 'Stopped',
  Starting: 'Starting',
  Idle: 'Idle',
  Busy: 'Busy',
  Paused: 'Paused',
  Error: 'Error',
});

const OCRRunState = Object.freeze({
  Created: 'Created',
  Ready: 'Ready',
  Running: 'Running',
  Pausing: 'Pausing',
  Paused: 'Paused',
  Stopping: 'Stopping',
  Stopped: 'Stopped',
  Completed: 'Completed',
  CompletedWithFailures: 'CompletedWithFailures',
  Failed: 'Failed',
  Interrupted: 'Interrupted',
});

const PageOCRState = Object.freeze({
  Pending: 'Pending',
  Prepared: 'Prepared',
  Queued: 'Queued',
  Processing: 'Processing',
  Completed: 'Completed',
  Failed: 'Failed',
  Skipped: 'Skipped',
  Cancelled: 'Cancelled',
});

const ACTIVE_RUN_STATES = new Set([
  OCRRunState.Running,
  OCRRunState.Pausing,
  OCRRunState.Paused,
  OCRRunState.Stopping,
]);

const TERMINAL_RUN_STATES = new Set([
  OCRRunState.Stopped,
  OCRRunState.Completed,
  OCRRunState.CompletedWithFailures,
  OCRRunState.Failed,
  OCRRunState.Interrupted,
]);

module.exports = {
  WorkerProcessState,
  OCRRunState,
  PageOCRState,
  ACTIVE_RUN_STATES,
  TERMINAL_RUN_STATES,
};
