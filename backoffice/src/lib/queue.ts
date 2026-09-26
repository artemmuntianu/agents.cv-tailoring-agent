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

async function declareTopology(channel: ConfirmChannel): Promise<void> {
  const queue = queueName();
  const dlx = deadLetterExchange();
  const dlq = deadLetterQueue();

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
    await declareTopology(channel);
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
  const { channel } = await client();
  const queue = queueName();
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
