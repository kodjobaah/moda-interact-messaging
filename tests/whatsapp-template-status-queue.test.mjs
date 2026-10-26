import assert from "node:assert/strict";
import { test } from "node:test";

import fixture from "@modainteract/moda-interact-shared/whatsapp-template-events/fixtures" with { type: "json" };
import {
  META_TEMPLATE_STATUS_QUEUE,
  META_TEMPLATE_STATUS_JOB,
  formatMetaTemplateStatusJobId,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";
import { enqueueTemplateStatus } from "../app/lib/whatsapp/whatsapp-job-publisher.server.ts";
import { createTemplateStatusObservation } from "../app/lib/whatsapp/template-status-observation-id.server.ts";

function recorder() {
  const calls = [];
  return { calls, async add(name, data, options) { calls.push({ name, data, options }); return { id: options.jobId }; } };
}

test("uses existing queue name and Shared v2 fixture with five exponential retries", async () => {
  const queue = recorder();
  await enqueueTemplateStatus(fixture.observation, queue);
  assert.equal(META_TEMPLATE_STATUS_QUEUE, "whatsapp-events");
  assert.equal(META_TEMPLATE_STATUS_JOB, "meta-template-status-update");
  assert.equal(queue.calls.length, 1);
  assert.deepEqual(queue.calls[0], {
    name: META_TEMPLATE_STATUS_JOB,
    data: fixture.observation,
    options: { jobId: fixture.expectedJobId, attempts: 5, backoff: { type: "exponential", delay: 5000 } },
  });
  assert.equal(formatMetaTemplateStatusJobId("550e8400-e29b-41d4-a716-446655440000"), fixture.expectedJobId);
});

test("rejects malformed direct publisher payloads before invoking BullMQ", async () => {
  const queue = recorder();
  await assert.rejects(enqueueTemplateStatus({ ...fixture.observation, bogus: "raw" }, queue));
  await assert.rejects(enqueueTemplateStatus({ ...fixture.observation, receivedAt: "not a date" }, queue));
  assert.deepEqual(queue.calls, []);
});

test("refuses a resolved queue operation with no matching durable job identity", async () => {
  await assert.rejects(enqueueTemplateStatus(fixture.observation, { add: async () => undefined }), /not accepted/);
  await assert.rejects(enqueueTemplateStatus(fixture.observation, { add: async () => ({ id: "other" }) }), /not accepted/);
});

test("does not resolve an enqueued observation before the queue accepts it", async () => {
  let accept;
  const pending = new Promise((resolve) => { accept = resolve; });
  let acknowledged = false;
  const enqueuing = enqueueTemplateStatus(fixture.observation, { add: () => pending })
    .then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  accept({ id: fixture.expectedJobId });
  await enqueuing;
  assert.equal(acknowledged, true);
});

test("independently observed identical Meta values cannot share BullMQ job identity", async () => {
  const queue = recorder();
  const { eventIdentity: _identity, ...fields } = fixture.observation;
  const first = createTemplateStatusObservation(fields);
  const second = createTemplateStatusObservation(fields);
  await enqueueTemplateStatus(first, queue);
  await enqueueTemplateStatus(second, queue);
  assert.equal(queue.calls.length, 2);
  assert.notEqual(queue.calls[0].options.jobId, queue.calls[1].options.jobId);
  assert.deepEqual(queue.calls.map((call) => call.data.providerStatus), ["APPROVED", "APPROVED"]);
});

// This file remains fast and non-networked in npm test. The repository-owned
// disposable Docker script provides TEST_REDIS_URL for the actual queue test.
test("completed retained job does not swallow a separately observed identical status", { skip: !process.env.TEST_REDIS_URL }, async () => {
  const { Worker, QueueEvents } = await import("bullmq");
  const { getWhatsAppQueue } = await import("../app/lib/queues/whatsapp.queue.ts");
  const { getRedis } = await import("../app/lib/redis/redis.ts");
  const url = process.env.TEST_REDIS_URL;
  // A test variable alone is not permission to write to a shared Redis host.
  assert.ok(["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname),
    "Redis integration requires a disposable loopback endpoint");
  process.env.REDIS_URL = url;
  const completed = [];
  const events = new QueueEvents(META_TEMPLATE_STATUS_QUEUE, { connection: { url, maxRetriesPerRequest: null } });
  const worker = new Worker(META_TEMPLATE_STATUS_QUEUE, async (job) => {
    completed.push(job.id);
    return "processed";
  }, { connection: { url, maxRetriesPerRequest: null } });

  try {
    await events.waitUntilReady();
    await worker.waitUntilReady();
    const { eventIdentity: _identity, ...fields } = fixture.observation;
    const first = createTemplateStatusObservation(fields);
    const second = createTemplateStatusObservation(fields);
    const queue = getWhatsAppQueue();
    await enqueueTemplateStatus(first, queue);
    const firstId = formatMetaTemplateStatusJobId(first.eventIdentity.split(":")[2]);
    const firstJob = await queue.getJob(firstId);
    assert.ok(firstJob);
    await firstJob.waitUntilFinished(events);
    // The first completed job remains retained by existing queue policy.
    assert.ok(await queue.getJob(firstId));
    await enqueueTemplateStatus(second, queue);
    const secondId = formatMetaTemplateStatusJobId(second.eventIdentity.split(":")[2]);
    const secondJob = await queue.getJob(secondId);
    assert.ok(secondJob);
    await secondJob.waitUntilFinished(events);
    assert.notEqual(firstId, secondId);
    assert.ok(completed.includes(firstId));
    assert.ok(completed.includes(secondId));
    assert.ok(await queue.getJob(firstId));
  } finally {
    await worker.close();
    await events.close();
    await getWhatsAppQueue().close();
    await getRedis().quit();
    delete process.env.REDIS_URL;
  }
});
