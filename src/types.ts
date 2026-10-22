import type { WideEvent } from './wide-event.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Nível mínimo configurável. `silent` desliga toda a emissão. */
export type LevelSetting = LogLevel | 'silent';

/** Subconjunto do `Context` da AWS Lambda usado pela lib (evita dependência de @types/aws-lambda). */
export interface LambdaContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: string;
  invokedFunctionArn?: string;
  logGroupName?: string;
  logStreamName?: string;
  getRemainingTimeInMillis?: () => number;
}

export type LambdaHandler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  context: LambdaContext,
) => Promise<TResult>;

export interface ErrorInfo {
  type: string;
  message: string;
  code?: string | number;
  retriable?: boolean;
  stack?: string;
  cause?: ErrorInfo;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Milissegundos desde o início da invocação. */
  elapsed_ms: number;
  data?: unknown;
}

/** Recebe uma linha JSON já serializada. O default escreve em stdout. */
export type Transport = (line: string) => void;

/**
 * Regra customizada de tail sampling. Retorne `true` (ou uma string com o motivo)
 * para sempre manter o evento — ex.: usuários VIP, feature flags em rollout.
 */
export type KeepRule = (event: WideEvent) => boolean | string | undefined;

export interface LoggerOptions {
  /** Nome do serviço. Default: SERVICE_NAME ou AWS_LAMBDA_FUNCTION_NAME. */
  service?: string;
  /** Versão do serviço. Default: SERVICE_VERSION ou AWS_LAMBDA_FUNCTION_VERSION. */
  version?: string;
  /** Ambiente (dev, hml, prd...). Default: ENVIRONMENT, STAGE ou NODE_ENV. */
  environment?: string;
  /**
   * Nível mínimo das linhas imediatas (`logger.info()` etc.). Não descarta wide events:
   * isso é papel do sampling. `silent` desliga tudo. Default: LOG_LEVEL, AWS_LAMBDA_LOG_LEVEL ou `info`.
   */
  level?: LevelSetting;
  /** Header/atributo de onde ler o ID de correlação. Default: `x-correlation-id`. */
  correlationHeader?: string;
  /** Taxa (0..1) de eventos "felizes" mantidos. Default: LOG_SAMPLE_RATE ou 1. */
  sampleRate?: number;
  /** Acima disso a invocação é considerada lenta: vira `warn` e é sempre mantida. Default: 3000. */
  slowThresholdMs?: number;
  /** Regra extra para sempre manter o evento no tail sampling. */
  keep?: KeepRule;
  /** Inclui no `logs[]` do wide event as mensagens abaixo do nível mínimo (ex.: debug) quando a invocação termina em erro. Default: true. */
  flushDebugOnError?: boolean;
  /** Chaves extras a serem redigidas (case-insensitive, ignora `-` e `_`). */
  redactKeys?: string[];
  /** Usa a lista padrão de chaves sensíveis (senha, token, cpf, cartão...). Default: true. */
  redactDefaults?: boolean;
  /** Inclui stack trace nos erros serializados. Default: true. */
  includeStack?: boolean;
  /** Máximo de mensagens guardadas no buffer de debug-on-error por invocação. Default: 100. */
  maxLogs?: number;
  /** Strings maiores que isso são truncadas. Default: 8192. */
  maxStringLength?: number;
  /** Tamanho máximo da linha emitida (CloudWatch aceita até 256 KB). Default: 200_000. */
  maxEventBytes?: number;
  /** Enriquecimento automático a partir do evento de origem (API Gateway, SQS, SNS, EventBridge). Default: true. */
  autoEnrich?: boolean;
  /** Campos fixos adicionados em todos os eventos (ex.: { team: 'cotacao' }). */
  staticFields?: Record<string, unknown>;
  /** Destino das linhas. Default: process.stdout. */
  transport?: Transport;
  /** Fonte de aleatoriedade (útil para testes). Default: Math.random. */
  random?: () => number;
}
