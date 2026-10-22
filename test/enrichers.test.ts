import { describe, expect, it } from 'vitest';
import { detectTrigger, parseLevel } from '../src/index.js';
import { parseTraceId } from '../src/enrichers/lambda-context.js';
import { apiV1Event, apiV2Event, eventBridgeEvent, snsEvent, sqsEvent } from './helpers.js';

describe('detectTrigger', () => {
  it('API Gateway HTTP API (v2)', () => {
    const t = detectTrigger(apiV2Event);
    expect(t.type).toBe('api_gateway_http');
    expect(t.start(apiV2Event)).toMatchObject({
      http: { method: 'POST', path: '/cotacoes', route: 'POST /cotacoes', source_ip: '10.0.0.1', api_request_id: 'apigw-1' },
    });
  });

  it('API Gateway REST (v1)', () => {
    const t = detectTrigger(apiV1Event);
    expect(t.type).toBe('api_gateway_rest');
    expect(t.start(apiV1Event)).toMatchObject({
      http: { method: 'GET', path: '/apolices/42', route: '/apolices/{id}', stage: 'prd', source_ip: '10.0.0.2', user_agent: 'jest' },
    });
  });

  it('SQS', () => {
    expect(detectTrigger(sqsEvent).start(sqsEvent)).toEqual({
      trigger: { type: 'sqs', queue: 'fila-sinistros', record_count: 2, message_ids: ['m1', 'm2'], max_receive_count: 3 },
    });
  });

  it('SNS', () => {
    expect(detectTrigger(snsEvent).start(snsEvent)).toEqual({
      trigger: { type: 'sns', topic: 'topico-apolice', record_count: 1, message_ids: ['sns-1'] },
    });
  });

  it('EventBridge', () => {
    expect(detectTrigger(eventBridgeEvent).start(eventBridgeEvent)).toMatchObject({
      trigger: { type: 'eventbridge', source: 'mapfre.apolices', detail_type: 'ApoliceEmitida', event_id: 'eb-1' },
    });
  });

  it('desconhecido', () => {
    expect(detectTrigger({ foo: 1 }).type).toBe('unknown');
    expect(detectTrigger(null).type).toBe('unknown');
  });
});

describe('helpers', () => {
  it('parseTraceId extrai o Root do X-Ray', () => {
    expect(parseTraceId('Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1')).toBe(
      '1-5759e988-bd862e3fe1be46a994272793',
    );
    expect(parseTraceId(undefined)).toBeUndefined();
  });

  it('parseLevel aceita aliases e AWS_LAMBDA_LOG_LEVEL', () => {
    expect(parseLevel('DEBUG', 'info')).toBe('debug');
    expect(parseLevel('TRACE', 'info')).toBe('debug');
    expect(parseLevel('FATAL', 'info')).toBe('error');
    expect(parseLevel('lixo', 'info')).toBe('info');
  });
});
