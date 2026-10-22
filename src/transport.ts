import type { Transport } from './types.js';

/**
 * Escreve direto em stdout (sem o prefixo que o runtime da Lambda adiciona ao
 * console.log), resultando em uma linha JSON pura por evento no CloudWatch.
 */
export const stdoutTransport: Transport = (line) => {
  process.stdout.write(`${line}\n`);
};
