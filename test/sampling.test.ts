import { describe, expect, it } from 'vitest';
import { shouldSample, WideEvent } from '../src/index.js';
import { captureLogger, fakeContext } from './helpers.js';

const newEvent = () => new WideEvent({ minLevel: 'info', maxLogs: 10, includeStack: true });
const base = { durationMs: 10, slowThresholdMs: 1000, random: () => 0.99 };

describe('shouldSample', () => {
  it('sempre mantém erros, lentos e warns mesmo com rate 0', () => {
    expect(shouldSample({ ...base, event: newEvent(), level: 'error', sampleRate: 0 })).toMatchObject({ keep: true, reason: 'error' });
    expect(shouldSample({ ...base, event: newEvent(), level: 'info', sampleRate: 0, durationMs: 5000 })).toMatchObject({ keep: true, reason: 'slow' });
    expect(shouldSample({ ...base, event: newEvent(), level: 'warn', sampleRate: 0 })).toMatchObject({ keep: true, reason: 'warn' });
  });

  it('aplica a regra keep customizada (com motivo)', () => {
    const event = newEvent().set({ user: { tier: 'vip' } });
    const keep = (e: WideEvent) => (e.get('user.tier') === 'vip' ? 'vip_user' : false);
    expect(shouldSample({ ...base, event, level: 'info', sampleRate: 0, keep })).toMatchObject({ keep: true, reason: 'vip_user' });
  });

  it('regra keep que lança erro é ignorada', () => {
    const keep = () => {
      throw new Error('bug');
    };
    expect(shouldSample({ ...base, event: newEvent(), level: 'info', sampleRate: 0, keep }).keep).toBe(false);
  });

  it('amostra o restante pela taxa', () => {
    expect(shouldSample({ ...base, event: newEvent(), level: 'info', sampleRate: 0.05, random: () => 0.01 })).toMatchObject({ keep: true, reason: 'sampled' });
    expect(shouldSample({ ...base, event: newEvent(), level: 'info', sampleRate: 0.05, random: () => 0.5 })).toMatchObject({ keep: false, reason: 'dropped' });
  });
});

describe('sampling integrado ao logger', () => {
  it('descarta invocações felizes e mantém as com erro', async () => {
    const { logger, records } = captureLogger({ sampleRate: 0.05, random: () => 0.9 });
    await logger.withWideEvent(async () => 'ok')({}, fakeContext());
    await logger
      .withWideEvent(async () => {
        throw new Error('x');
      })({}, fakeContext())
      .catch(() => undefined);
    expect(records().map((r) => r.outcome)).toEqual(['error']);
  });

  it('invocação lenta vira warn e é mantida', async () => {
    const { logger, records } = captureLogger({ sampleRate: 0, slowThresholdMs: 1 });
    await logger.withWideEvent(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return 'ok';
    })({}, fakeContext());
    expect(records()[0]).toMatchObject({ level: 'warn', sampling: { reason: 'slow' } });
  });
});
