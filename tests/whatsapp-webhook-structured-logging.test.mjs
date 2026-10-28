import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import fixture from "@modainteract/moda-interact-shared/whatsapp-template-events/fixtures" with { type: "json" };
import { MetaConfigurationFailure } from "../app/lib/platform-configuration/meta-contract.server.ts";
import { dispatchWhatsAppWebhook } from "../app/lib/whatsapp/webhook-dispatch.server.ts";
import {
  enqueueInboundMessage,
  enqueueProviderStatus,
  enqueueTemplateStatus,
} from "../app/lib/whatsapp/whatsapp-job-publisher.server.ts";
import { action } from "../app/routes/whatsapp.tsx";
import { createMetaCredentialsReader, META_CREDENTIALS } from "./helpers/meta-credentials.mjs";

const endpoint = "https://messaging.example/webhook/whatsapp";
const timestamp = "1788144000";
const sensitiveContent = "PRIVATE_CUSTOMER_MESSAGE_12345";
const sensitiveFieldName = "UNKNOWN_PRIVATE_FIELD_ABC";

function captureLogger() {
  const entries = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (event, data) => {
    entries.push({ level, event, data });
  }]));
  return { entries, logger };
}

function incoming(id = "wamid-test") {
  return {
    id, from: "15555550123", timestamp, type: "text", text: { body: sensitiveContent },
  };
}

function messageChange(messages = [], statuses = []) {
  return {
    field: "messages",
    value: { metadata: { phone_number_id: "123456" }, messages, statuses },
  };
}

function envelope(...changes) {
  // Meta template-status preflight requires a decimal WhatsApp Business Account ID.
  return { object: "whatsapp_business_account", entry: [{ id: "123456789012345", changes }] };
}

function publishersWithCalls() {
  const calls = [];
  return { calls, publishers: {
    async enqueueInboundMessage(event) { calls.push(["inbound", event]); },
    async enqueueProviderStatus(event) { calls.push(["status", event]); },
    async enqueueTemplateStatus(event) { calls.push(["template", event]); },
  } };
}

function signed(body, signingBody = body) {
  const signature = createHmac("sha256", META_CREDENTIALS.appSecret)
    .update(signingBody, "utf8").digest("hex");
  return new Request(endpoint, {
    method: "POST", body, headers: { "x-hub-signature-256": `sha256=${signature}` },
  });
}

test("dispatcher identifies supported and ignored Meta fields without logging arbitrary payloads or IDs", async () => {
  const { logger, entries } = captureLogger();
  const { publishers, calls } = publishersWithCalls();
  const payload = envelope(
    { field: "message_echoes", value: { body: sensitiveContent } },
    { field: "message_template_quality_update", value: { secret: sensitiveContent } },
    { field: sensitiveFieldName, value: { secret: sensitiveContent } },
    messageChange([incoming()], [{ id: "status-1", status: "delivered", timestamp }]),
  );
  assert.equal(await dispatchWhatsAppWebhook(payload, publishers, logger), "accepted");
  assert.deepEqual(calls.map(([name]) => name), ["inbound", "status"]);
  assert.deepEqual(entries, [{
    level: "info",
    event: "messaging.webhook.dispatch_completed",
    data: {
      receivedFields: ["message_echoes", "message_template_quality_update", "messages"],
      ignoredFields: ["message_echoes", "message_template_quality_update"],
      unknownFieldCount: 1,
      normalizedCounts: { inbound: 1, status: 1, templateStatus: 0 },
      publishedCount: 2,
      outcome: "published",
    },
  }]);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_CUSTOMER|UNKNOWN_PRIVATE|15555550123|123456789012345|123456/);
});

test("unsupported events return accepted but are explicitly logged as ignored; empty batches are distinguishable", async () => {
  const { logger, entries } = captureLogger();
  const { publishers, calls } = publishersWithCalls();
  const ignored = envelope(
    { field: "message_template_components_update", value: null },
    { field: "messaging_handovers", value: null },
    { field: "template_category_update", value: null },
    { field: "template_correct_category_detection", value: null },
  );
  assert.equal(await dispatchWhatsAppWebhook(ignored, publishers, logger), "accepted");
  assert.deepEqual(calls, []);
  assert.deepEqual(entries[0].data.ignoredFields, [
    "message_template_components_update", "messaging_handovers",
    "template_category_update", "template_correct_category_detection",
  ]);
  assert.equal(entries[0].data.publishedCount, 0);
  assert.equal(entries[0].data.outcome, "ignored");

  assert.equal(await dispatchWhatsAppWebhook({ entry: [] }, publishers, logger), "accepted");
  assert.equal(entries[1].data.outcome, "no_actionable_events");
  assert.equal(entries[1].data.publishedCount, 0);
});

test("invalid preflight logs rejection and publishes nothing", async () => {
  const { logger, entries } = captureLogger();
  const { publishers, calls } = publishersWithCalls();
  assert.equal(await dispatchWhatsAppWebhook(envelope(messageChange([incoming("id1")]),
    messageChange([incoming("id2")], "malformed-statuses")), publishers, logger), "invalid_payload");
  assert.deepEqual(calls, []);
  assert.deepEqual(entries, [{
    level: "warn", event: "messaging.webhook.dispatch_rejected",
    data: { reasonCode: "INVALID_PAYLOAD", publishedCount: 0 },
  }]);
});

test("partial queue failure logs the confirmed prefix and propagates the original error", async () => {
  const { logger, entries } = captureLogger();
  const failure = new Error("PRIVATE_QUEUE_CONNECTION_SECRET");
  const calls = [];
  const publishers = {
    async enqueueInboundMessage(event) { calls.push(event.providerMessageId); },
    async enqueueProviderStatus(event) { calls.push(event.providerMessageId); throw failure; },
  };
  const payload = envelope(messageChange([incoming("in-1")], [{ id: "status-1", status: "sent", timestamp }]));
  await assert.rejects(dispatchWhatsAppWebhook(payload, publishers, logger), (error) => error === failure);
  assert.deepEqual(calls, ["in-1", "status-1"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "messaging.webhook.dispatch_failed");
  assert.equal(entries[0].data.reasonCode, "QUEUE_PUBLICATION_FAILED");
  assert.equal(entries[0].data.failedKind, "status");
  assert.equal(entries[0].data.publishedCount, 1);
  assert.deepEqual(entries[0].data.normalizedCounts, { inbound: 1, status: 1, templateStatus: 0 });
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_QUEUE_CONNECTION_SECRET|PRIVATE_CUSTOMER_MESSAGE/);
});

test("publisher logs only after queue add resolves, without leaking provider identifiers", async () => {
  const { logger, entries } = captureLogger();
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const payload = {
    schemaVersion: 1, provider: "whatsapp", providerAccountId: "private-account",
    providerPhoneNumberId: "private-phone", providerMessageId: "private-wamid",
    customerPhone: "15555550123", occurredAt: "2026-08-31T02:40:00.000Z",
    content: { type: "text", text: sensitiveContent }, contextMessageId: null,
  };
  const publishing = enqueueInboundMessage(payload, { add: () => pending }, logger);
  await Promise.resolve();
  assert.deepEqual(entries, []);
  resolve({ id: "ok" });
  await publishing;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "messaging.whatsapp.job_published");
  assert.equal(entries[0].data.jobType, "message-received");
  assert.match(entries[0].data.jobId, /^wa-[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(entries), /private|PRIVATE_CUSTOMER|15555550123/);
});

test("publisher failures are logged for inbound, status and template and still propagate", async () => {
  const { logger, entries } = captureLogger();
  const failure = new Error("SECRET_URL_DO_NOT_LOG");
  const brokenQueue = { async add() { throw failure; } };
  const status = {
    schemaVersion: 3, providerAccountId: "a", providerPhoneNumberId: "b",
    providerMessageId: "provider-out", status: "DELIVERED",
    occurredAt: "2026-08-31T02:40:00.000Z",
  };
  const inbound = {
    schemaVersion: 1, providerMessageId: "inbound", content: { type: "text", text: sensitiveContent },
  };
  await assert.rejects(enqueueInboundMessage(inbound, brokenQueue, logger), (error) => error === failure);
  await assert.rejects(enqueueProviderStatus(status, brokenQueue, logger), (error) => error === failure);
  await assert.rejects(enqueueTemplateStatus(fixture.observation, brokenQueue, logger), (error) => error === failure);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(({ event }) => event), Array(3).fill("messaging.whatsapp.job_publish_failed"));
  assert.deepEqual(entries.map(({ data }) => data.reasonCode), Array(3).fill("QUEUE_ADD_FAILED"));
  assert.doesNotMatch(JSON.stringify(entries), /SECRET_URL_DO_NOT_LOG|PRIVATE_CUSTOMER/);
});

test("HTTP route reports rejected signatures, invalid JSON, configuration errors and propagated processing failures", async () => {
  const { logger, entries } = captureLogger();
  const metaReader = createMetaCredentialsReader().reader;
  let dispatchCount = 0;
  const dispatch = async () => { dispatchCount += 1; return "accepted"; };
  const unauthorized = await action({ request: signed('not-json', '{"entry":[]}') }, dispatch, metaReader, logger);
  assert.equal(unauthorized.status, 401);
  const malformed = await action({ request: signed("not-json") }, dispatch, metaReader, logger);
  assert.equal(malformed.status, 400);
  const missingReader = createMetaCredentialsReader({ failure: new MetaConfigurationFailure("DB_UNAVAILABLE") }).reader;
  const unavailable = await action({ request: signed('{"entry":[]}') }, dispatch, missingReader, logger);
  assert.equal(unavailable.status, 503);
  assert.equal(dispatchCount, 0);
  assert.deepEqual(entries.map(({ event, data }) => [event, data.reasonCode, data.statusCode]), [
    ["messaging.webhook.request_rejected", "invalid_signature", 401],
    ["messaging.webhook.request_rejected", "invalid_json", 400],
    ["messaging.webhook.request_rejected", "configuration_unavailable", 503],
  ]);

  const failure = new Error("SENSITIVE_ERROR_STACK");
  await assert.rejects(action({ request: signed('{"entry":[]}') }, async () => { throw failure; }, metaReader, logger),
    (error) => error === failure);
  assert.deepEqual(entries.at(-1), {
    level: "error", event: "messaging.webhook.request_failed",
    data: { reasonCode: "PROCESSING_ERROR", statusCode: 500 },
  });
  assert.doesNotMatch(JSON.stringify(entries), /SENSITIVE_ERROR_STACK|PRIVATE_CUSTOMER_MESSAGE/);
});

test("signed POST acknowledgement distinguishes ignored fields from published template status", async () => {
  const { logger, entries } = captureLogger();
  const { publishers, calls } = publishersWithCalls();
  const reader = createMetaCredentialsReader().reader;
  const dispatch = (payload) => dispatchWhatsAppWebhook(payload, publishers, logger);

  const ignored = await action({ request: signed(JSON.stringify(envelope(
    { field: "message_echoes", value: { text: { body: sensitiveContent } } },
  ))) }, dispatch, reader, logger);
  assert.equal(ignored.status, 200);
  assert.equal(await ignored.text(), "EVENT_RECEIVED");
  assert.equal(entries[0].event, "messaging.webhook.dispatch_completed");
  assert.equal(entries[0].data.outcome, "ignored");
  assert.deepEqual(calls, []);

  const status = await action({ request: signed(JSON.stringify(envelope({
    field: "message_template_status_update",
    value: {
      event: "APPROVED", message_template_id: "987654321",
      message_template_name: "checkout_recovery_initial_v2",
      message_template_language: "en_GB", reason: null,
    },
  }))) }, dispatch, reader, logger);
  assert.equal(status.status, 200);
  assert.equal(await status.text(), "EVENT_RECEIVED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "template");
  assert.deepEqual(entries[1].data.normalizedCounts, { inbound: 0, status: 0, templateStatus: 1 });
  assert.equal(entries[1].data.publishedCount, 1);
  assert.equal(entries[1].data.outcome, "published");
});
