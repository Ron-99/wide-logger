import {
  apiGatewayResultFields,
  enrichApiGatewayV1,
  enrichApiGatewayV2,
  isApiGatewayV1,
  isApiGatewayV2,
} from './api-gateway.js';
import {
  batchResultFields,
  enrichEventBridge,
  enrichSns,
  enrichSqs,
  isEventBridge,
  isSns,
  isSqs,
} from './messaging.js';

export type TriggerType = 'api_gateway_http' | 'api_gateway_rest' | 'sqs' | 'sns' | 'eventbridge' | 'unknown';

export interface TriggerEnricher {
  type: TriggerType;
  start: (event: any) => Record<string, unknown>;
  result?: (result: unknown) => Record<string, unknown>;
}

const ENRICHERS: Array<TriggerEnricher & { matches: (event: any) => boolean }> = [
  { type: 'api_gateway_http', matches: isApiGatewayV2, start: enrichApiGatewayV2, result: apiGatewayResultFields },
  { type: 'api_gateway_rest', matches: isApiGatewayV1, start: enrichApiGatewayV1, result: apiGatewayResultFields },
  { type: 'sqs', matches: isSqs, start: enrichSqs, result: batchResultFields },
  { type: 'sns', matches: isSns, start: enrichSns },
  { type: 'eventbridge', matches: isEventBridge, start: enrichEventBridge },
];

const UNKNOWN: TriggerEnricher = { type: 'unknown', start: () => ({ trigger: { type: 'unknown' } }) };

export function detectTrigger(event: unknown): TriggerEnricher {
  if (event === null || typeof event !== 'object') return UNKNOWN;
  return ENRICHERS.find((e) => e.matches(event)) ?? UNKNOWN;
}
