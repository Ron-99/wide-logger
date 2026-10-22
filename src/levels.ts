import type { LevelSetting, LogLevel } from './types.js';

export const LEVEL_VALUES: Record<LevelSetting, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const ALIASES: Record<string, LevelSetting> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fatal: 'error',
  critical: 'error',
  silent: 'silent',
  off: 'silent',
  none: 'silent',
};

/** Converte strings como "DEBUG", "warning", "FATAL" em um nível válido. */
export function parseLevel(input: string | undefined | null, fallback: LevelSetting): LevelSetting {
  if (!input) return fallback;
  return ALIASES[input.trim().toLowerCase()] ?? fallback;
}

export function isLevelEnabled(level: LogLevel, minLevel: LevelSetting): boolean {
  return LEVEL_VALUES[level] >= LEVEL_VALUES[minLevel];
}

export function maxLevel(a: LogLevel, b: LogLevel): LogLevel {
  return LEVEL_VALUES[a] >= LEVEL_VALUES[b] ? a : b;
}

export interface DeriveLevelInput {
  forced?: LogLevel;
  floor: LogLevel;
  hasError: boolean;
  statusCode?: number;
  durationMs: number;
  slowThresholdMs: number;
}

/**
 * No modelo wide event o nível não é escolhido pelo desenvolvedor a cada linha:
 * ele é derivado do resultado da invocação.
 */
export function deriveLevel(input: DeriveLevelInput): LogLevel {
  if (input.forced) return input.forced;

  let level: LogLevel = input.floor;
  if (input.hasError || (input.statusCode !== undefined && input.statusCode >= 500)) {
    level = maxLevel(level, 'error');
  } else if (input.statusCode !== undefined && input.statusCode >= 400) {
    level = maxLevel(level, 'warn');
  }
  if (input.durationMs > input.slowThresholdMs) {
    level = maxLevel(level, 'warn');
  }
  return level;
}
