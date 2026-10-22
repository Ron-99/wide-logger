import type { LambdaContext } from '../types.js';

let coldStart = true;

/** Retorna `true` apenas na primeira invocação de um container on-demand. */
export function consumeColdStart(): boolean {
  const isCold = coldStart && process.env.AWS_LAMBDA_INITIALIZATION_TYPE !== 'provisioned-concurrency';
  coldStart = false;
  return isCold;
}

/** Apenas para testes. */
export function resetColdStart(): void {
  coldStart = true;
}

/** Extrai o Root do header X-Ray (`Root=1-abc;Parent=...;Sampled=1`). */
export function parseTraceId(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const root = header.split(';').find((part) => part.startsWith('Root='));
  return root ? root.slice('Root='.length) : undefined;
}

export function lambdaStartFields(context: LambdaContext | undefined, isColdStart: boolean): Record<string, unknown> {
  return {
    request_id: context?.awsRequestId,
    trace_id: parseTraceId(process.env._X_AMZN_TRACE_ID),
    region: process.env.AWS_REGION,
    lambda: {
      function_name: context?.functionName ?? process.env.AWS_LAMBDA_FUNCTION_NAME,
      function_version: context?.functionVersion ?? process.env.AWS_LAMBDA_FUNCTION_VERSION,
      memory_limit_mb: Number(context?.memoryLimitInMB ?? process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) || undefined,
      log_stream: context?.logStreamName,
      cold_start: isColdStart,
    },
  };
}

export function lambdaEndFields(context: LambdaContext | undefined): Record<string, unknown> {
  let remaining: number | undefined;
  try {
    remaining = context?.getRemainingTimeInMillis?.();
  } catch {
    remaining = undefined;
  }
  return {
    lambda: {
      remaining_time_ms: remaining,
      memory_used_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}
