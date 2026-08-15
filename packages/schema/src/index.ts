export * from './locator';
export * from './trace';
export * from './form';
export * from './run';
export * from './automation';

/** Wire protocol between extension → runner. */
export const INGEST_PATH = '/api/ingest';
/** WebSocket path the web app subscribes to for live run events. */
export const RUN_SOCKET_PATH = '/ws';
