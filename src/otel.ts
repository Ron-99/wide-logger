import { PinoInstrumentation, type PinoInstrumentationConfig } from '@opentelemetry/instrumentation-pino';

/**
 * Chaves em que a instrumentação grava o contexto do span ativo.
 *
 * O padrão da `@opentelemetry/instrumentation-pino` é `trace_id`/`span_id`, mas a lib já usa
 * `trace_id` para o root do X-Ray — e, no pino, os campos do registro sobrescrevem os do mixin,
 * então o trace do OpenTelemetry se perderia. `dt.trace_id`/`dt.span_id` são reconhecidos pelo
 * Dynatrace para ligar o log ao trace e não colidem com nada.
 */
export const DYNATRACE_LOG_KEYS = {
  traceId: 'dt.trace_id',
  spanId: 'dt.span_id',
  traceFlags: 'dt.trace_flags',
} as const;

/**
 * `PinoInstrumentation` já configurada para o wide-logger + Dynatrace.
 *
 * - `logKeys`: {@link DYNATRACE_LOG_KEYS};
 * - `disableLogSending: true`: as linhas já chegam ao Dynatrace pelo stdout (OneAgent/CloudWatch);
 *   enviar também via OTLP duplicaria tudo. Passe `false` se o envio for só por OTLP.
 *
 * Precisa ser registrada **antes** de o `pino` ser carregado (antes de importar o wide-logger).
 */
export function createPinoInstrumentation(config: PinoInstrumentationConfig = {}): PinoInstrumentation {
  return new PinoInstrumentation({
    disableLogSending: true,
    ...config,
    logKeys: config.logKeys ?? DYNATRACE_LOG_KEYS,
  });
}

export { PinoInstrumentation, type PinoInstrumentationConfig };
