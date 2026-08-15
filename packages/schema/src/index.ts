export * from './locator.js';
export * from './trace.js';
export * from './form.js';
export * from './run.js';
export * from './automation.js';

/** Wire protocol between extension → runner. */
export const INGEST_PATH = '/api/ingest';
/** WebSocket path the web app subscribes to for live run events. */
export const RUN_SOCKET_PATH = '/ws';
