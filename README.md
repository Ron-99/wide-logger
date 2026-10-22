# @mapfre/wide-logger

Logger para AWS Lambda no padrão **wide event** (canonical log line), baseado em [loggingsucks.com](https://loggingsucks.com/).

Em vez de várias linhas soltas (`"iniciando"`, `"buscou usuário"`, `"pagamento falhou"`), cada invocação produz **um único evento JSON rico em contexto**, enriquecido ao longo da execução e emitido **uma vez** no final. Assim, cada linha responde sozinha "o que aconteceu com essa requisição?" e pode ser consultada por qualquer campo no CloudWatch Logs Insights.

- Zero dependências de runtime, ESM + CJS, Node >= 18
- Log levels derivados do resultado da invocação
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
{"timestamp":"2026-10-22T15:25:27.475Z","level":"info","log_type":"wide_event","service":"cotacao-auto","version":"2.4.1","environment":"dev","request_id":"c0ffee...","trace_id":"1-5759e988-...","region":"sa-east-1","lambda":{"function_name":"cotacao-auto","memory_limit_mb":512,"cold_start":true,"remaining_time_ms":29000,"memory_used_mb":72},"trigger":{"type":"api_gateway_http"},"http":{"method":"POST","path":"/cotacoes","route":"POST /cotacoes","status_code":201},"user":{"id":"u_456","tier":"corporate"},"timings":{"motor_preco_ms":22},"quote":{"id":"cot_123","premium_cents":189900},"outcome":"success","duration_ms":27,"sampling":{"rate":0.05,"reason":"corporate_user"}}
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

## Log levels

Níveis: `debug < info < warn < error`, além de `silent`.

- **Nível do wide event é derivado do resultado**:
  - `error`: exceção lançada, `setError()`, `logger.error()` ou HTTP 5xx
  - `warn`: HTTP 4xx, duração acima de `slowThresholdMs`, `logger.warn()` ou falha parcial em batch SQS
  - `info`: nos demais casos
- **Nível mínimo** (`level` / `LOG_LEVEL`): eventos abaixo dele não são emitidos.
- `logger.debug/info/warn/error(msg, data)` **dentro** da invocação não geram linhas novas. As mensagens vão para o array `logs[]` do wide event, filtradas pelo nível mínimo.
- **Debug-on-error**: mensagens abaixo do nível mínimo ficam em buffer e entram no `logs[]` se a invocação terminar em `error`. Rode com `LOG_LEVEL=info` em produção e ainda veja o debug das falhas (`flushDebugOnError`).
- **Fora** de uma invocação (código de init), as mensagens são emitidas como linhas com `log_type: "log"`.

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
| `level` | `LOG_LEVEL`, `AWS_LAMBDA_LOG_LEVEL` | `info` |
| `sampleRate` | `LOG_SAMPLE_RATE` | `1` |
| `slowThresholdMs` | | `3000` |
| `keep` | | — |
| `flushDebugOnError` | | `true` |
| `redactKeys` / `redactDefaults` | | `[]` / `true` |
| `includeStack` | | `true` |
| `maxLogs` | | `100` |
| `maxStringLength` | | `8192` |
| `maxEventBytes` | | `200000` |
| `autoEnrich` | | `true` |
| `staticFields` | | — |
| `transport` | | `process.stdout` |

Se o evento passar de `maxEventBytes` (o limite do CloudWatch é 256 KB), o `logs[]` é descartado e o evento recebe `truncated: true`.

## Consultas no CloudWatch Logs Insights

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
