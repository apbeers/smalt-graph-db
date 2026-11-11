/// <reference lib="webworker" />
/** The engine's Web Worker: `new Worker(new URL('@smaltworks/smaltcy/worker', import.meta.url), { type: 'module' })`. */
import { createHandler } from './handler.js';
import type { Request } from './protocol.js';

const handler = createHandler();
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(m: unknown): void };
scope.onmessage = (e) => scope.postMessage(handler.handle(e.data));
