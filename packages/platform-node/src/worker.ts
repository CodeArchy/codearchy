/** Default parse-worker entry for NodeWorkerPool (bundled hosts ship their own that calls runParseWorker). */
import { runParseWorker } from './pool.js';

void runParseWorker();
