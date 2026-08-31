import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { Worker } from "bullmq";

const redisUrl = process.env.TEST_REDIS_URL;
const appSecret = "messaging-queue-telemetry-secret";
const workers = [];

test("uses one shared adapter through the native Queue telemetry option", () => {
  const queueSource = readFileSync(
    new URL("../app/lib/queues/whatsapp.queue.ts", import.meta.url),
    "utf8",
  );

  assert.equal(queueSource.match(/createBullMQTelemetry\(/g)?.length, 1);
  assert.equal(queueSource.match(/telemetry: bullMQTelemetry/g)?.length, 1);
  assert.doesNotMatch(queueSource, /\.prototype|traceparent|baggage/);
});

after(async () => {
  await Promise.allSettled(workers.map((worker) => worker.close()));

  if (redisUrl) {
    const { getWhatsAppQueue } = await import(
      "../app/lib/queues/whatsapp.queue.ts"
    );
    const { getRedis } = await import("../app/lib/redis/redis.ts");
    await getWhatsAppQueue().close();
    await getRedis().quit();
  }

  delete process.env.META_APP_SECRET;
  delete process.env.REDIS_URL;
  trace.disable();
  context.disable();
});

test(
  "continues the inbound request trace without changing the queue payload",
  { skip: !redisUrl },
  async () => {
    const spans = [];
    const exporter = {
      export(exportedSpans, callback) {
        spans.push(...exportedSpans);
        callback({ code: 0 });
      },
      shutdown: async () => {},
    };
    const traceProvider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    traceProvider.register();
    const contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);

    process.env.META_APP_SECRET = appSecret;
    process.env.REDIS_URL = redisUrl;

    const { action } = await import("../app/routes/whatsapp.tsx");
    const workerTelemetry = createBullMQTelemetry({
      serviceName: "moda-messaging-worker",
      enableMetrics: false,
    });
    const worker = new Worker(
      "whatsapp-events",
      async () => "processed",
      {
        connection: { url: redisUrl, maxRetriesPerRequest: null },
        telemetry: workerTelemetry,
      },
    );
    workers.push(worker);
    await worker.waitUntilReady();

    const firstPayload = createMetaPayload(`message-${process.pid}`);
    const firstProcessed = waitForCompletedJob(worker);
    let firstResponse;

    await trace
      .getTracer("moda-interact-messaging.whatsapp.ingress")
      .startActiveSpan("messaging.whatsapp.ingress.request", async (span) => {
        firstResponse = await action({
          request: createSignedRequest(firstPayload),
          params: {},
          context: {},
        });
        await firstProcessed;
        span.end();
      });

    await new Promise((resolve) => setImmediate(resolve));
    await traceProvider.forceFlush();

    assert.equal(firstResponse.status, 200);
    assert.deepEqual(await firstProcessed, expectedEvent(firstPayload));

    const relevantSpans = spans.filter((span) =>
      /messaging\.whatsapp\.ingress\.request|add whatsapp-events|process whatsapp-events/.test(
        span.name,
      ),
    );
    assert.ok(
      relevantSpans.some(
        (span) => span.name === "messaging.whatsapp.ingress.request",
      ),
    );
    assert.ok(
      relevantSpans.some((span) => span.name.startsWith("add whatsapp-events")),
    );
    assert.ok(
      relevantSpans.some((span) =>
        span.name.startsWith("process whatsapp-events"),
      ),
      `captured spans: ${spans.map((span) => span.name).join(", ")}`,
    );
    assert.equal(
      new Set(relevantSpans.map((span) => span.spanContext().traceId)).size,
      1,
    );

    await traceProvider.shutdown();
    await contextManager.disable();
    trace.disable();
    context.disable();

    const secondPayload = createMetaPayload(`message-disabled-${process.pid}`);
    const secondProcessed = waitForCompletedJob(worker);
    const secondResponse = await action({
      request: createSignedRequest(secondPayload),
      params: {},
      context: {},
    });

    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondProcessed, expectedEvent(secondPayload));
  },
);

function createMetaPayload(messageId) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-number-id" },
              messages: [
                {
                  id: messageId,
                  from: "15555550123",
                  timestamp: "1788144000",
                  type: "text",
                  text: { body: "Where is my order?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function createSignedRequest(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", appSecret)
    .update(body, "utf8")
    .digest("hex");

  return new Request("https://messaging.example/webhook/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

function expectedEvent(payload) {
  const value = payload.entry[0].changes[0].value;
  const message = value.messages[0];

  return {
    provider: "whatsapp",
    providerMessageId: message.id,
    phoneNumberId: value.metadata.phone_number_id,
    customerAddress: message.from,
    timestamp: Number(message.timestamp),
    type: "text",
    text: message.text.body,
  };
}

function waitForCompletedJob(worker) {
  return new Promise((resolve, reject) => {
    worker.once("completed", (job) => resolve(job.data));
    worker.once("failed", (_job, error) => reject(error));
  });
}