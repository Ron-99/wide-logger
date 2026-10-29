import { normalizeKey } from '../redact.js';
import type { LambdaContext } from '../types.js';

type AnyRecord = Record<string, any>;

function findKey(obj: AnyRecord | undefined, names: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(normalizeKey(key))) return value;
  }
  return undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Procura um ID de correlação de negócio no evento de origem, para ligar logs de
 * serviços diferentes (API → SQS → outra Lambda). Fontes, em ordem:
 * header HTTP, message attribute (SQS/SNS), `detail` (EventBridge) e o próprio payload.
 */
export function extractCorrelationId(event: unknown, headerName: string): string | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  const ev = event as AnyRecord;
  const names = [headerName, 'correlationId', 'correlation_id'];

  // API Gateway (v1 e v2)
  const fromHeader = asId(findKey(ev.headers, names));
  if (fromHeader) return fromHeader;

  const record: AnyRecord | undefined = Array.isArray(ev.Records) ? ev.Records[0] : undefined;
  if (record) {
    // SQS: messageAttributes.<nome>.stringValue
    const sqsAttr = findKey(record.messageAttributes, names) as AnyRecord | undefined;
    const fromSqs = asId(sqsAttr?.stringValue);
    if (fromSqs) return fromSqs;

    // SNS: Sns.MessageAttributes.<nome>.Value
    const snsAttr = findKey(record.Sns?.MessageAttributes, names) as AnyRecord | undefined;
    const fromSns = asId(snsAttr?.Value);
    if (fromSns) return fromSns;
  }

  // EventBridge
  const fromDetail = asId(findKey(ev.detail, names));
  if (fromDetail) return fromDetail;

  // Invocação direta com o ID no payload
  return asId(findKey(ev, names));
}

/**
 * ID de correlação enviado por outra Lambda no `ClientContext` da invocação
 * (`Custom.correlationId`), sem alterar o payload.
 */
export function extractClientContextCorrelationId(context: LambdaContext | undefined, headerName: string): string | undefined {
  const custom = context?.clientContext?.Custom;
  if (!custom || typeof custom !== 'object') return undefined;
  return asId(findKey(custom, [headerName, 'correlationId', 'correlation_id']));
}
