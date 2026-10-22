import { createLogger } from '../src/index.js';
import type { LambdaContext } from '../src/index.js';

const logger = createLogger({ service: 'processa-sinistros', version: '1.0.0', environment: 'dev' });

interface SqsEvent {
  Records: Array<{ messageId: string; body: string; eventSource: string; eventSourceARN: string }>;
}

export const handler = logger.withWideEvent(async (event: SqsEvent) => {
  const we = logger.getEvent();
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  logger.info('lote recebido', { mensagens: event.Records.length });

  for (const record of event.Records) {
    const sinistro = JSON.parse(record.body);
    try {
      if (!sinistro.apoliceId) throw new Error('apoliceId ausente');
      we.increment('sinistros.processados');
    } catch (err) {
      we.increment('sinistros.falhas');
      logger.warn('falha ao processar mensagem', { messageId: record.messageId, error: err });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // failed_count > 0 faz o evento sair como `warn` e nunca ser descartado pelo sampling.
  return { batchItemFailures };
});

// Execução local: npx tsx examples/sqs-handler.ts
const context: LambdaContext = {
  awsRequestId: 'local-req-2',
  functionName: 'processa-sinistros',
  functionVersion: '$LATEST',
  memoryLimitInMB: '256',
};
const arn = 'arn:aws:sqs:sa-east-1:123456789012:fila-sinistros';

await handler(
  {
    Records: [
      { messageId: 'm1', body: JSON.stringify({ apoliceId: 'A1' }), eventSource: 'aws:sqs', eventSourceARN: arn },
      { messageId: 'm2', body: JSON.stringify({}), eventSource: 'aws:sqs', eventSourceARN: arn },
    ],
  },
  context,
);
