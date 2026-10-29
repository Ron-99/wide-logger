# @mapfre/wide-logger

Logger para AWS Lambda no padrão **wide event** (canonical log line), baseado em [loggingsucks.com](https://loggingsucks.com/).

Em vez de várias linhas soltas (`"iniciando"`, `"buscou usuário"`, `"pagamento falhou"`), cada invocação produz **um único evento JSON rico em contexto**, enriquecido ao longo da execução e emitido **uma vez** no final. Assim, cada linha responde sozinha "o que aconteceu com essa requisição?" e pode ser consultada por qualquer campo no CloudWatch Logs Insights.

- Saída via [pino](https://getpino.io) (única dependência de runtime), ESM + CJS, Node >= 18
- Formato pronto para CloudWatch **e Dynatrace** (nível em texto, `message` legível, `service.name`, `dt.trace_id`)
- Log levels derivados do resultado da invocação
- Linhas imediatas ("passou por aqui") ligadas à invocação por `request_id`, `trace_id` e `correlation_id`
- Tail sampling (erros, lentos e warns são sempre mantidos)
- Enriquecimento automático: contexto da Lambda, cold start, X-Ray, API Gateway (REST e HTTP API), SQS, SNS e EventBridge
- Redação de dados sensíveis (senha, token, CPF, CNPJ, cartão...)
- Acesso ao evento de qualquer camada via `AsyncLocalStorage`

## Uso

```ts
import { createLogger } from '@mapfre/wide-logger';

const logger = createLogger({
  service: 'cotacao-auto',
  slowThresholdMs: 2000,
  sampleRate: 0.05,
  keep: (e) => (e.get('user.tier') === 'corporate' ? 'corporate_user' : false),
});

export const handler = logger.withWideEvent(async (event) => {
  const we = logger.getEvent();
  we.set({ user: { id: 'u_456', tier: 'corporate' } });

  const end = we.timer('motor_preco');
  const quote = await calcular();
  end(); // grava timings.motor_preco_ms

  we.set({ quote: { id: quote.id, premium_cents: quote.premium } });
  logger.debug('regras aplicadas', { rules: quote.rules });

  return { statusCode: 201, body: JSON.stringify(quote) };
});
```

Saída (uma linha por invocação):

```json
{"level":"info","timestamp":"2026-10-22T15:25:27.475Z","log_type":"wide_event","message":"POST /cotacoes 201 success 27ms","service":"cotacao-auto","version":"2.4.1","environment":"dev","service.name":"cotacao-auto","service.version":"2.4.1","deployment.environment":"dev","request_id":"c0ffee...","trace_id":"1-5759e988-...","region":"sa-east-1","lambda":{"function_name":"cotacao-auto","memory_limit_mb":512,"cold_start":true,"remaining_time_ms":29000,"memory_used_mb":72},"trigger":{"type":"api_gateway_http"},"http":{"method":"POST","path":"/cotacoes","route":"POST /cotacoes","status_code":201},"user":{"id":"u_456","tier":"corporate"},"timings":{"motor_preco_ms":22},"quote":{"id":"cot_123","premium_cents":189900},"outcome":"success","duration_ms":27,"sampling":{"rate":0.05,"reason":"corporate_user"}}
```

### Enriquecendo de outras camadas

```ts
import { enrich, getCurrentEvent } from '@mapfre/wide-logger';

export async function buscarApolice(id: string) {
  const end = getCurrentEvent()?.timer('dynamodb');
  const item = await ddb.get(...);
  end?.();
  enrich({ apolice: { id, produto: item.produto } });
  getCurrentEvent()?.increment('db.queries');
}
```

Fora de uma invocação, `getCurrentEvent()` retorna `undefined` e `enrich()` não faz nada. `logger.getEvent()` lança erro.

### API do `WideEvent`

| Método | Descrição |
|---|---|
| `set(fields)` | Merge profundo de campos |
| `add('a.b.c', valor)` / `get('a.b.c')` | Escrita/leitura por caminho |
| `increment('db.queries', n?)` | Contador |
| `setUser(user)` | Atalho para `set({ user })` |
| `setError(err, extra?)` | Registra erro tratado (evento vira `error`) |
| `timer(nome)` | Retorna função que grava `timings.<nome>_ms` |
| `escalate(level)` | Garante nível mínimo (ex.: `'warn'`) |
| `setLevel(level)` | Força o nível final |

## Dois tipos de linha

| `log_type` | Quando sai | Quem decide se sai |
|---|---|---|
| `"log"` | Na hora, a cada `logger.debug/info/warn/error()` | `LOG_LEVEL` |
| `"wide_event"` | Uma vez, no fim da invocação | Tail sampling (`sampleRate`, `keep`, `slowThresholdMs`) |

### Linhas imediatas ("passou por aqui")

```ts
logger.info('payload validado');
logger.info('chamando motor de preço', { produto: 'auto' });
```

Cada chamada vira uma linha **na hora**, já ligada à invocação:

```json
{"level":"info","timestamp":"...","log_type":"log","service":"cotacao-auto","service.name":"cotacao-auto","request_id":"c0ffee-1","trace_id":"1-5759e988-...","correlation_id":"cotacao-7f3a","elapsed_ms":2,"message":"payload validado"}
```

Essas mensagens **não são copiadas** para o wide event. Ele traz apenas `logs_emitted: { info: 2, warn: 1 }`, para você saber que existem linhas daquela invocação.

### IDs de correlação

Todas as linhas de uma invocação, imediatas e wide event, carregam os mesmos IDs:

| Campo | O que é | Use para |
|---|---|---|
| `request_id` | `awsRequestId` da Lambda. Sempre existe, único por invocação | **Chave principal**: juntar as linhas imediatas, o wide event e as linhas `START/END/REPORT` da própria Lambda |
| `trace_id` | Root do X-Ray (`_X_AMZN_TRACE_ID`), quando o tracing está ativo | Navegar pelo X-Ray/ServiceLens |
| `correlation_id` | ID de negócio que atravessa serviços. Se não vier no evento, é igual ao `request_id` | Seguir um processo por várias Lambdas (API → SQS → outra Lambda) |

O `correlation_id` é lido, nesta ordem, de:
1. o header `x-correlation-id` (API Gateway); o nome é configurável com `correlationHeader`;
2. o message attribute `correlationId` ou `x-correlation-id` do primeiro record (SQS e SNS);
3. `detail.correlationId` (EventBridge);
4. `correlationId` ou `correlation_id` no payload (invocação direta);
5. `Custom.correlationId` do `ClientContext` da invocação (Lambda chamando Lambda sem alterar o payload).

Para o processo continuar ligado no próximo serviço, repasse o ID:

```ts
import { getCorrelationId } from '@mapfre/wide-logger';

await sqs.send(new SendMessageCommand({
  QueueUrl,
  MessageBody: JSON.stringify(payload),
  MessageAttributes: { correlationId: { DataType: 'String', StringValue: getCorrelationId() } },
}));
```

Entre Lambdas, sem mexer no payload:

```ts
await lambda.send(new InvokeCommand({
  FunctionName,
  Payload: JSON.stringify(payload),
  ClientContext: Buffer.from(JSON.stringify({ Custom: { correlationId: getCorrelationId() } })).toString('base64'),
}));
```

## Log levels

Níveis: `debug < info < warn < error`, além de `silent`.

- **`LOG_LEVEL` filtra as linhas imediatas**, como num logger tradicional. Com `LOG_LEVEL=warn`, `logger.info()` não gera linha.
- **`LOG_LEVEL` não descarta wide events.** Quem decide se o wide event é gravado é só o tail sampling. Assim, uma regra `keep` sempre funciona. A exceção é `silent`, que desliga tudo (útil em testes).
- **O `level` do wide event é derivado do resultado**, calculado no fim da invocação:
  - `error`: exceção lançada, `setError()`, `logger.error()` ou HTTP 5xx
  - `warn`: HTTP 4xx, duração acima de `slowThresholdMs`, `logger.warn()` ou falha parcial em lote SQS
  - `info`: nos demais casos
- **Debug-on-error**: mensagens abaixo do `LOG_LEVEL` não geram linha, mas ficam em buffer. Se a invocação terminar em `error`, elas entram no `logs[]` do wide event. Rode com `LOG_LEVEL=info` em produção e ainda veja o debug das falhas (`flushDebugOnError`).
- **Fora** de uma invocação (código de init), as linhas imediatas saem sem os IDs de invocação.

O `timestamp` do wide event é o **início** da invocação. As linhas imediatas têm o horário em que foram escritas e `elapsed_ms` desde o início.

## Timeout da Lambda

Quando a Lambda estoura o timeout, o processo é encerrado e o código depois do handler não roda. Para não perder a invocação, a lib agenda a gravação do wide event `timeoutMarginMs` (default 500 ms) antes do fim, usando `context.getRemainingTimeInMillis()`. O evento sai com `outcome: "timeout"`, nível `error`, `error.type: "LambdaTimeoutError"` e todos os campos acumulados até aquele momento. Se o handler terminar depois disso, o evento não é gravado de novo. Use `timeoutMarginMs: 0` para desligar.

## Tail sampling

A decisão é tomada depois da invocação:

1. `error` → sempre mantém
2. lenta (`> slowThresholdMs`) → sempre mantém
3. `warn` → sempre mantém
4. regra `keep(event)` retornou `true` ou um motivo → mantém
5. o restante é mantido com probabilidade `sampleRate`

O campo `sampling: { rate, reason }` informa por que o evento foi mantido. Se você precisar de contagens absolutas, divida pela `rate`.

## Configuração

| Opção | Env | Default |
|---|---|---|
| `service` | `SERVICE_NAME`, `AWS_LAMBDA_FUNCTION_NAME` | `unknown` |
| `version` | `SERVICE_VERSION`, `AWS_LAMBDA_FUNCTION_VERSION` | — |
| `environment` | `ENVIRONMENT`, `STAGE`, `NODE_ENV` | — |
| `level` (filtra linhas imediatas) | `LOG_LEVEL`, `AWS_LAMBDA_LOG_LEVEL` | `info` |
| `correlationHeader` | | `x-correlation-id` |
| `sampleRate` | `LOG_SAMPLE_RATE` | `1` |
| `slowThresholdMs` | | `3000` |
| `keep` | | — |
| `flushDebugOnError` | | `true` |
| `redactKeys` / `redactDefaults` | | `[]` / `true` |
| `includeStack` | | `true` |
| `maxLogs` (buffer de debug-on-error) | | `100` |
| `timeoutMarginMs` | | `500` |
| `maxStringLength` | | `8192` |
| `maxEventBytes` | | `200000` |
| `autoEnrich` | | `true` |
| `staticFields` | | — |
| `transport` (adaptado como destino do pino) | | stdout síncrono |
| `traceContext` | | — |

Se o evento passar de `maxEventBytes` (o limite do CloudWatch é 256 KB), o `logs[]` é descartado e o evento recebe `truncated: true`.

## Pino

Todas as linhas são escritas por uma instância [pino](https://getpino.io) criada pela lib, com destino **síncrono** em stdout (não perde linhas quando a Lambda congela). O pino não filtra nível: `LOG_LEVEL` e o sampling continuam sendo decididos pela lib. A redação de dados sensíveis também continua na lib, antes de chegar ao pino.

A instância fica disponível em `logger.pino`, caso alguma lib de terceiros precise de um logger pino:

```ts
const sdkLogger = logger.pino.child({ component: 'aws-sdk' });
```

`transport` continua aceito (testes, destinos customizados): ele recebe cada linha já serializada pelo pino.

## Dynatrace

A saída é JSON de uma linha, então funciona tanto com o **OneAgent/extensão Lambda** (que lê stdout) quanto com o **CloudWatch → Dynatrace** (log forwarder/Firehose). Campos pensados para o Dynatrace:

| Campo | Para quê |
|---|---|
| `level` em texto (`info`, `warn`, `error`...) | Vira o `loglevel`/`status` da linha (nível numérico do pino padrão não seria reconhecido) |
| `message` | Conteúdo exibido na lista de logs. O wide event recebe um resumo, ex.: `POST /cotacoes 201 success 27ms` ou `sqs fila-sinistros error 120ms` |
| `timestamp` (ISO) | Horário da linha |
| `service.name`, `service.version`, `deployment.environment` | Atributos semânticos que ligam a linha ao serviço (espelham `service`, `version`, `environment`) |
| `dt.trace_id`, `dt.span_id` | Ligação log ↔ trace, quando `traceContext` está configurado |

### Ligando logs aos traces

Com OneAgent ou OpenTelemetry ativo, informe o span atual:

```ts
import { trace } from '@opentelemetry/api';

const logger = createLogger({
  traceContext: () => {
    const ctx = trace.getActiveSpan()?.spanContext();
    return ctx && { trace_id: ctx.traceId, span_id: ctx.spanId };
  },
});
```

Se a função lançar erro ou retornar `undefined`, os campos `dt.*` são omitidos. O `trace_id` do X-Ray continua sendo gravado normalmente.

### Consultas DQL

```
fetch logs
| filter log_type == "wide_event" and loglevel == "ERROR"
| fields timestamp, service.name, content, http.route, error.type
| sort timestamp desc
```

```
fetch logs
| filter correlation_id == "cotacao-7f3a"
| sort timestamp asc
```

## Consultas no CloudWatch Logs Insights

Tudo de uma invocação (linhas imediatas + wide event), em ordem:

```
fields @timestamp, log_type, level, message, elapsed_ms
| filter request_id = "c0ffee-1"
| sort @timestamp asc
```

Um processo inteiro passando por várias Lambdas (consulte os log groups de todas):

```
fields @timestamp, service, log_type, level, message
| filter correlation_id = "cotacao-7f3a"
| sort @timestamp asc
```

```
fields @timestamp, http.route, http.status_code, duration_ms, error.type
| filter log_type = "wide_event" and level = "error"
| sort @timestamp desc
```

```
filter log_type = "wide_event"
| stats pct(duration_ms, 99) as p99, count(*) as n by http.route, lambda.cold_start
```

## Desenvolvimento

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build       # dist/ (ESM + CJS + d.ts)
npm run example:api
npm run example:sqs
```
