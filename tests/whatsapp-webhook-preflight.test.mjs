import assert from "node:assert/strict";
import { test } from "node:test";

import { preflightWhatsAppWebhook } from "../app/lib/whatsapp/webhook-preflight.ts";
import { dispatchWhatsAppWebhook } from "../app/lib/whatsapp/webhook-dispatch.server.ts";

const timestamp = "1788144000";
const message = (id, text = "hello") => ({
  id, from: "15555550123", type: "text", timestamp, text: { body: text },
});
const messages = (inbound = [], statuses = []) => ({
  field: "messages",
  value: { metadata: { phone_number_id: "phone-1" }, messages: inbound, statuses },
});
const payload = (changes) => ({ entry: [{ id: "waba-1", changes }] });

const publishers = (observed) => ({
  async enqueueInboundMessage(event) { observed.push(["inbound", event.providerMessageId]); },
  async enqueueProviderStatus(event) { observed.push(["status", event.providerMessageId]); },
  async enqueueTemplateStatus(event) { observed.push(["template", event.providerTemplateName]); },
});

test("preflight rejects invalid envelopes without side effects", async () => {
  for (const input of [null, {}, { entry: 3 }, { entry: [null] },
    { entry: [{ changes: 2 }] }, payload([null]), payload([messages("wrong")])]) {
    assert.equal(preflightWhatsAppWebhook(input).valid, false);
  }
  const observed = [];
  const invalid = payload([
    messages([message("first")], [{ id: "sent-1", status: "sent", timestamp }]),
    messages([message("invalid", "")]),
  ]);
  assert.equal(await dispatchWhatsAppWebhook(invalid, publishers(observed)), "invalid_payload");
  assert.deepEqual(observed, []);
});

test("preflight preserves message and status ordering and ignores malformed individual status", async () => {
  const input = payload([
    { field: "other", value: null },
    messages([message("a"), message("b")], [
      { status: "delivered", timestamp },
      { id: "c", status: "failed", timestamp, errors: [{ code: 131026 }] },
    ]),
    messages([message("d")]),
  ]);
  const observed = [];
  assert.equal(await dispatchWhatsAppWebhook(input, publishers(observed)), "accepted");
  assert.deepEqual(observed, [["inbound", "a"], ["inbound", "b"], ["status", "c"], ["inbound", "d"]]);
});

test("preflight preserves empty/no-op changes and ignores unrelated Meta event types", () => {
  const result = preflightWhatsAppWebhook(payload([
    { field: "message_template_components_update", value: null },
    { field: "message_template_quality_update", value: 5 },
    { field: "template_category_update", value: [] },
    messages(),
  ]));
  assert.equal(result.valid, true);
  assert.deepEqual(result.events, []);
});
