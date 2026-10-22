type AnyRecord = Record<string, any>;

function header(headers: AnyRecord | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === 'string') return value;
  }
  return undefined;
}

export function isApiGatewayV2(event: AnyRecord): boolean {
  return event.version === '2.0' && typeof event.requestContext?.http === 'object';
}

export function isApiGatewayV1(event: AnyRecord): boolean {
  return typeof event.httpMethod === 'string' && typeof event.requestContext === 'object';
}

export function enrichApiGatewayV2(event: AnyRecord): Record<string, unknown> {
  const rc = event.requestContext ?? {};
  return {
    trigger: { type: 'api_gateway_http' },
    http: {
      method: rc.http?.method,
      path: event.rawPath ?? rc.http?.path,
      route: event.routeKey,
      stage: rc.stage,
      source_ip: rc.http?.sourceIp,
      user_agent: rc.http?.userAgent ?? header(event.headers, 'user-agent'),
      api_request_id: rc.requestId,
      correlation_id: header(event.headers, 'x-correlation-id'),
    },
  };
}

export function enrichApiGatewayV1(event: AnyRecord): Record<string, unknown> {
  const rc = event.requestContext ?? {};
  return {
    trigger: { type: 'api_gateway_rest' },
    http: {
      method: event.httpMethod,
      path: event.path,
      route: event.resource,
      stage: rc.stage,
      source_ip: rc.identity?.sourceIp,
      user_agent: rc.identity?.userAgent ?? header(event.headers, 'user-agent'),
      api_request_id: rc.requestId,
      correlation_id: header(event.headers, 'x-correlation-id'),
    },
  };
}

/** Extrai o status HTTP do retorno do handler. */
export function apiGatewayResultFields(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && typeof (result as AnyRecord).statusCode === 'number') {
    return { http: { status_code: (result as AnyRecord).statusCode } };
  }
  // Payload v2 sem statusCode explícito: o API Gateway responde 200.
  return { http: { status_code: 200 } };
}
