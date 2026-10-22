import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enrich, getCorrelationId, getCurrentEvent } from '../src/index.js';
import { resetColdStart } from '../src/enrichers/lambda-context.js';
import { apiV2Event, captureLogger, fakeContext, sqsEvent } from './helpers.js';

beforeEach(() => resetColdStart());

describe('withWideEvent', () => {
  it('emite um wide event por invocação com sucesso', async () => {
    const { logger, records } = captureLogger();
    const handler = logger.withWideEvent(async () => {
      logger.getEvent().set({ user: { id: 'u1', tier: 'gold' } });
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
      correlation_id: 'corr-1',
      outcome: 'success',
      user: { id: 'u1', tier: 'gold' },
      http: { method: 'POST', path: '/cotacoes', route: 'POST /cotacoes', status_code: 200 },
      trigger: { type: 'api_gateway_http' },
      lambda: { function_name: 'my-fn', memory_limit_mb: 512, cold_start: true, remaining_time_ms: 2900 },
      sampling: { rate: 1, reason: 'all' },
    });
    expect(typeof ev.duration_ms).toBe('number');
    expect(ev.logs).toBeUndefined();
    expect(ev.logs_emitted).toBeUndefined();
  });

  it('emite um wide event com erro e relança a exceção', async () => {
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

  it('logger.warn dentro da invocação escala o wide event para warn', async () => {
    const { logger, wide } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.warn('fallback de tabela de preços');
      return 'ok';
    })({}, fakeContext());
    expect(wide()[0]!.level).toBe('warn');
  });

  it('setLevel força o nível final', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.getEvent().setLevel('error');
      return 'ok';
    })({}, fakeContext());
    expect(records()[0]!.level).toBe('error');
  });

  it('level=silent não emite nada, nem erros', async () => {
    const { logger, records } = captureLogger({ level: 'silent' });
    await expect(
      logger.withWideEvent(async () => {
        logger.error('x');
        throw new Error('x');
      })({}, fakeContext()),
    ).rejects.toThrow('x');
    expect(records()).toHaveLength(0);
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
    const { logger, wide, immediate } = captureLogger();
    const handler = logger.withWideEvent(async (event: { id: string }) => {
      logger.getEvent().set({ order_id: event.id });
      await new Promise((r) => setTimeout(r, event.id === 'a' ? 10 : 1));
      logger.getEvent().add('order_id_check', event.id);
      logger.info('fim', { id: event.id });
      return 'ok';
    });
    await Promise.all([
      handler({ id: 'a' }, fakeContext({ awsRequestId: 'req-a' })),
      handler({ id: 'b' }, fakeContext({ awsRequestId: 'req-b' })),
    ]);
    for (const r of wide()) expect(r.order_id).toBe(r.order_id_check);
    for (const r of immediate()) expect(r.request_id).toBe(`req-${r.data.id}`);
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
    await expect(
      logger.withWideEvent(async () => {
        logger.info('passou aqui');
        return 'ok';
      })({}, fakeContext()),
    ).resolves.toBe('ok');
  });

  it('trunca eventos maiores que maxEventBytes', async () => {
    const { logger, wide } = captureLogger({ maxEventBytes: 2000 });
    await logger
      .withWideEvent(async () => {
        for (let i = 0; i < 50; i++) logger.debug('x'.repeat(100));
        throw new Error('falhou');
      })({}, fakeContext())
      .catch(() => undefined);
    const ev = wide()[0]!;
    expect(ev.truncated).toBe(true);
    expect(ev.logs).toBeUndefined();
    expect(ev.service).toBe('test-service');
  });
});

describe('linhas imediatas dentro da invocação', () => {
  it('saem na hora, antes do wide event, com os IDs da invocação', async () => {
    const { logger, lines, records } = captureLogger();
    process.env._X_AMZN_TRACE_ID = 'Root=1-abc-def;Parent=1;Sampled=1';
    try {
      await logger.withWideEvent(async () => {
        logger.info('passou pela validação', { campos: 3 });
        expect(lines).toHaveLength(1); // já foi escrita antes do handler terminar
        logger.info('passou pelo cálculo');
        return { statusCode: 200 };
      })(apiV2Event, fakeContext());
    } finally {
      delete process.env._X_AMZN_TRACE_ID;
    }

    const out = records();
    expect(out.map((r) => r.log_type)).toEqual(['log', 'log', 'wide_event']);
    expect(out[0]).toMatchObject({
      level: 'info',
      log_type: 'log',
      service: 'test-service',
      request_id: 'req-123',
      trace_id: '1-abc-def',
      correlation_id: 'corr-1',
      message: 'passou pela validação',
      data: { campos: 3 },
    });
    expect(typeof out[0]!.elapsed_ms).toBe('number');
    // todas as linhas da invocação compartilham os mesmos IDs
    expect(new Set(out.map((r) => r.request_id))).toEqual(new Set(['req-123']));
    expect(new Set(out.map((r) => r.correlation_id))).toEqual(new Set(['corr-1']));
    // não duplica no wide event, só conta
    expect(out[2]!.logs).toBeUndefined();
    expect(out[2]!.logs_emitted).toEqual({ info: 2 });
  });

  it('respeitam o LOG_LEVEL', async () => {
    const { logger, immediate, wide } = captureLogger({ level: 'warn' });
    await logger.withWideEvent(async () => {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      return 'ok';
    })({}, fakeContext());
    expect(immediate().map((r) => r.message)).toEqual(['w']);
    expect(wide()[0]!.logs_emitted).toEqual({ warn: 1 });
  });

  it('mensagens abaixo do nível entram no logs[] do wide event só se der erro', async () => {
    const { logger, wide, immediate } = captureLogger();
    await logger.withWideEvent(async () => {
      logger.debug('detalhe 1');
      return 'ok';
    })({}, fakeContext());
    await logger
      .withWideEvent(async () => {
        logger.debug('detalhe 2');
        logger.info('passo');
        throw new Error('falhou');
      })({}, fakeContext())
      .catch(() => undefined);

    const [ok, failed] = wide();
    expect(ok!.logs).toBeUndefined();
    expect(failed!.logs.map((l: any) => l.message)).toEqual(['detalhe 2']);
    expect(immediate().map((r) => r.message)).toEqual(['passo']);
  });

  it('flushDebugOnError=false não inclui debug em erros', async () => {
    const { logger, wide } = captureLogger({ flushDebugOnError: false });
    await logger
      .withWideEvent(async () => {
        logger.debug('detalhe');
        throw new Error('falhou');
      })({}, fakeContext())
      .catch(() => undefined);
    expect(wide()[0]!.logs).toBeUndefined();
  });

  it('limita o buffer de debug em maxLogs, mantendo os mais recentes', async () => {
    const { logger, wide } = captureLogger({ maxLogs: 2 });
    await logger
      .withWideEvent(async () => {
        for (let i = 0; i < 5; i++) logger.debug(`msg ${i}`);
        throw new Error('falhou');
      })({}, fakeContext())
      .catch(() => undefined);
    expect(wide()[0]!.logs.map((l: any) => l.message)).toEqual(['msg 3', 'msg 4']);
  });
});

describe('LOG_LEVEL não descarta wide events', () => {
  it('com level=warn, o wide event info continua sendo gravado', async () => {
    const { logger, wide } = captureLogger({ level: 'warn' });
    await logger.withWideEvent(async () => 'ok')({}, fakeContext());
    expect(wide()).toHaveLength(1);
    expect(wide()[0]!.level).toBe('info');
  });

  it('keep funciona mesmo com level=warn e sampleRate=0', async () => {
    const { logger, wide } = captureLogger({
      level: 'warn',
      sampleRate: 0,
      keep: (e) => (e.get('user.tier') === 'corporate' ? 'cliente_corporativo' : false),
    });
    const handler = logger.withWideEvent(async (tier: string) => {
      logger.getEvent().setUser({ tier });
      return 'ok';
    });
    await handler('gold', fakeContext());
    await handler('corporate', fakeContext());
    expect(wide().map((r) => r.sampling.reason)).toEqual(['cliente_corporativo']);
  });
});

describe('correlation_id', () => {
  afterEach(() => resetColdStart());

  it('usa o request_id quando o evento não traz um', async () => {
    const { logger, records } = captureLogger();
    await logger.withWideEvent(async () => 'ok')({}, fakeContext({ awsRequestId: 'req-xyz' }));
    expect(records()[0]!.correlation_id).toBe('req-xyz');
  });

  it('respeita correlationHeader customizado', async () => {
    const { logger, records } = captureLogger({ correlationHeader: 'x-request-id' });
    const event = { ...apiV2Event, headers: { 'X-Request-Id': 'abc-1' } };
    await logger.withWideEvent(async () => 'ok')(event, fakeContext());
    expect(records()[0]!.correlation_id).toBe('abc-1');
  });

  it('getCorrelationId devolve o ID para repassar a outros serviços', async () => {
    const { logger } = captureLogger();
    let seen: string | undefined;
    await logger.withWideEvent(async () => {
      seen = getCorrelationId();
      return 'ok';
    })(apiV2Event, fakeContext());
    expect(seen).toBe('corr-1');
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('logs fora de invocação', () => {
  it('emitem linha imediata respeitando o nível, sem IDs de invocação', () => {
    const { logger, records } = captureLogger({ level: 'info' });
    logger.debug('ignorado');
    logger.info('conexão inicializada', { pool: 5 });
    const out = records();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'info', log_type: 'log', message: 'conexão inicializada', data: { pool: 5 } });
    expect(out[0]!.request_id).toBeUndefined();
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
      await logger.withWideEvent(async () => 'ok')({}, fakeContext());
      expect(records()).toHaveLength(0); // sampleRate 0 descarta o evento feliz
      await logger.withWideEvent(async () => ({ statusCode: 404 }))(apiV2Event, fakeContext());
      expect(records()[0]).toMatchObject({ level: 'warn', sampling: { rate: 0, reason: 'warn' } });
    } finally {
      delete process.env.LOG_LEVEL;
      delete process.env.LOG_SAMPLE_RATE;
    }
  });
});
