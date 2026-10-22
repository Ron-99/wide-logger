import { getCurrentEvent, runWithEvent } from './context.js';
import { extractCorrelationId } from './enrichers/correlation.js';
import { detectTrigger } from './enrichers/detect.js';
import { consumeColdStart, lambdaEndFields, lambdaStartFields } from './enrichers/lambda-context.js';
import { deriveLevel, isLevelEnabled, parseLevel } from './levels.js';
import { createRedactor } from './redact.js';
import { shouldSample } from './sampling.js';
import { sanitize, type SanitizeOptions } from './serialize.js';
import { stdoutTransport } from './transport.js';
import type { LambdaContext, LambdaHandler, LevelSetting, LoggerOptions, LogLevel } from './types.js';
import { WideEvent } from './wide-event.js';

export interface Logger {
  readonly level: LevelSetting;
  /**
   * Emite uma linha imediata (`log_type: "log"`) se o nível estiver habilitado.
   * Dentro de uma invocação, a linha leva `request_id`, `trace_id` e `correlation_id`;
   * mensagens abaixo do nível ficam em buffer e entram no `logs[]` do wide event se houver erro.
   */
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Wide event da invocação atual. Lança erro se chamado fora de `withWideEvent`. */
  getEvent(): WideEvent;
  /** Envolve um handler: cria, enriquece e emite um único wide event por invocação. */
  withWideEvent<TEvent, TResult>(handler: LambdaHandler<TEvent, TResult>): LambdaHandler<TEvent, TResult>;
}

function clampRate(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function readSampleRate(option: number | undefined): number {
  if (option !== undefined) return clampRate(option);
  const env = process.env.LOG_SAMPLE_RATE;
  return env === undefined || env === '' ? 1 : clampRate(Number(env));
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = process.env;
  const service = options.service ?? env.SERVICE_NAME ?? env.AWS_LAMBDA_FUNCTION_NAME ?? 'unknown';
  const version = options.version ?? env.SERVICE_VERSION ?? env.AWS_LAMBDA_FUNCTION_VERSION;
  const environment = options.environment ?? env.ENVIRONMENT ?? env.STAGE ?? env.NODE_ENV;
  const level = options.level ?? parseLevel(env.LOG_LEVEL ?? env.AWS_LAMBDA_LOG_LEVEL, 'info');
  const sampleRate = readSampleRate(options.sampleRate);
  const slowThresholdMs = options.slowThresholdMs ?? 3000;
  const flushDebugOnError = options.flushDebugOnError ?? true;
  const maxLogs = options.maxLogs ?? 100;
  const maxEventBytes = options.maxEventBytes ?? 200_000;
  const includeStack = options.includeStack ?? true;
  const autoEnrich = options.autoEnrich ?? true;
  const correlationHeader = options.correlationHeader ?? 'x-correlation-id';
  const transport = options.transport ?? stdoutTransport;
  const random = options.random ?? Math.random;

  const sanitizeOptions: SanitizeOptions = {
    isSensitive: createRedactor(options.redactKeys, options.redactDefaults ?? true),
    maxStringLength: options.maxStringLength ?? 8192,
    includeStack,
  };

  const baseFields = { service, version, environment };

  const write = (record: Record<string, unknown>): void => {
    try {
      let line = JSON.stringify(sanitize(record, sanitizeOptions));
      if (Buffer.byteLength(line) > maxEventBytes) {
        line = JSON.stringify(sanitize(shrink(record), sanitizeOptions));
      }
      transport(line);
    } catch {
      // Logging nunca deve derrubar a invocação.
    }
  };

  const shrink = (record: Record<string, unknown>): Record<string, unknown> => {
    // Primeiro descarta os logs pontuais; se ainda não couber, mantém só o núcleo.
    const withoutLogs: Record<string, unknown> = { ...record, logs: undefined, truncated: true };
    if (Buffer.byteLength(JSON.stringify(sanitize(withoutLogs, sanitizeOptions))) <= maxEventBytes) {
      return withoutLogs;
    }
    const core = [
      'timestamp', 'level', 'log_type', 'service', 'version', 'environment', 'request_id', 'trace_id', 'correlation_id',
      'region', 'duration_ms', 'outcome', 'error', 'http', 'trigger', 'sampling',
    ];
    const minimal: Record<string, unknown> = { truncated: true };
    for (const key of core) minimal[key] = record[key];
    if (minimal.error && typeof minimal.error === 'object') {
      minimal.error = { ...(minimal.error as object), stack: undefined };
    }
    return minimal;
  };

  const log = (lvl: LogLevel, message: string, data?: unknown): void => {
    const current = getCurrentEvent();
    if (current) {
      // Linha imediata ligada à invocação pelos mesmos IDs do wide event.
      if (!current.recordLog(lvl, message, data)) return;
      write({
        timestamp: new Date().toISOString(),
        level: lvl,
        log_type: 'log',
        ...baseFields,
        request_id: current.get('request_id'),
        trace_id: current.get('trace_id'),
        correlation_id: current.get('correlation_id'),
        elapsed_ms: current.elapsedMs(),
        message,
        data,
      });
      return;
    }
    if (!isLevelEnabled(lvl, level)) return;
    write({
      timestamp: new Date().toISOString(),
      level: lvl,
      log_type: 'log',
      ...baseFields,
      message,
      data,
    });
  };

  const emit = (event: WideEvent, timestamp: string, durationMs: number): void => {
    const fields = event.getFields();
    const http = fields.http as { status_code?: number } | undefined;
    const finalLevel = deriveLevel({
      forced: event.getForcedLevel(),
      floor: event.getLevelFloor(),
      hasError: event.getError() !== undefined,
      statusCode: http?.status_code,
      durationMs,
      slowThresholdMs,
    });

    // O nível mínimo só filtra linhas imediatas; quem decide gravar o wide event é o sampling.
    if (level === 'silent') return;

    const sampling = shouldSample({
      event,
      level: finalLevel,
      durationMs,
      slowThresholdMs,
      sampleRate,
      keep: options.keep,
      random,
    });
    if (!sampling.keep) return;

    const logs = flushDebugOnError && finalLevel === 'error' ? event.getBufferedLogs() : [];

    write({
      timestamp,
      level: finalLevel,
      log_type: 'wide_event',
      ...baseFields,
      ...options.staticFields,
      ...fields,
      duration_ms: durationMs,
      error: event.getError(),
      logs_emitted: event.getEmittedCounts(),
      logs: logs.length > 0 ? logs : undefined,
      sampling: { rate: sampling.rate, reason: sampling.reason },
    });
  };

  const withWideEvent = <TEvent, TResult>(
    handler: LambdaHandler<TEvent, TResult>,
  ): LambdaHandler<TEvent, TResult> => {
    return async (lambdaEvent: TEvent, context: LambdaContext): Promise<TResult> => {
      const timestamp = new Date().toISOString();
      const event = new WideEvent({ minLevel: level, maxLogs, includeStack });
      const trigger = autoEnrich ? detectTrigger(lambdaEvent) : undefined;

      try {
        event.set(lambdaStartFields(context, consumeColdStart()));
      } catch {
        // ignora
      }
      try {
        event.set({
          correlation_id: extractCorrelationId(lambdaEvent, correlationHeader) ?? context?.awsRequestId,
        });
        if (trigger) event.set(trigger.start(lambdaEvent));
      } catch {
        // Evento de origem inesperado: segue sem o enriquecimento automático.
      }

      try {
        const result = await runWithEvent(event, () => handler(lambdaEvent, context));
        event.set({ outcome: 'success' });
        try {
          if (trigger?.result) event.set(trigger.result(result));
          const failed = event.get<number>('trigger.failed_count');
          if (failed !== undefined && failed > 0) event.escalate('warn');
        } catch {
          // ignora falhas de enriquecimento do resultado
        }
        return result;
      } catch (err) {
        event.set({ outcome: 'error' });
        event.setError(err);
        throw err;
      } finally {
        const durationMs = event.elapsedMs();
        try {
          event.set(lambdaEndFields(context));
        } catch {
          // ignora
        }
        emit(event, timestamp, durationMs);
      }
    };
  };

  return {
    level,
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
    getEvent: () => {
      const current = getCurrentEvent();
      if (!current) {
        throw new Error('[wide-logger] getEvent() chamado fora de uma invocação envolvida por withWideEvent().');
      }
      return current;
    },
    withWideEvent,
  };
}
