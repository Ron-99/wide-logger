import { REDACTED, type KeyPredicate } from './redact.js';
import type { ErrorInfo } from './types.js';

export interface SanitizeOptions {
  isSensitive: KeyPredicate;
  maxStringLength: number;
  includeStack: boolean;
  maxDepth?: number;
  maxArrayLength?: number;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ARRAY = 100;
const MAX_CAUSE_DEPTH = 3;

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function readRetriable(err: Record<string, unknown>): boolean | undefined {
  if (typeof err.retriable === 'boolean') return err.retriable;
  if (typeof err.retryable === 'boolean') return err.retryable;
  // AWS SDK v3 expõe `$retryable` quando o erro pode ser repetido.
  if (err.$retryable !== undefined) return Boolean(err.$retryable);
  return undefined;
}

/** Converte qualquer coisa lançada (Error ou não) em um objeto estruturado. */
export function serializeError(err: unknown, includeStack = true, depth = 0): ErrorInfo {
  if (!(err instanceof Error)) {
    if (err !== null && typeof err === 'object') {
      const obj = err as Record<string, unknown>;
      return {
        type: typeof obj.name === 'string' ? obj.name : 'NonError',
        message: typeof obj.message === 'string' ? obj.message : safeString(err),
      };
    }
    return { type: 'NonError', message: String(err) };
  }

  const raw = err as Error & Record<string, unknown>;
  const info: ErrorInfo = { type: err.name || err.constructor?.name || 'Error', message: err.message };

  // Propriedades próprias (ex.: statusCode, declineCode) carregam contexto valioso.
  for (const key of Object.keys(raw)) {
    if (key === 'stack' || key === 'message' || key === 'name' || key === 'cause') continue;
    if (key === '$metadata' || key === '$response') continue;
    info[key] = raw[key];
  }

  if (raw.code !== undefined && (typeof raw.code === 'string' || typeof raw.code === 'number')) {
    info.code = raw.code;
  }
  const retriable = readRetriable(raw);
  if (retriable !== undefined) info.retriable = retriable;

  const metadata = raw.$metadata as { httpStatusCode?: number; requestId?: string } | undefined;
  if (metadata) {
    if (metadata.httpStatusCode !== undefined) info.http_status_code = metadata.httpStatusCode;
    if (metadata.requestId !== undefined) info.aws_request_id = metadata.requestId;
  }

  if (includeStack && err.stack) info.stack = err.stack;
  if (raw.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    info.cause = serializeError(raw.cause, includeStack, depth + 1);
  }
  return info;
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Prepara um valor para JSON: redige chaves sensíveis, trunca strings, trata
 * referências circulares, Errors, Dates, BigInt, Map/Set e Buffers.
 */
export function sanitize(value: unknown, opts: SanitizeOptions): unknown {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArray = opts.maxArrayLength ?? DEFAULT_MAX_ARRAY;
  const ancestors: object[] = [];

  const walk = (val: unknown, depth: number): unknown => {
    switch (typeof val) {
      case 'string':
        return truncate(val, opts.maxStringLength);
      case 'number':
        return Number.isFinite(val) ? val : String(val);
      case 'boolean':
        return val;
      case 'bigint':
        return val.toString();
      case 'undefined':
      case 'function':
        return undefined;
      case 'symbol':
        return val.toString();
    }
    if (val === null) return null;

    const obj = val as object;
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (Buffer.isBuffer(obj)) return `[Buffer ${obj.length} bytes]`;
    if (ancestors.includes(obj)) return '[Circular]';
    if (depth >= maxDepth) return '[MaxDepth]';

    ancestors.push(obj);
    try {
      if (obj instanceof Error) return walk(serializeError(obj, opts.includeStack), depth + 1);
      if (obj instanceof Map) return walk(Object.fromEntries(obj), depth);
      if (obj instanceof Set) return walk([...obj], depth);

      if (Array.isArray(obj)) {
        const out = obj.slice(0, maxArray).map((item) => {
          const res = walk(item, depth + 1);
          return res === undefined ? null : res;
        });
        if (obj.length > maxArray) out.push(`…(${obj.length - maxArray} more)`);
        return out;
      }

      const source =
        typeof (obj as { toJSON?: unknown }).toJSON === 'function'
          ? (obj as { toJSON: () => unknown }).toJSON()
          : obj;
      if (source !== obj) return walk(source, depth + 1);

      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(obj)) {
        if (opts.isSensitive(key)) {
          if (child !== undefined && child !== null) out[key] = REDACTED;
          continue;
        }
        const res = walk(child, depth + 1);
        if (res !== undefined) out[key] = res;
      }
      return out;
    } finally {
      ancestors.pop();
    }
  };

  return walk(value, 0);
}
