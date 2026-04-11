const TranslationWorkerState = Object.freeze({
  Stopped: 'Stopped',
  Starting: 'Starting',
  Idle: 'Idle',
  Busy: 'Busy',
  Paused: 'Paused',
  Error: 'Error',
});

const TranslationRunState = Object.freeze({
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

const TranslationChunkState = Object.freeze({
  Pending: 'Pending',
  Queued: 'Queued',
  Processing: 'Processing',
  Completed: 'Completed',
  Failed: 'Failed',
  Skipped: 'Skipped',
  Cancelled: 'Cancelled',
});

const ACTIVE_TRANSLATION_RUN_STATES = new Set([
  TranslationRunState.Running,
  TranslationRunState.Pausing,
  TranslationRunState.Paused,
  TranslationRunState.Stopping,
]);

module.exports = {
  TranslationWorkerState,
  TranslationRunState,
  TranslationChunkState,
  ACTIVE_TRANSLATION_RUN_STATES,
};
