import { performance } from 'node:perf_hooks';
import { isLevelEnabled, maxLevel } from './levels.js';
import { serializeError } from './serialize.js';
import type { ErrorInfo, LevelSetting, LogEntry, LogLevel } from './types.js';

export interface WideEventOptions {
  minLevel: LevelSetting;
  maxLogs: number;
  includeStack: boolean;
}

type Fields = Record<string, unknown>;

function isPlainObject(value: unknown): value is Fields {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepMerge(target: Fields, source: Fields): Fields {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      deepMerge(current, value);
    } else {
      target[key] = isPlainObject(value) ? deepMerge({}, value) : value;
    }
  }
  return target;
}

/**
 * Resumo legível do wide event para o campo `message` (ex.: `"POST /cotacoes 201 success 27ms"`).
 * Sem ele, ferramentas como o Dynatrace mostram só o JSON bruto como conteúdo da linha.
 */
export function summarizeWideEvent(fields: Fields, durationMs: number): string {
  const http = isPlainObject(fields.http) ? fields.http : undefined;
  const trigger = isPlainObject(fields.trigger) ? fields.trigger : undefined;
  const parts: unknown[] = [];

  if (http && (http.method || http.path)) {
    parts.push(http.method, http.path ?? http.route, http.status_code);
  } else if (trigger?.type && trigger.type !== 'unknown') {
    parts.push(trigger.type, trigger.queue ?? trigger.topic ?? trigger.detail_type);
  } else {
    parts.push(fields.service ?? 'invocation');
  }
  parts.push(fields.outcome, `${durationMs}ms`);
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' ');
}

interface StoredEntry extends LogEntry {
  seq: number;
}

/**
 * Um único evento por invocação, enriquecido ao longo da execução e emitido
 * uma vez no final (canonical log line).
 */
export class WideEvent {
  private readonly fields: Fields = {};
  private readonly startedAt = performance.now();
  private readonly options: WideEventOptions;

  /** Entradas abaixo do nível mínimo, guardadas para o caso de a invocação falhar. */
  private readonly buffered: StoredEntry[] = [];
  /** Quantas linhas imediatas foram emitidas, por nível. */
  private readonly emitted: Partial<Record<LogLevel, number>> = {};
  private seq = 0;

  private error?: ErrorInfo;
  private forcedLevel?: LogLevel;
  private levelFloor: LogLevel = 'info';

  constructor(options: WideEventOptions) {
    this.options = options;
  }

  /** Mescla campos no evento (merge profundo de objetos simples). */
  set(fields: Fields): this {
    deepMerge(this.fields, fields);
    return this;
  }

  /** Define um campo por caminho com pontos: `add('payment.attempt', 3)`. */
  add(path: string, value: unknown): this {
    const parts = path.split('.');
    const last = parts.pop();
    if (!last) return this;
    let node = this.fields;
    for (const part of parts) {
      if (!isPlainObject(node[part])) node[part] = {};
      node = node[part] as Fields;
    }
    node[last] = value;
    return this;
  }

  /** Lê um campo por caminho com pontos: `get('user.tier')`. */
  get<T = unknown>(path: string): T | undefined {
    let node: unknown = this.fields;
    for (const part of path.split('.')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Fields)[part];
    }
    return node as T | undefined;
  }

  /** Incrementa um contador numérico: `increment('db.queries')`. */
  increment(path: string, by = 1): this {
    const current = this.get<number>(path);
    return this.add(path, (typeof current === 'number' ? current : 0) + by);
  }

  setUser(user: Fields): this {
    return this.set({ user });
  }

  /** Registra o erro da invocação. O nível final do evento passa a ser `error`. */
  setError(err: unknown, extra?: Fields): this {
    this.error = { ...serializeError(err, this.options.includeStack), ...extra };
    return this;
  }

  getError(): ErrorInfo | undefined {
    return this.error;
  }

  /** Força o nível final do evento, ignorando a derivação automática. */
  setLevel(level: LogLevel): this {
    this.forcedLevel = level;
    return this;
  }

  /** Garante que o nível final seja pelo menos `level` (ex.: `escalate('warn')`). */
  escalate(level: LogLevel): this {
    this.levelFloor = maxLevel(this.levelFloor, level);
    return this;
  }

  getForcedLevel(): LogLevel | undefined {
    return this.forcedLevel;
  }

  getLevelFloor(): LogLevel {
    return this.levelFloor;
  }

  /**
   * Inicia um cronômetro; ao chamar a função retornada, grava `timings.<name>_ms`.
   * Útil para medir latência de dependências (banco, APIs externas).
   */
  timer(name: string): () => number {
    const start = performance.now();
    return () => {
      const ms = Math.round(performance.now() - start);
      this.add(`timings.${name}_ms`, ms);
      return ms;
    };
  }

  /** Milissegundos desde o início da invocação. */
  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  /**
   * Registra uma mensagem pontual da invocação. Retorna `true` se ela deve sair
   * como linha imediata (nível habilitado); caso contrário, ela fica no buffer
   * de debug-on-error.
   */
  recordLog(level: LogLevel, message: string, data?: unknown): boolean {
    if (level === 'warn' || level === 'error') this.escalate(level);

    if (isLevelEnabled(level, this.options.minLevel)) {
      this.emitted[level] = (this.emitted[level] ?? 0) + 1;
      return true;
    }

    const entry: StoredEntry = { seq: this.seq++, level, message, elapsed_ms: this.elapsedMs() };
    if (data !== undefined) entry.data = data;
    // Buffer circular: mantém as entradas mais recentes.
    this.buffered.push(entry);
    if (this.buffered.length > this.options.maxLogs) this.buffered.shift();
    return false;
  }

  /** Mensagens abaixo do nível mínimo, guardadas para o caso de erro. */
  getBufferedLogs(): LogEntry[] {
    return this.buffered.map(({ seq: _seq, ...entry }) => entry);
  }

  /** Contagem de linhas imediatas emitidas por nível (`undefined` se nenhuma). */
  getEmittedCounts(): Partial<Record<LogLevel, number>> | undefined {
    return Object.keys(this.emitted).length > 0 ? { ...this.emitted } : undefined;
  }

  /** Cópia rasa dos campos de negócio/contexto acumulados. */
  getFields(): Fields {
    return { ...this.fields };
  }
}
