import { EventEmitter } from 'node:events';

/** Internal invalidations; subscribers publish authorized UI notifications. */
export const runtimeChanges = new EventEmitter();
