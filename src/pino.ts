import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import type { Transport } from './types.js';

/** Adapta um `Transport` (uma linha JSON por chamada) para destino do pino. */
function transportStream(transport: Transport): DestinationStream {
  return {
    write: (chunk: string) => transport(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk),
  };
}

/**
 * Instância pino configurada para a lib: quem filtra por nível e faz sampling é o
 * wide-logger, então o pino aceita tudo e só serializa/escreve.
 *
 * - `level` sai em texto (`"info"`, `"warn"`...), que o Dynatrace mapeia para `loglevel`/`status`;
 * - sem `pid`/`hostname`; o `timestamp` vem no próprio registro;
 * - destino síncrono em stdout, para não perder linhas quando a Lambda congela.
 */
export function createPinoInstance(transport?: Transport): PinoLogger {
  const destination = transport ? transportStream(transport) : pino.destination({ dest: 1, sync: true });
  return pino(
    {
      level: 'debug',
      base: null,
      timestamp: false,
      messageKey: 'message',
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    destination,
  );
}
