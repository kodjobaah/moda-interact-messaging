import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchWhatsAppWebhook } from "../app/lib/whatsapp/webhook-dispatch.server.ts";

const timestamp = "1788144000";

function textMessage(id, body = "Hello") {
  return {
    id,
    from: "15555550123",
    type: "text",
    timestamp,
    text: { body },
  };
}

function providerStatus(id, status, errors) {
  return { id, status, timestamp, ...(errors ? { errors } : {}) };
}

function messagesChange(messages = [], statuses = []) {
  return {
    field: "messages",
    value: {
      metadata: { phone_number_id: "phone-1" },
      messages,
      statuses,
    },
  };
}

function fakePublishers() {
  const observed = [];
  return {
    observed,
    publishers: {
      async enqueueInboundMessage(event) {
        observed.push({ job: "message-received", event });
      },
      async enqueueProviderStatus(event) {
        observed.push({ job: "message-status", event });
      },
    },
  };
}

test("preserves nested entry/change traversal, messages-first order and v3 FAILED evidence", async () => {
  const { observed, publishers } = fakePublishers();
  const payload = {
    entry: [
      {
        id: "waba-1",
        changes: [
          { field: "account_update", value: { ignored: true } },
          messagesChange(
            [textMessage("in-1"), textMessage("in-2")],
            [providerStatus("out-1", "delivered"), providerStatus("out-2", "failed", [{ code: 131026 }])],
          ),
          messagesChange([], [providerStatus("out-3", "read")]),
        ],
      },
      {
        id: "waba-2",
        changes: [messagesChange([textMessage("in-3")], [providerStatus("out-4", "sent")])],
      },
    ],
  };

  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "accepted");
  assert.deepEqual(observed.map(({ job, event }) => [job, event.providerMessageId]), [
    ["message-received", "in-1"],
    ["message-received", "in-2"],
    ["message-status", "out-1"],
    ["message-status", "out-2"],
    ["message-status", "out-3"],
    ["message-received", "in-3"],
    ["message-status", "out-4"],
  ]);
  assert.equal(observed[0].event.schemaVersion, 1);
  assert.deepEqual(observed[0].event.content, { type: "text", text: "Hello" });
  assert.equal(observed[3].event.schemaVersion, 3);
  assert.equal(observed[3].event.status, "FAILED");
  assert.deepEqual(observed[3].event.failure, { providerCode: "131026" });
  assert.equal(observed[5].event.providerAccountId, "waba-2");
});

test("silently skips malformed statuses and ignores unrelated changes", async () => {
  const { observed, publishers } = fakePublishers();
  const payload = {
    entry: [{
      id: "waba-1",
      changes: [
        { field: "templates", value: null },
        messagesChange([], [
          { status: "delivered", timestamp },
          providerStatus("out-valid", "sent"),
          providerStatus("out-unsupported", "queued"),
        ]),
      ],
    }],
  };
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "accepted");
  assert.deepEqual(observed.map(({ event }) => event.providerMessageId), ["out-valid"]);
  assert.equal(await dispatchWhatsAppWebhook({ entry: [] }, publishers), "accepted");
  assert.equal(await dispatchWhatsAppWebhook({}, publishers), "invalid_payload");
  assert.equal(observed.length, 1);
});

test("rejects a late invalid inbound before publishing any events", async () => {
  const { observed, publishers } = fakePublishers();
  const payload = {
    entry: [{
      id: "waba-1",
      changes: [
        messagesChange([textMessage("in-1")], [providerStatus("out-1", "read")]),
        messagesChange([textMessage("in-2", "")], [providerStatus("out-2", "sent")]),
      ],
    }],
  };

  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "invalid_payload");
  assert.deepEqual(observed, []);
});

test("propagates publisher errors and never advances past a failed job", async () => {
  const failure = new Error("synthetic queue failure");
  const observed = [];
  const publishers = {
    async enqueueInboundMessage(event) {
      observed.push(event.providerMessageId);
      throw failure;
    },
    async enqueueProviderStatus(event) {
      observed.push(event.providerMessageId);
    },
  };
  const payload = {
    entry: [{ id: "waba-1", changes: [messagesChange([textMessage("in-1")], [providerStatus("out-1", "sent")])] }],
  };

  await assert.rejects(dispatchWhatsAppWebhook(payload, publishers), (error) => error === failure);
  assert.deepEqual(observed, ["in-1"]);
});

test("returns invalid_payload for malformed signed envelopes", async () => {
  const { publishers } = fakePublishers();
  assert.equal(await dispatchWhatsAppWebhook({ entry: 42 }, publishers), "invalid_payload");
  assert.equal(await dispatchWhatsAppWebhook(null, publishers), "invalid_payload");
  assert.equal(await dispatchWhatsAppWebhook({ entry: [{ changes: [{ field: "messages", value: null }] }] }, publishers), "invalid_payload");
});
