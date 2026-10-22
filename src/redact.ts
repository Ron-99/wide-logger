export const REDACTED = '[REDACTED]';

/** Chaves sensíveis redigidas por padrão (comparação normalizada: minúsculas, sem `-`/`_`). */
export const DEFAULT_REDACT_KEYS = [
  'password',
  'senha',
  'passwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'apikey',
  'xapikey',
  'privatekey',
  'cpf',
  'cnpj',
  'rg',
  'cardnumber',
  'numerocartao',
  'creditcard',
  'pan',
  'cvv',
  'cvc',
];

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

export type KeyPredicate = (key: string) => boolean;

export function createRedactor(extraKeys: string[] = [], useDefaults = true): KeyPredicate {
  const keys = new Set([...(useDefaults ? DEFAULT_REDACT_KEYS : []), ...extraKeys].map(normalizeKey));
  if (keys.size === 0) return () => false;
  return (key) => keys.has(normalizeKey(key));
}
