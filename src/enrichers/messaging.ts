type AnyRecord = Record<string, any>;

const MAX_IDS = 10;

function arnName(arn: unknown): string | undefined {
  return typeof arn === 'string' ? arn.split(':').pop() : undefined;
}

function firstRecord(event: AnyRecord): AnyRecord | undefined {
  return Array.isArray(event.Records) ? event.Records[0] : undefined;
}

export function isSqs(event: AnyRecord): boolean {
  return firstRecord(event)?.eventSource === 'aws:sqs';
}

export function isSns(event: AnyRecord): boolean {
  return firstRecord(event)?.EventSource === 'aws:sns';
}

export function isEventBridge(event: AnyRecord): boolean {
  return typeof event['detail-type'] === 'string' && typeof event.source === 'string';
}

export function enrichSqs(event: AnyRecord): Record<string, unknown> {
  const records: AnyRecord[] = event.Records;
  let maxReceiveCount = 0;
  for (const record of records) {
    const count = Number(record.attributes?.ApproximateReceiveCount);
    if (count > maxReceiveCount) maxReceiveCount = count;
  }
  return {
    trigger: {
      type: 'sqs',
      queue: arnName(records[0]?.eventSourceARN),
      record_count: records.length,
      message_ids: records.slice(0, MAX_IDS).map((r) => r.messageId),
      max_receive_count: maxReceiveCount || undefined,
    },
  };
}

export function enrichSns(event: AnyRecord): Record<string, unknown> {
  const records: AnyRecord[] = event.Records;
  return {
    trigger: {
      type: 'sns',
      topic: arnName(records[0]?.Sns?.TopicArn),
      record_count: records.length,
      message_ids: records.slice(0, MAX_IDS).map((r) => r.Sns?.MessageId),
    },
  };
}

export function enrichEventBridge(event: AnyRecord): Record<string, unknown> {
  return {
    trigger: {
      type: 'eventbridge',
      source: event.source,
      detail_type: event['detail-type'],
      event_id: event.id,
      event_time: event.time,
      resources_count: Array.isArray(event.resources) ? event.resources.length : undefined,
    },
  };
}

/** Lê `batchItemFailures` (partial batch response) do retorno de handlers SQS. */
export function batchResultFields(result: unknown): Record<string, unknown> {
  const failures = (result as AnyRecord | undefined)?.batchItemFailures;
  if (!Array.isArray(failures)) return {};
  return {
    trigger: {
      failed_count: failures.length,
      failed_ids: failures.slice(0, MAX_IDS).map((f: AnyRecord) => f.itemIdentifier),
    },
  };
}
