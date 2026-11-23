/**
 * Parse-worker entry bundled as dist/parseWorker.js: each worker thread hosts
 * one analyzer (see NodeWorkerPool in @codearchy/platform-node).
 */
import { runParseWorker } from '@codearchy/platform-node';

void runParseWorker();
