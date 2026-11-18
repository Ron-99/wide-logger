import { beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
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

describe('integração com @opentelemetry/instrumentation-pino', () => {
  // Simula o que a instrumentação faz: instala um mixin com o contexto do span ativo.
  const otelMixin = () => ({ 'dt.trace_id': 'otel-trace', 'dt.span_id': 'otel-span', 'dt.trace_flags': '01' });

  it('campos injetados pelo mixin não são apagados por chaves undefined do registro', async () => {
    const { logger, records } = captureLogger({ traceContext: () => undefined });
    (logger.pino as unknown as Record<symbol, unknown>)[pino.symbols.mixinSym] = otelMixin;

    logger.info('fora');
    await logger.withWideEvent(async () => {
      logger.info('dentro');
      return { statusCode: 200 };
    })(apiV2Event, fakeContext());

    expect(records()).toHaveLength(3);
    for (const r of records()) {
      expect(r).toMatchObject({ 'dt.trace_id': 'otel-trace', 'dt.span_id': 'otel-span', 'dt.trace_flags': '01' });
    }
  });

  it('sem X-Ray, o trace_id do mixin (chave padrão da instrumentação) não é apagado', async () => {
    const previous = process.env._X_AMZN_TRACE_ID;
    delete process.env._X_AMZN_TRACE_ID;
    try {
      const { logger, records } = captureLogger();
      (logger.pino as unknown as Record<symbol, unknown>)[pino.symbols.mixinSym] = () => ({ trace_id: 'otel-trace' });
      await logger.withWideEvent(async () => {
        logger.info('dentro');
        return { statusCode: 200 };
      })(apiV2Event, fakeContext());
      for (const r of records()) expect(r.trace_id).toBe('otel-trace');
    } finally {
      if (previous !== undefined) process.env._X_AMZN_TRACE_ID = previous;
    }
  });

  it('createPinoInstrumentation usa as chaves dt.* e desliga o envio via OTLP por padrão', async () => {
    const { createPinoInstrumentation, DYNATRACE_LOG_KEYS } = await import('../src/otel.js');
    const inst = createPinoInstrumentation({ enabled: false });
    expect(inst.getConfig()).toMatchObject({ logKeys: DYNATRACE_LOG_KEYS, disableLogSending: true });
    expect(createPinoInstrumentation({ enabled: false, disableLogSending: false }).getConfig().disableLogSending).toBe(false);
  });
});
