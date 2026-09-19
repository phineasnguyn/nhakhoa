const storageDeletionService = require('../services/storageDeletionService');

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 10;

let timer = null;
let running = false;

const pollIntervalMs = () => Math.max(
  1_000,
  Number.parseInt(process.env.STORAGE_DELETE_POLL_MS, 10) || DEFAULT_POLL_INTERVAL_MS
);

const batchSize = () => Math.max(
  1,
  Number.parseInt(process.env.STORAGE_DELETE_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE
);

async function processPendingStorageDeletions() {
  if (running) return;
  running = true;

  try {
    for (let index = 0; index < batchSize(); index += 1) {
      const result = await storageDeletionService.processNextPendingDeletionJob();
      if (!result) break;

      if (result.status !== 'completed') {
        console.warn(
          `Storage deletion job ${result.jobId} remains ${result.status}: ${result.error || 'retry scheduled'}`
        );
      }
    }
  } catch (error) {
    console.error('Storage deletion worker error:', error.message);
  } finally {
    running = false;
  }
}

function startStorageDeletionWorker() {
  if (timer) return timer;

  processPendingStorageDeletions();
  timer = setInterval(processPendingStorageDeletions, pollIntervalMs());
  timer.unref?.();
  console.log('Storage deletion worker started');
  return timer;
}

async function stopStorageDeletionWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = {
  processPendingStorageDeletions,
  startStorageDeletionWorker,
  stopStorageDeletionWorker,
};
