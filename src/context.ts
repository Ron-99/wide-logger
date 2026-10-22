import { AsyncLocalStorage } from 'node:async_hooks';
import type { WideEvent } from './wide-event.js';

const storage = new AsyncLocalStorage<WideEvent>();

export function runWithEvent<T>(event: WideEvent, fn: () => T): T {
  return storage.run(event, fn);
}

/**
 * Wide event da invocação atual, acessível de qualquer camada (repositórios,
 * clients HTTP...) sem precisar passá-lo por parâmetro. `undefined` fora de uma invocação.
 */
export function getCurrentEvent(): WideEvent | undefined {
  return storage.getStore();
}

/** Atalho para enriquecer o evento atual; não faz nada fora de uma invocação. */
export function enrich(fields: Record<string, unknown>): void {
  storage.getStore()?.set(fields);
}
