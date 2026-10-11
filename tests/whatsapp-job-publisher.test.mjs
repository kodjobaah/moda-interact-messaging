import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createJobId, createStatusJobId } from "../app/lib/whatsapp/job-identity.server.ts";
import {
  enqueueInboundMessage,
  enqueueProviderStatus,
} from "../app/lib/whatsapp/whatsapp-job-publisher.server.ts";

const inbound = {
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "waba-1",
  providerPhoneNumberId: "phone-1",
  providerMessageId: "wamid-inbound",
  customerPhone: "15555550123",
  contextMessageId: null,
  occurredAt: "2026-08-31T02:40:00.000Z",
  content: { type: "text", text: "Hello" },
};

const delivered = {
  schemaVersion: 3,
  providerAccountId: "waba-1",
  providerPhoneNumberId: "phone-1",
  providerMessageId: "wamid-outbound",
  status: "DELIVERED",
  occurredAt: "2026-08-31T02:40:00.000Z",
};

const failed = {
  ...delivered,
  status: "FAILED",
  failure: { providerCode: "131026" },
};

function recordingQueue() {
  const calls = [];
  return {
    calls,
    async add(name, data, options) {
      calls.push({ name, data, options });
      return { id: options.jobId };
    },
  };
}

test("publishes one inbound v1 job with unchanged payload, ID and retry options", async () => {
  const queue = recordingQueue();
  await enqueueInboundMessage(inbound, queue);

  assert.equal(queue.calls.length, 1);
  const [job] = queue.calls;
  assert.equal(job.name, "message-received");
  assert.strictEqual(job.data, inbound);
  assert.deepEqual(job.options, {
    jobId: createJobId(inbound.providerMessageId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  });
  assert.equal(
    job.options.jobId,
    "wa-" + createHash("sha256").update("wamid-inbound").digest("hex"),
  );
});

test("publishes one provider-status job with unchanged payload, ID and retry options", async () => {
  const queue = recordingQueue();
  await enqueueProviderStatus(delivered, queue);

  assert.equal(queue.calls.length, 1);
  const [job] = queue.calls;
  assert.equal(job.name, "message-status");
  assert.strictEqual(job.data, delivered);
  assert.deepEqual(job.options, {
    jobId: createStatusJobId(delivered),
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  });
  assert.equal(
    job.options.jobId,
    "ws-" + createHash("sha256")
      .update("waba-1:phone-1:wamid-outbound:DELIVERED")
      .digest("hex").slice(0, 61),
  );
});

test("keeps FAILED v3 evidence job identity distinct and replay-stable", async () => {
  const withoutEvidence = { ...failed };
  delete withoutEvidence.failure;
  const queue = recordingQueue();
  await enqueueProviderStatus(withoutEvidence, queue);
  await enqueueProviderStatus(failed, queue);
  await enqueueProviderStatus({ ...failed }, queue);

  const ids = queue.calls.map(({ options }) => options.jobId);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.equal(ids[1],
    "ws-" + createHash("sha256")
      .update("waba-1:phone-1:wamid-outbound:FAILED:failure:131026")
      .digest("hex").slice(0, 61));
  assert.ok(ids.every((id) => id.length <= 64));
  assert.equal(createStatusJobId({ ...withoutEvidence, schemaVersion: 2 }), ids[0]);
  assert.deepEqual(queue.calls.map(({ name }) => name), ["message-status", "message-status", "message-status"]);
});

test("uses the provided queue without constructing Redis and preserves publish order", async () => {
  const queue = recordingQueue();
  await enqueueInboundMessage(inbound, queue);
  await enqueueProviderStatus(delivered, queue);
  assert.deepEqual(queue.calls.map(({ name }) => name), ["message-received", "message-status"]);
});

test("propagates inbound and status queue failures unchanged", async () => {
  const failure = new Error("queue unavailable");
  const queue = { async add() { throw failure; } };

  await assert.rejects(enqueueInboundMessage(inbound, queue), (error) => error === failure);
  await assert.rejects(enqueueProviderStatus(delivered, queue), (error) => error === failure);
});

test("does not acknowledge a publisher call until BullMQ completes it", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const queue = { add: () => pending };
  let completed = false;

  const publication = enqueueProviderStatus(delivered, queue).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  finish({ id: "queued" });
  await publication;
  assert.equal(completed, true);
});
