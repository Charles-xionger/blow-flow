import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
import amqp from 'amqplib';
import { GoAgentRequestError, GoAgentRunClient } from '../lib/agent/go-runner-client';
import { runGoAgentTask } from '../lib/agent/go-runner-host';

const baseURL = process.env.GO_API_URL;
const rabbitURL = process.env.RABBITMQ_URL;
const runnerKey = process.env.AGENT_RUNNER_KEY;
if (!baseURL || !rabbitURL || !runnerKey) throw new Error('GO_API_URL, RABBITMQ_URL and AGENT_RUNNER_KEY required');

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const client = new GoAgentRunClient(baseURL, runnerKey);

async function main() {
  const connection = await amqp.connect(rabbitURL!);
  const channel = await connection.createChannel();
  const active = new Set<Promise<void>>();
  let available = 8;
  const waiters: (() => void)[] = [];
  const acquire = async () => { if (available > 0) { available--; return; } await new Promise<void>(resolve => waiters.push(resolve)); };
  const release = () => { const next = waiters.shift(); if (next) next(); else available++; };
  try {
    await channel.assertQueue('agent.tasks.v1', { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await channel.prefetch(8);
    const { consumerTag } = await channel.consume('agent.tasks.v1', message => {
      if (!message) return;
      const job = (async () => {
        await acquire();
        let acknowledged = false;
        try {
          await runGoAgentTask(client, message.content.toString('utf8'), controller.signal, () => {
            channel.ack(message);
            acknowledged = true;
          });
        } catch (error) {
          if (!acknowledged) {
            if (error instanceof GoAgentRequestError && [404, 409].includes(error.status)) channel.ack(message);
            else setTimeout(() => { try { channel.nack(message, false, true); } catch { /* Channel closed during shutdown. */ } }, 500);
          }
          console.error('[agent-go] task failed', error instanceof Error ? error.message : 'unknown error');
        } finally { release(); }
      })().finally(() => active.delete(job));
      active.add(job);
    }, { noAck: false });
    await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    await channel.cancel(consumerTag);
    await Promise.all(active);
  } finally {
    await channel.close();
    await connection.close();
  }
}
main().catch(error => { console.error('[agent-go] worker stopped', error); process.exitCode = 1; });
