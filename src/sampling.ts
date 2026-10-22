import type { KeepRule, LogLevel } from './types.js';
import type { WideEvent } from './wide-event.js';

export interface SamplingInput {
  event: WideEvent;
  level: LogLevel;
  durationMs: number;
  slowThresholdMs: number;
  sampleRate: number;
  keep?: KeepRule;
  random: () => number;
}

export interface SamplingDecision {
  keep: boolean;
  reason: string;
  rate: number;
}

/**
 * Tail sampling: a decisão é tomada depois que a invocação termina, com base no resultado.
 * Erros, warnings, invocações lentas e regras customizadas são sempre mantidos;
 * o restante é amostrado aleatoriamente por `sampleRate`.
 */
export function shouldSample(input: SamplingInput): SamplingDecision {
  const rate = input.sampleRate;
  if (input.level === 'error') return { keep: true, reason: 'error', rate };
  if (input.durationMs > input.slowThresholdMs) return { keep: true, reason: 'slow', rate };
  if (input.level === 'warn') return { keep: true, reason: 'warn', rate };

  if (input.keep) {
    try {
      const result = input.keep(input.event);
      if (result) return { keep: true, reason: typeof result === 'string' ? result : 'keep_rule', rate };
    } catch {
      // Uma regra de sampling com bug nunca deve derrubar a invocação.
    }
  }

  if (rate >= 1) return { keep: true, reason: 'all', rate };
  if (rate <= 0) return { keep: false, reason: 'dropped', rate };
  return input.random() < rate ? { keep: true, reason: 'sampled', rate } : { keep: false, reason: 'dropped', rate };
}
