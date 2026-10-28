import { beforeEach, describe, expect, it } from 'vitest';
import { resetColdStart } from '../src/enrichers/lambda-context.js';
import { apiV2Event, captureLogger, fakeContext, sqsEvent } from './helpers.js';

beforeEach(() => resetColdStart());

describe('saída via pino', () => {
  it('escreve level em texto, sem pid/hostname, com message e timestamp do registro', () => {
    const { logger, records, lines } = captureLogger();
    logger.warn('atenção', { x: 1 });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(false);
    const out = records()[0]!;
    expect(out).toMatchObject({ level: 'warn', log_type: 'log', message: 'atenção', data: { x: 1 } });
    expect(typeof out.timestamp).toBe('string');
    expect(out.pid).toBeUndefined();
    expect(out.hostname).toBeUndefined();
    expect(out.msg).toBeUndefined();
    expect(out.time).toBeUndefined();
  });

  it('expõe a instância pino', () => {
    const { logger } = captureLogger();
    expect(typeof logger.pino.info).toBe('function');
  });
});

describe('campos para o Dynatrace', () => {
  it('inclui service.name, service.version e deployment.environment em todas as linhas', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.info('passo');
      return { statusCode: 200 };
    })(apiV2Event, fakeContext());

    for (const r of records()) {
      expect(r).toMatchObject({
        'service.name': 'test-service',
        'service.version': '1.0.0',
        'deployment.environment': 'test',
      });
    }
  });

  it('adiciona dt.trace_id e dt.span_id quando traceContext retorna valores', async () => {
    const ctx = { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7' };
    const { logger, records } = captureLogger({ traceContext: () => ctx });
    await logger.withWideEvent(async () => {
      logger.info('passo');
      return { statusCode: 200 };
    })(apiV2Event, fakeContext());

    const out = records();
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r['dt.trace_id']).toBe(ctx.trace_id);
      expect(r['dt.span_id']).toBe(ctx.span_id);
    }
  });

  it('omite dt.* sem traceContext ou quando ele lança', async () => {
    for (const traceContext of [undefined, () => { throw new Error('sem span'); }]) {
      const { logger, records } = captureLogger({ traceContext });
      await logger.withWideEvent(async () => ({ statusCode: 200 }))(apiV2Event, fakeContext());
      expect(records()).toHaveLength(1);
      expect(records()[0]!['dt.trace_id']).toBeUndefined();
    }
  });
});

describe('message do wide event', () => {
  it('resume requisições HTTP', async () => {
    const { logger, wide } = captureLogger();
    await logger.withWideEvent(async () => ({ statusCode: 201 }))(apiV2Event, fakeContext());
    expect(wide()[0]!.message).toMatch(/^POST \/cotacoes 201 success \d+ms$/);
  });

  it('resume lotes SQS com erro', async () => {
    const { logger, wide } = captureLogger();
    await expect(
      logger.withWideEvent(async () => {
        throw new Error('falhou');
      })(sqsEvent, fakeContext()),
    ).rejects.toThrow('falhou');
    expect(wide()[0]!.message).toMatch(/^sqs fila-sinistros error \d+ms$/);
  });

  it('usa o service quando não há gatilho reconhecido', async () => {
    const { logger, wide } = captureLogger();
    await logger.withWideEvent(async () => 'ok')({}, fakeContext());
    expect(wide()[0]!.message).toMatch(/^test-service success \d+ms$/);
  });
});

describe('nível com pino', () => {
  it('LOG_LEVEL=warn não descarta wide event info', async () => {
    const { logger, wide, immediate } = captureLogger({ level: 'warn' });
    await logger.withWideEvent(async () => {
      logger.info('não sai');
      return { statusCode: 200 };
    })(apiV2Event, fakeContext());
    expect(immediate()).toHaveLength(0);
    expect(wide()).toHaveLength(1);
    expect(wide()[0]!.level).toBe('info');
  });
});
