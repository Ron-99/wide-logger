import { createLogger } from '../src/index.js';
import type { LambdaContext, LoggerOptions } from '../src/index.js';

export function captureLogger(options: LoggerOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test-service',
    version: '1.0.0',
    environment: 'test',
    level: 'info',
    sampleRate: 1,
    transport: (line) => lines.push(line),
    ...options,
  });
  return {
    logger,
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, any>),
  };
}

export function fakeContext(overrides: Partial<LambdaContext> = {}): LambdaContext {
  return {
    awsRequestId: 'req-123',
    functionName: 'my-fn',
    functionVersion: '$LATEST',
    memoryLimitInMB: '512',
    logStreamName: '2026/10/22/[$LATEST]abc',
    getRemainingTimeInMillis: () => 2900,
    ...overrides,
  };
}

export const apiV2Event = {
  version: '2.0',
  routeKey: 'POST /cotacoes',
  rawPath: '/cotacoes',
  headers: { 'user-agent': 'curl/8.0', 'X-Correlation-Id': 'corr-1', authorization: 'Bearer secret' },
  requestContext: {
    requestId: 'apigw-1',
    stage: '$default',
    http: { method: 'POST', path: '/cotacoes', sourceIp: '10.0.0.1', userAgent: 'curl/8.0' },
  },
  body: '{}',
};

export const apiV1Event = {
  httpMethod: 'GET',
  path: '/apolices/42',
  resource: '/apolices/{id}',
  headers: { 'User-Agent': 'jest' },
  requestContext: { requestId: 'apigw-v1', stage: 'prd', identity: { sourceIp: '10.0.0.2', userAgent: 'jest' } },
};

export const sqsEvent = {
  Records: [
    {
      messageId: 'm1',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:sa-east-1:123:fila-sinistros',
      attributes: { ApproximateReceiveCount: '1' },
      body: '{}',
    },
    {
      messageId: 'm2',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:sa-east-1:123:fila-sinistros',
      attributes: { ApproximateReceiveCount: '3' },
      body: '{}',
    },
  ],
};

export const snsEvent = {
  Records: [{ EventSource: 'aws:sns', Sns: { MessageId: 'sns-1', TopicArn: 'arn:aws:sns:sa-east-1:123:topico-apolice' } }],
};

export const eventBridgeEvent = {
  id: 'eb-1',
  source: 'mapfre.apolices',
  'detail-type': 'ApoliceEmitida',
  time: '2026-10-22T10:00:00Z',
  resources: [],
  detail: { apoliceId: 'A1' },
};
