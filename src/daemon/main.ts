import { loadConfig } from '../config.js';
import { actVerb } from '../verbs/act.js';
import { extractVerb } from '../verbs/extract.js';
import { readVerb } from '../verbs/read.js';
import { registerVerb, startServer } from './server.js';

registerVerb('read', readVerb);
registerVerb('act', actVerb);
registerVerb('extract', extractVerb);

try {
  const server = await startServer(loadConfig());
  await server.closed;
} catch (err) {
  // Another daemon won the race to bind the socket; nothing to do.
  if (!(err instanceof Error && err.message === 'daemon already running')) {
    process.stderr.write(`scraperd failed: ${String(err)}\n`);
    process.exitCode = 1;
  }
}
process.exit();
