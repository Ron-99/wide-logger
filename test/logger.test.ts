import { beforeEach, describe, expect, it } from 'vitest';
import { enrich, getCurrentEvent } from '../src/index.js';
import { resetColdStart } from '../src/enrichers/lambda-context.js';
import { apiV2Event, captureLogger, fakeContext, sqsEvent } from './helpers.js';

beforeEach(() => resetColdStart());

describe('withWideEvent', () => {
  it('emite exatamente uma linha por invocação com sucesso', async () => {
    const { logger, records } = captureLogger();
    const handler = logger.withWideEvent(async () => {
      logger.getEvent().set({ user: { id: 'u1', tier: 'gold' } });
      logger.info('cotação calculada', { premium_cents: 1000 });
      return { statusCode: 200, body: 'ok' };
    });

    await expect(handler(apiV2Event, fakeContext())).resolves.toEqual({ statusCode: 200, body: 'ok' });

    const out = records();
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev).toMatchObject({
      level: 'info',
      log_type: 'wide_event',
      service: 'test-service',
      version: '1.0.0',
      environment: 'test',
      request_id: 'req-123',
      outcome: 'success',
      user: { id: 'u1', tier: 'gold' },
      http: { method: 'POST', path: '/cotacoes', route: 'POST /cotacoes', status_code: 200, correlation_id: 'corr-1' },
      trigger: { type: 'api_gateway_http' },
      lambda: { function_name: 'my-fn', memory_limit_mb: 512, cold_start: true, remaining_time_ms: 2900 },
      sampling: { rate: 1, reason: 'all' },
    });
    expect(typeof ev.duration_ms).toBe('number');
    expect(ev.logs).toEqual([
      expect.objectContaining({ level: 'info', message: 'cotação calculada', data: { premium_cents: 1000 } }),
    ]);
  });

  it('emite uma linha com erro e relança a exceção', async () => {
    const { logger, records } = captureLogger();
    const boom = Object.assign(new Error('cartão recusado'), { code: 'card_declined', retriable: false });
    const handler = logger.withWideEvent(async () => {
      throw boom;
    });

    await expect(handler({}, fakeContext())).rejects.toBe(boom);

    const out = records();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      level: 'error',
      outcome: 'error',
      error: { type: 'Error', message: 'cartão recusado', code: 'card_declined', retriable: false },
      sampling: { reason: 'error' },
    });
    expect(out[0]!.error.stack).toContain('cartão recusado');
  });

  it('marca cold start apenas na primeira invocação', async () => {
    const { logger, records } = captureLogger();
    const handler = logger.withWideEvent(async () => 'ok');
    await handler({}, fakeContext());
    await handler({}, fakeContext());
    expect(records().map((r) => r.lambda.cold_start)).toEqual([true, false]);
  });

  it('deriva warn para respostas 4xx e error para 5xx', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => ({ statusCode: 404 }))(apiV2Event, fakeContext());
    await logger.withWideEvent(async () => ({ statusCode: 503 }))(apiV2Event, fakeContext());
    expect(records().map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('logger.warn dentro da invocação escala o evento para warn', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.warn('fallback de tabela de preços');
      return 'ok';
    })({}, fakeContext());
    expect(records()[0]!.level).toBe('warn');
  });

  it('setLevel força o nível final', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.getEvent().setLevel('error');
      return 'ok';
    })({}, fakeContext());
    expect(records()[0]!.level).toBe('error');
  });

  it('respeita o nível mínimo: eventos info não saem com level=warn', async () => {
    const { logger, records } = captureLogger({ level: 'warn' });
    await logger.withWideEvent(async () => 'ok')({}, fakeContext());
    expect(records()).toHaveLength(0);
  });

  it('level=silent não emite nada, nem erros', async () => {
    const { logger, records } = captureLogger({ level: 'silent' });
    await expect(
      logger.withWideEvent(async () => {
        throw new Error('x');
      })({}, fakeContext()),
    ).rejects.toThrow('x');
    expect(records()).toHaveLength(0);
  });

  it('filtra debug do logs[] com level=info, mas inclui quando termina em erro', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.debug('detalhe 1');
      logger.info('passo');
      return 'ok';
    })({}, fakeContext());
    await logger
      .withWideEvent(async () => {
        logger.debug('detalhe 2');
        logger.info('passo');
        throw new Error('falhou');
      })({}, fakeContext())
      .catch(() => undefined);

    const [ok, failed] = records();
    expect(ok!.logs.map((l: any) => l.message)).toEqual(['passo']);
    expect(failed!.logs.map((l: any) => l.message)).toEqual(['detalhe 2', 'passo']);
  });

  it('flushDebugOnError=false não inclui debug em erros', async () => {
    const { logger, records } = captureLogger({ flushDebugOnError: false });
    await logger
      .withWideEvent(async () => {
        logger.debug('detalhe');
        throw new Error('falhou');
      })({}, fakeContext())
      .catch(() => undefined);
    expect(records()[0]!.logs).toBeUndefined();
  });

  it('limita logs[] em maxLogs e informa os descartados', async () => {
    const { logger, records } = captureLogger({ maxLogs: 2 });
    await logger.withWideEvent(async () => {
      for (let i = 0; i < 5; i++) logger.info(`msg ${i}`);
      return 'ok';
    })({}, fakeContext());
    const ev = records()[0]!;
    expect(ev.logs).toHaveLength(2);
    expect(ev.logs_dropped).toBe(3);
  });

  it('getCurrentEvent/enrich funcionam em camadas profundas', async () => {
    const { logger, records } = captureLogger();
    const repository = async () => {
      enrich({ db: { table: 'apolices' } });
      getCurrentEvent()?.increment('db.queries');
      getCurrentEvent()?.increment('db.queries');
    };
    await logger.withWideEvent(async () => {
      await repository();
      return 'ok';
    })({}, fakeContext());
    expect(records()[0]!.db).toEqual({ table: 'apolices', queries: 2 });
  });

  it('timer grava latência em timings', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => {
      const end = logger.getEvent().timer('pricing');
      await new Promise((r) => setTimeout(r, 5));
      end();
      return 'ok';
    })({}, fakeContext());
    expect(records()[0]!.timings.pricing_ms).toBeGreaterThanOrEqual(0);
  });

  it('isola eventos de invocações concorrentes', async () => {
    const { logger, records } = captureLogger();
    const handler = logger.withWideEvent(async (event: { id: string }) => {
      logger.getEvent().set({ order_id: event.id });
      await new Promise((r) => setTimeout(r, event.id === 'a' ? 10 : 1));
      logger.getEvent().add('order_id_check', event.id);
      return 'ok';
    });
    await Promise.all([handler({ id: 'a' }, fakeContext()), handler({ id: 'b' }, fakeContext())]);
    for (const r of records()) expect(r.order_id).toBe(r.order_id_check);
  });

  it('redige chaves sensíveis (padrão + customizadas)', async () => {
    const { logger, records } = captureLogger({ redactKeys: ['numeroApolice'] });
    await logger.withWideEvent(async () => {
      logger.getEvent().set({ user: { id: 'u1', cpf: '123.456.789-00', senha: 'x' }, numero_apolice: 'P-1' });
      return 'ok';
    })({}, fakeContext());
    const ev = records()[0]!;
    expect(ev.user).toEqual({ id: 'u1', cpf: '[REDACTED]', senha: '[REDACTED]' });
    expect(ev.numero_apolice).toBe('[REDACTED]');
  });

  it('marca warn e conta falhas parciais de batch SQS', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => ({ batchItemFailures: [{ itemIdentifier: 'm2' }] }))(sqsEvent, fakeContext());
    const ev = records()[0]!;
    expect(ev.level).toBe('warn');
    expect(ev.trigger).toMatchObject({ type: 'sqs', queue: 'fila-sinistros', failed_count: 1, failed_ids: ['m2'] });
  });

  it('nunca derruba o handler se o transport falhar', async () => {
    const { logger } = captureLogger({
      transport: () => {
        throw new Error('stdout quebrado');
      },
    });
    await expect(logger.withWideEvent(async () => 'ok')({}, fakeContext())).resolves.toBe('ok');
  });

  it('trunca eventos maiores que maxEventBytes', async () => {
    const { logger, records } = captureLogger({ maxEventBytes: 2000 });
    await logger.withWideEvent(async () => {
      for (let i = 0; i < 50; i++) logger.info('x'.repeat(100));
      return 'ok';
    })({}, fakeContext());
    const ev = records()[0]!;
    expect(ev.truncated).toBe(true);
    expect(ev.logs).toBeUndefined();
    expect(ev.service).toBe('test-service');
  });
});

describe('logs fora de invocação', () => {
  it('emitem linha imediata respeitando o nível', () => {
    const { logger, records } = captureLogger({ level: 'info' });
    logger.debug('ignorado');
    logger.info('conexão inicializada', { pool: 5 });
    const out = records();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'info', log_type: 'log', message: 'conexão inicializada', data: { pool: 5 } });
  });

  it('getEvent lança erro fora de withWideEvent', () => {
    const { logger } = captureLogger();
    expect(() => logger.getEvent()).toThrow(/fora de uma invocação/);
  });
});

describe('configuração por variáveis de ambiente', () => {
  it('lê LOG_LEVEL e LOG_SAMPLE_RATE', async () => {
    process.env.LOG_LEVEL = 'WARN';
    process.env.LOG_SAMPLE_RATE = '0';
    try {
      const { logger, records } = captureLogger({ level: undefined, sampleRate: undefined });
      expect(logger.level).toBe('warn');
      await logger.withWideEvent(async () => ({ statusCode: 404 }))(apiV2Event, fakeContext());
      expect(records()[0]).toMatchObject({ level: 'warn', sampling: { rate: 0, reason: 'warn' } });
    } finally {
      delete process.env.LOG_LEVEL;
      delete process.env.LOG_SAMPLE_RATE;
    }
  });
});
