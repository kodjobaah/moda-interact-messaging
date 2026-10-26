import assert from "node:assert/strict";
import { test } from "node:test";

import { preflightWhatsAppWebhook } from "../app/lib/whatsapp/webhook-preflight.ts";
import { dispatchWhatsAppWebhook } from "../app/lib/whatsapp/webhook-dispatch.server.ts";

const timestamp = "1788144000";
const template = (overrides = {}) => ({
  field: "message_template_status_update",
  value: {
    message_template_id: "55", message_template_name: "checkout_recovery",
    message_template_language: "en_GB", event: "APPROVED", reason: "NONE",
    ...overrides,
  },
});
const messages = (id) => ({
  field: "messages", value: {
    metadata: { phone_number_id: "phone-1" },
    messages: [{ id, from: "15555550123", timestamp, type: "text", text: { body: "hello" } }],
    statuses: [{ id: `${id}-out`, status: "sent", timestamp }],
  },
});
const batch = (...changes) => ({ object: "whatsapp_business_account", entry: [{ id: "123456789", changes }] });
function recorder() {
  const calls = [];
  const publishers = {
    async enqueueInboundMessage(event) { calls.push({ kind: "inbound", event }); },
    async enqueueProviderStatus(event) { calls.push({ kind: "status", event }); },
    async enqueueTemplateStatus(event) { calls.push({ kind: "template", event }); },
  };
  return { calls, publishers };
}

test("stages each relevant change in original entry/change and message/status order", async () => {
  const payload = batch(
    { field: "message_template_quality_update", value: null },
    messages("a"), template(),
    { field: "template_category_update", value: null },
    template({ event: "PAUSED" }), messages("b"),
  );
  payload.entry.push({ id: "999", changes: [template({ event: "UNKNOWN_FUTURE" })] });
  const preflight = preflightWhatsAppWebhook(payload);
  assert.equal(preflight.valid, true);
  assert.deepEqual(preflight.events.map(({ kind }) => kind), [
    "inbound", "status", "template-status", "template-status", "inbound", "status", "template-status",
  ]);
  assert.equal(preflight.events[2].event.wabaId, "123456789");
  assert.equal(preflight.events[6].event.wabaId, "999");
  assert.equal(preflight.events[6].event.providerStatus, "UNKNOWN_FUTURE");

  const { calls, publishers } = recorder();
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "accepted");
  assert.deepEqual(calls.map(({ kind }) => kind), ["inbound", "status", "template", "template", "inbound", "status", "template"]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "template").map(({ event }) => event.providerStatus), [
    "APPROVED", "PAUSED", "UNKNOWN_FUTURE",
  ]);
  assert.ok(calls.filter(({ kind }) => kind === "template").every(({ event }) => event.schemaVersion === 2));
});

test("rejects a late invalid template change before any previously staged job is published", async () => {
  const { calls, publishers } = recorder();
  const payload = batch(messages("a"), template(), template({ event: " " }));
  assert.deepEqual(preflightWhatsAppWebhook(payload), { valid: false });
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "invalid_payload");
  assert.deepEqual(calls, []);
});

test("rejects unsafe IDs and malformed matching changes but skips invalid ordinary statuses", async () => {
  const { calls, publishers } = recorder();
  const invalid = [
    template({ message_template_id: Number.MAX_SAFE_INTEGER + 1 }),
    template({ message_template_name: "" }),
    template({ message_template_language: "en_GB " }),
    template({ reason: "bad\nreason" }),
    { field: "message_template_status_update", value: null },
  ];
  for (const item of invalid) {
    assert.equal(await dispatchWhatsAppWebhook(batch(messages("a"), item), publishers), "invalid_payload");
  }
  assert.deepEqual(calls, []);
  const payload = batch({
    field: "messages", value: {
      metadata: { phone_number_id: "phone-1" },
      statuses: [{ id: "bad", status: "not-a-status", timestamp }],
    },
  }, template());
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "accepted");
  assert.deepEqual(calls.map(({ kind }) => kind), ["template"]);
});

test("only WABA template-status changes are recognized; external names still publish", async () => {
  const { calls, publishers } = recorder();
  assert.equal(await dispatchWhatsAppWebhook({ ...batch(template()), object: "other" }, publishers), "accepted");
  assert.equal(await dispatchWhatsAppWebhook(batch(
    { field: "message_template_components_update", value: template().value },
    { field: "message_template_quality_update", value: template().value },
    { field: "template_category_update", value: template().value },
    template({ message_template_name: "externally_created_template" }),
  ), publishers), "accepted");
  assert.deepEqual(calls.map(({ event }) => event.providerTemplateName), ["externally_created_template"]);
});

test("independently received identical changes receive distinct occurrence identities", async () => {
  const { calls, publishers } = recorder();
  const payload = batch(template());
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "accepted");
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers), "accepted");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].event.eventIdentity, calls[1].event.eventIdentity);
  assert.equal(calls[0].event.providerTemplateName, calls[1].event.providerTemplateName);
});

test("queue failure propagates after prior acceptance, never publishes later changes", async () => {
  const failure = new Error("redis unavailable");
  const seen = [];
  const publishers = {
    async enqueueInboundMessage(event) { seen.push(`in:${event.providerMessageId}`); },
    async enqueueProviderStatus(event) { seen.push(`status:${event.providerMessageId}`); },
    async enqueueTemplateStatus(event) { seen.push(`template:${event.providerStatus}`); throw failure; },
  };
  await assert.rejects(dispatchWhatsAppWebhook(batch(messages("a"), template(), messages("b")), publishers), (e) => e === failure);
  assert.deepEqual(seen, ["in:a", "status:a-out", "template:APPROVED"]);
});
