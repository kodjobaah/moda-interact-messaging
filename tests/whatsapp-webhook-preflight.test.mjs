import assert from "node:assert/strict";
import { test } from "node:test";

import { preflightWhatsAppWebhook } from "../app/lib/whatsapp/webhook-preflight.ts";

const timestamp = "1788144000";
const textMessage = (id, body = "Hello") => ({
  id, from: "15555550123", timestamp, type: "text", text: { body },
});
const change = (value) => ({ field: "messages", value });
const value = (messages, statuses) => ({
  metadata: { phone_number_id: "phone-1" }, messages, statuses,
});

function batch(...changes) {
  return { entry: [{ id: "waba-1", changes }] };
}

test("preflights all canonical inbound v1 and status v3 events in original order", () => {
  const result = preflightWhatsAppWebhook(batch(
    { field: "account_update", value: "ignored" },
    change(value(
      [textMessage("in-1"), textMessage("in-2")],
      [
        { id: "out-1", status: "failed", timestamp, errors: [{ code: " 131026 " }] },
        { id: "out-2", status: "read", timestamp },
      ],
    )),
    change(value([], [{ id: "out-3", status: "sent", timestamp }])),
  ));

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.events.map(({ kind, event }) => [kind, event.providerMessageId]), [
    ["inbound", "in-1"],
    ["inbound", "in-2"],
    ["status", "out-1"],
    ["status", "out-2"],
    ["status", "out-3"],
  ]);
  assert.deepEqual(result.events.map(({ event }) => event.schemaVersion), [1, 1, 3, 3, 3]);
  assert.deepEqual(result.events[2].event.failure, { providerCode: "131026" });
  assert.equal("errors" in result.events[2].event, false);
});

test("rejects invalid envelope shapes while retaining no-op and extra-field cases", () => {
  const invalid = [
    null, [], 12, "text", {}, { entry: null }, { entry: {} },
    { entry: [null] }, { entry: [[]] }, { entry: [{ changes: 3 }] },
    { entry: [{ changes: [null] }] }, { entry: [{ changes: [[]] }] },
    batch(change(null)), batch(change([])),
    batch(change({ messages: {} })),
    batch(change({ statuses: {} })),
    batch(change({ messages: [textMessage("invalid", "")] })),
  ];
  for (const input of invalid) {
    assert.deepEqual(preflightWhatsAppWebhook(input), { valid: false });
  }

  const accepted = [
    { entry: [] },
    { entry: [{ changes: null }] },
    { entry: [{ }] },
    batch({ field: "templates", value: null }),
    batch(change({ metadata: { phone_number_id: "phone-1" } })),
    batch(change({ messages: null, statuses: null, additional: "allowed" })),
  ];
  for (const input of accepted) {
    assert.deepEqual(preflightWhatsAppWebhook(input), { valid: true, events: [] });
  }
});

test("ignores malformed individual provider statuses without rejecting valid inbound", () => {
  const result = preflightWhatsAppWebhook(batch(change(value(
    [textMessage("in-1")],
    [null, { status: "sent", timestamp }, { id: "out-invalid", status: "queued", timestamp },
      { id: "out-1", status: "delivered", timestamp }],
  ))));

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.events.map(({ event }) => event.providerMessageId), ["in-1", "out-1"]);
});

test("invalid late inbound discards staged messages and statuses, including prior entry", () => {
  const input = {
    entry: [
      { id: "waba-1", changes: [change(value(
        [textMessage("in-1")], [{ id: "out-1", status: "read", timestamp }],
      ))] },
      { id: "waba-2", changes: [change(value([textMessage("in-2", "")], []))] },
    ],
  };
  assert.deepEqual(preflightWhatsAppWebhook(input), { valid: false });
});
