import { createLogger, getCorrelationId, getCurrentEvent } from '../src/index.js';
import type { LambdaContext } from '../src/index.js';

const logger = createLogger({
  service: 'cotacao-auto',
  version: '2.4.1',
  environment: 'dev',
  slowThresholdMs: 2000,
  sampleRate: 0.05,
  // Sempre manter clientes corporativos, independente do sampling.
  keep: (e) => (e.get('user.tier') === 'corporate' ? 'corporate_user' : false),
});

// Camada de serviço: enriquece o evento sem receber nada por parâmetro.
async function calcularPremio(placa: string) {
  const end = getCurrentEvent()?.timer('motor_preco');
  // Em uma chamada real, repasse o ID: headers: { 'x-correlation-id': getCorrelationId() }
  logger.info('chamando motor de preço', { correlation_id: getCorrelationId() });
  await new Promise((r) => setTimeout(r, 20));
  end?.();
  getCurrentEvent()?.set({ veiculo: { placa_final: placa.slice(-1), categoria: 'passeio' } });
  return { id: 'cot_123', premium_cents: 189900, rules: ['bonus_classe_5', 'regiao_sp'] };
}

export const handler = logger.withWideEvent(async (event: { body?: string }) => {
  const we = logger.getEvent();
  const body = JSON.parse(event.body ?? '{}');
  logger.info('payload validado'); // linha imediata, com request_id e correlation_id

  we.set({ user: { id: body.userId, tier: body.tier, cpf: body.cpf } }); // cpf é redigido automaticamente
  we.set({ feature_flags: { novo_motor_preco: true } });

  const quote = await calcularPremio(body.placa);
  we.set({ quote: { id: quote.id, premium_cents: quote.premium_cents } });
  logger.debug('regras aplicadas', { rules: quote.rules }); // com LOG_LEVEL=info, só aparece (no logs[]) se der erro

  return { statusCode: 201, body: JSON.stringify(quote) };
});

// Execução local: npx tsx examples/api-handler.ts
const context: LambdaContext = {
  awsRequestId: 'local-req-1',
  functionName: 'cotacao-auto',
  functionVersion: '$LATEST',
  memoryLimitInMB: '512',
  getRemainingTimeInMillis: () => 29_000,
};

await handler(
  {
    version: '2.0',
    routeKey: 'POST /cotacoes',
    rawPath: '/cotacoes',
    headers: { 'user-agent': 'curl/8.0', 'x-correlation-id': 'cotacao-7f3a' },
    requestContext: { requestId: 'apigw-1', stage: '$default', http: { method: 'POST', path: '/cotacoes', sourceIp: '127.0.0.1', userAgent: 'curl/8.0' } },
    body: JSON.stringify({ userId: 'u_456', tier: 'corporate', cpf: '123.456.789-00', placa: 'ABC1D23' }),
  } as { body?: string },
  context,
);
