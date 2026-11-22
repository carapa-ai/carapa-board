import {
  appendTranscriptLinesSync,
  TranscriptLockBusyError,
  withTranscriptLock,
} from '../transcript-append-service.js';

const [targetPath, prefix, rawCount] = process.argv.slice(2);
if (targetPath && prefix === 'hold') {
  await withTranscriptLock(targetPath, async () => {
    console.log('locked');
    await new Promise(() => {
      setInterval(() => {}, 60_000);
    });
  });
  process.exit(0);
}
const count = Number(rawCount);
if (!targetPath || !prefix || !Number.isInteger(count)) {
  throw new Error('usage: transcript-append-worker <target> <prefix> <count>');
}

for (let index = 0; index < count; index++) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      appendTranscriptLinesSync(targetPath, [
        { id: `${prefix}-${index}`, writer: prefix, index },
      ]);
      break;
    } catch (error) {
      if (!(error instanceof TranscriptLockBusyError) || Date.now() >= deadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
