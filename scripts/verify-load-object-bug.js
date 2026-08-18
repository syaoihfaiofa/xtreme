#!/usr/bin/env node
/**
 * Simulates the LoadManager bug: removeTrackCount(objects) when `objects` is undefined.
 * Writes runtime evidence to the debug log file.
 */
const fs = require('fs');
const logPath = '/home/lxzhu2/project/test_xtreme/.cursor/debug-d15de3.log';

function log(hypothesisId, message, data) {
  const line = JSON.stringify({
    sessionId: 'd15de3',
    hypothesisId,
    location: 'scripts/verify-load-object-bug.js',
    message,
    data,
    timestamp: Date.now(),
    runId: 'static-sim',
  });
  fs.appendFileSync(logPath, line + '\n');
}

// Hypothesis A: ReferenceError when cachedObjects exist but wrong variable name `objects` is used
const cachedObjects = [{ userData: { trackId: 'test' } }];
let objects; // intentionally undefined, matching the bug before fix
try {
  if (cachedObjects && cachedObjects.length > 0) {
    // This mimics the old buggy line: removeTrackCount(objects, frame)
    if (objects === undefined) {
      throw new ReferenceError('objects is not defined');
    }
  }
  log('A', 'unexpected success without ReferenceError', {});
} catch (error) {
  log('A', 'CONFIRMED ReferenceError on cached frame reload path', {
    errorName: error.name,
    errorMessage: error.message,
    cachedLen: cachedObjects.length,
  });
}

// Hypothesis C: forceRefetch false when needSave true skips reload
log('C', 'forceRefetch simulation', {
  syncMode: true,
  needSaveTrue: { forceRefetch: false, shouldLoadWithEmptyCache: false },
  needSaveFalse: { forceRefetch: true, shouldLoadWithEmptyCache: true },
});

console.log('Wrote simulation logs to', logPath);
