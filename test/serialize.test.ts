import { describe, expect, it } from 'vitest';
import { sanitize, serializeError } from '../src/index.js';
import { createRedactor } from '../src/redact.js';

const opts = { isSensitive: createRedactor(), maxStringLength: 20, includeStack: false };

describe('sanitize', () => {
  it('trata referências circulares sem marcar referências compartilhadas', () => {
    const shared = { a: 1 };
    const obj: Record<string, unknown> = { x: shared, y: shared };
    obj.self = obj;
    expect(sanitize(obj, opts)).toEqual({ x: { a: 1 }, y: { a: 1 }, self: '[Circular]' });
  });

  it('converte tipos especiais', () => {
    const out = sanitize(
      {
        date: new Date('2026-01-01T00:00:00Z'),
        big: 10n,
        map: new Map([['k', 'v']]),
        set: new Set([1, 2]),
        buf: Buffer.from('abc'),
        fn: () => 1,
        nan: Number.NaN,
      },
      opts,
    );
    expect(out).toEqual({
      date: '2026-01-01T00:00:00.000Z',
      big: '10',
      map: { k: 'v' },
      set: [1, 2],
      buf: '[Buffer 3 bytes]',
      nan: 'NaN',
    });
  });

  it('trunca strings longas', () => {
    expect(sanitize('a'.repeat(30), opts)).toBe(`${'a'.repeat(20)}…[truncated 10 chars]`);
  });

  it('redige chaves com variações de caixa e separadores', () => {
    expect(sanitize({ Authorization: 'x', 'x-api-key': 'y', access_token: 'z', ok: 1 }, opts)).toEqual({
      Authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      access_token: '[REDACTED]',
      ok: 1,
    });
  });
});

describe('serializeError', () => {
  it('inclui propriedades próprias, code, cause e metadados do AWS SDK', () => {
    const cause = new TypeError('timeout');
    const err = Object.assign(new Error('falha DynamoDB', { cause }), {
      name: 'ProvisionedThroughputExceededException',
      $retryable: { throttling: true },
      $metadata: { httpStatusCode: 400, requestId: 'aws-req-1' },
      tableName: 'apolices',
    });
    const info = serializeError(err, false);
    expect(info).toEqual({
      type: 'ProvisionedThroughputExceededException',
      message: 'falha DynamoDB',
      $retryable: { throttling: true },
      tableName: 'apolices',
      retriable: true,
      http_status_code: 400,
      aws_request_id: 'aws-req-1',
      cause: { type: 'TypeError', message: 'timeout' },
    });
  });

  it('lida com valores que não são Error', () => {
    expect(serializeError('boom')).toEqual({ type: 'NonError', message: 'boom' });
    expect(serializeError({ name: 'Custom', message: 'm' })).toEqual({ type: 'Custom', message: 'm' });
  });
});
