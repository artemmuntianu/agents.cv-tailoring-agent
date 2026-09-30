import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';

/**
 * The gateway side of the `resumes.generate` queue: one message per vacancy, exactly
 * the payload `agent/contracts.py::ResumeTaskMessage` validates.
 *
 * The topology is *mirrored* from `utils/messaging.py::AmqpQueue._declare_topology`
 * (durable queue, direct DLX, DLQ binding, the TTL retry ladder). RabbitMQ rejects a
 * redeclare with different arguments with a 406, so the three declarers - the chart's
 * definitions, the Python consumer and this publisher - must agree field for field.
 */
const RETRY_LADDER_SECONDS = [60, 300, 900, 1800, 3600];

export function queueName(): string {
  return process.env.QUEUE_NAME?.trim() || 'resumes.generate';
}

export function deadLetterExchange(): string {
  return process.env.QUEUE_DLX?.trim() || `${queueName()}.dlx`;
}

export function deadLetterQueue(): string {
  return process.env.QUEUE_DLQ?.trim() || `${queueName()}.dlq`;
}

/**
 * `resumes.cover` - the on-demand cover-letter queue (`config.py` is the reference for the
 * names). It is a *separate* queue on purpose: a letter neither waits behind a tailoring
 * backlog nor wakes the tailoring workers, because each queue has its own ScaledObject on the
 * cluster side.
 */
export function coverQueueName(): string {
  return process.env.COVER_QUEUE_NAME?.trim() || 'resumes.cover';
}

export function coverDeadLetterExchange(): string {
  return process.env.COVER_QUEUE_DLX?.trim() || `${coverQueueName()}.dlx`;
}

export function coverDeadLetterQueue(): string {
  return process.env.COVER_QUEUE_DLQ?.trim() || `${coverQueueName()}.dlq`;
}

/**
 * `applications.draft` - the extension's application-form queue (`apply.py`). Same naming rule as
 * the cover queue: `config.py` is the reference, and every declarer of the topology (this
 * publisher, the chart's definitions Secret, the worker's own spec) must agree field for field.
 */
export function applicationQueueName(): string {
  return process.env.APPLICATION_QUEUE_NAME?.trim() || 'applications.draft';
}

export function applicationDeadLetterExchange(): string {
  return process.env.APPLICATION_QUEUE_DLX?.trim() || `${applicationQueueName()}.dlx`;
}

export function applicationDeadLetterQueue(): string {
  return process.env.APPLICATION_QUEUE_DLQ?.trim() || `${applicationQueueName()}.dlq`;
}

/**
 * `resumes.rerender` - the hand-edited-deliverable queue (`rerender.py`). Same naming rule as the
 * other two: `config.py` is the reference, and every declarer of the topology (this publisher, the
 * chart's definitions Secret, the worker's own spec) must agree field for field.
 */
export function rerenderQueueName(): string {
  return process.env.RERENDER_QUEUE_NAME?.trim() || 'resumes.rerender';
}

export function rerenderDeadLetterExchange(): string {
  return process.env.RERENDER_QUEUE_DLX?.trim() || `${rerenderQueueName()}.dlx`;
}

export function rerenderDeadLetterQueue(): string {
  return process.env.RERENDER_QUEUE_DLQ?.trim() || `${rerenderQueueName()}.dlq`;
}

/** Every queue this client publishes to, declared on connect. */
export function queueTopology(): { queue: string; dlx: string; dlq: string }[] {
  return [
    { queue: queueName(), dlx: deadLetterExchange(), dlq: deadLetterQueue() },
    { queue: coverQueueName(), dlx: coverDeadLetterExchange(), dlq: coverDeadLetterQueue() },
    {
      queue: applicationQueueName(),
      dlx: applicationDeadLetterExchange(),
      dlq: applicationDeadLetterQueue(),
    },
    {
      queue: rerenderQueueName(),
      dlx: rerenderDeadLetterExchange(),
      dlq: rerenderDeadLetterQueue(),
    },
  ];
}

export function cvVersion(): string {
  return process.env.CV_VERSION?.trim() || 'v1';
}

function brokerUrl(): string {
  const explicit = process.env.RABBITMQ_URL?.trim();
  if (explicit) return explicit;

  // Same inputs as config.py: components, so the in-cluster Secret keys can be
  // injected directly without composing a URL in a script.
  const username = process.env.RABBITMQ_USERNAME?.trim() || 'guest';
  const password = process.env.RABBITMQ_PASSWORD ?? '';
  if (!password) {
    throw new Error(
      'RABBITMQ_URL (or RABBITMQ_USERNAME/RABBITMQ_PASSWORD) is not set - the gateway ' +
        'publishes to the cluster broker, e.g. ' +
        'amqp://cvt:<password>@localhost:5672/%2F after ' +
        '`kubectl port-forward svc/rabbitmq 5672:5672`.',
    );
  }
  const host = process.env.RABBITMQ_HOST?.trim() || 'localhost';
  const port = process.env.RABBITMQ_PORT?.trim() || '5672';
  const vhost = process.env.RABBITMQ_VHOST?.trim() || '/';
  return (
    `amqp://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${vhost === '/' ? '%2F' : encodeURIComponent(vhost)}`
  );
}

export function brokerDescription(): string {
  try {
    const url = new URL(brokerUrl().replace(/^amqp/, 'http'));
    return `${url.hostname}:${url.port || '5672'}`;
  } catch {
    return 'unconfigured';
  }
}

interface QueueClient {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

// One client per process, surviving Astro/Vite dev reloads.
const globals = globalThis as unknown as { __cvTailoringQueue?: Promise<QueueClient> };

/**
 * Declare one queue's topology. The names are passed in, so the same code serves the
 * tailoring queue and the cover-letter one - and it has to match every other declarer
 * (the chart's definitions Secret, `utils/messaging.py`), or RabbitMQ answers 406.
 */
async function declareTopology(
  channel: ConfirmChannel,
  names: { queue: string; dlx: string; dlq: string },
): Promise<void> {
  const { queue, dlx, dlq } = names;

  await channel.assertExchange(dlx, 'direct', { durable: true });
  await channel.assertQueue(dlq, { durable: true });
  await channel.bindQueue(dlq, dlx, dlq);

  for (const seconds of RETRY_LADDER_SECONDS) {
    await channel.assertQueue(`${queue}.retry.${seconds}s`, {
      durable: true,
      arguments: {
        'x-message-ttl': seconds * 1000,
        // Back through the default exchange, i.e. straight to the main queue.
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
      },
    });
  }

  await channel.assertQueue(queue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': dlx, 'x-dead-letter-routing-key': dlq },
  });
}

async function client(): Promise<QueueClient> {
  const cached = globals.__cvTailoringQueue;
  if (cached) {
    const resolved = await cached.catch(() => undefined);
    if (resolved) return resolved;
  }

  const pending = (async (): Promise<QueueClient> => {
    const connection = await amqp.connect(brokerUrl(), {
      heartbeat: 600, // matches AMQP_HEARTBEAT_SECONDS
      clientProperties: { connection_name: 'cv-tailoring-backoffice' },
    });
    connection.on('error', () => {
      globals.__cvTailoringQueue = undefined;
    });
    connection.on('close', () => {
      globals.__cvTailoringQueue = undefined;
    });
    const channel = await connection.createConfirmChannel();
    for (const names of queueTopology()) await declareTopology(channel, names);
    return { connection, channel };
  })();

  globals.__cvTailoringQueue = pending;
  try {
    return await pending;
  } catch (error) {
    globals.__cvTailoringQueue = undefined;
    throw error;
  }
}

/** Publish one message per task, then wait for the broker's confirms. */
export async function publishResumeTasks(messages: Record<string, unknown>[]): Promise<number> {
  return publish(queueName(), messages);
}

/**
 * Publish cover-letter requests (the modal's *Generate* button).
 *
 * Same confirm semantics as a tailoring message: the route must not tell the operator a letter
 * is on its way before the broker acknowledged the publish.
 */
export async function publishCoverRequests(
  messages: Record<string, unknown>[],
): Promise<number> {
  return publish(coverQueueName(), messages);
}

/**
 * Publish one application-draft request (the extension's *Populate* button).
 *
 * Same confirm semantics as the other two: the route must not tell the operator a draft is on its
 * way before the broker acknowledged the publish.
 */
export async function publishApplicationRequests(
  messages: Record<string, unknown>[],
): Promise<number> {
  return publish(applicationQueueName(), messages);
}

/**
 * Publish one hand-edited-deliverable request (the modal's *Update docx* button).
 *
 * Same confirm semantics again: the route must not tell the operator a render is on its way before
 * the broker acknowledged the publish - and the bytes live in the database row, so the message
 * itself stays readable in the RabbitMQ UI.
 */
export async function publishRerenderRequests(
  messages: Record<string, unknown>[],
): Promise<number> {
  return publish(rerenderQueueName(), messages);
}

async function publish(queue: string, messages: Record<string, unknown>[]): Promise<number> {
  const { channel } = await client();
  for (const message of messages) {
    channel.publish('', queue, Buffer.from(JSON.stringify(message), 'utf8'), {
      contentType: 'application/json',
      deliveryMode: 2, // persistent
    });
  }
  await channel.waitForConfirms();
  return messages.length;
}

/** Ready messages in the main queue (what KEDA scales on is ready+unacked). */
export async function queueDepth(): Promise<number | null> {
  try {
    const { channel } = await client();
    const info = await channel.checkQueue(queueName());
    return info.messageCount;
  } catch {
    return null;
  }
}

/** Test/dev hook: drop the cached connection. */
export async function closeQueue(): Promise<void> {
  const cached = globals.__cvTailoringQueue;
  globals.__cvTailoringQueue = undefined;
  if (!cached) return;
  const resolved = await cached.catch(() => undefined);
  await resolved?.connection.close().catch(() => undefined);
}
