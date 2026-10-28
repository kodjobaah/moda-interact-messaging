import assert from "node:assert/strict";
import { test } from "node:test";

import fixture from "@modainteract/moda-interact-shared/whatsapp-template-events/fixtures" with { type: "json" };
import {
  META_TEMPLATE_STATUS_SCHEMA_VERSION,
  MetaTemplateStatusObservationV2Schema,
  formatMetaTemplateStatusEventIdentity,
  formatMetaTemplateStatusJobId,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";
import { normalizeTemplateStatusChange } from "../app/lib/whatsapp/template-status-normalizer.ts";
import { createTemplateStatusObservation } from "../app/lib/whatsapp/template-status-observation-id.server.ts";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const entry = { id: "123456789" };
const change = {
  field: "message_template_status_update",
  value: {
    message_template_id: "987654321",
    message_template_name: "checkout_recovery_initial_v2",
    message_template_language: "en_GB",
    event: "APPROVED",
    reason: "NONE",
    metadata: { phone_number_id: "111111111" },
  },
};
const receivedAt = new Date("2026-10-25T19:00:00.000Z");

function normalize(overrides = {}, entryId = entry.id, time = receivedAt) {
  return normalizeTemplateStatusChange({
    entry: { id: entryId },
    change: { ...change, value: { ...change.value, ...overrides } },
    receivedAt: time,
  });
}

test("uses the published nine-field v2 fixture and Shared UUID formatters", () => {
  const fields = normalize();
  assert.ok(fields);
  assert.deepEqual(createTemplateStatusObservation(fields, uuid), fixture.observation);
  assert.equal(META_TEMPLATE_STATUS_SCHEMA_VERSION, 2);
  assert.equal(formatMetaTemplateStatusEventIdentity(uuid), fixture.observation.eventIdentity);
  assert.equal(formatMetaTemplateStatusJobId(uuid), fixture.expectedJobId);
  assert.deepEqual(Object.keys(fixture.observation).sort(), [
    "schemaVersion", "eventIdentity", "wabaId", "providerTemplateId",
    "providerTemplateName", "providerLanguageCode", "providerStatus",
    "reasonCode", "receivedAt",
  ].sort());
  assert.deepEqual(MetaTemplateStatusObservationV2Schema.parse(fixture.observation), fixture.observation);
});

test("preserves provider spelling and explicit nulls, never defaults a status to approved", () => {
  const fields = normalize({ event: "FUTURE_provider_STATE", reason: null, message_template_id: null });
  assert.ok(fields);
  assert.equal(fields.providerStatus, "FUTURE_provider_STATE");
  assert.equal(fields.providerLanguageCode, "en_GB");
  assert.equal(fields.reasonCode, null);
  assert.equal(fields.providerTemplateId, null);
  assert.equal(fields.wabaId, "123456789");
  assert.equal("eventIdentity" in fields, false);
  assert.equal(normalize({ reason: undefined, message_template_id: undefined })?.reasonCode, null);
  assert.equal(normalize({ reason: undefined, message_template_id: undefined })?.providerTemplateId, null);
});

test("accepts only safe nonnegative numeric provider IDs and decimal strings", () => {
  assert.equal(normalize({ message_template_id: 987654321 })?.providerTemplateId, "987654321");
  assert.equal(normalize({}, 123456789)?.wabaId, "123456789");
  assert.equal(normalize({ message_template_id: 0 })?.providerTemplateId, "0");
  assert.equal(normalize({ message_template_id: "000123" })?.providerTemplateId, "000123");
  for (const invalidId of [
    -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    "", " 1", "1 ", "+1", "1e3", "a1", "0".repeat(33),
    {}, [], true,
  ]) {
    assert.equal(normalize({ message_template_id: invalidId }), null, `template id: ${String(invalidId)}`);
    assert.equal(normalize({}, invalidId), null, `WABA id: ${String(invalidId)}`);
  }
});

test("rejects malformed template fields, including whitespace and control bytes", () => {
  for (const [field, invalids] of Object.entries({
    message_template_name: [null, "", " ", "bad ", " bad", "hello\n", "x".repeat(256), 8, {}],
    message_template_language: [null, "", "en_GB ", "\ten_GB", "x".repeat(17), []],
    event: [null, "", " APPROVED", "APPROVED ", "X\u0000", "x".repeat(33), false],
    reason: ["", " reason", "reason ", "bad\r", "r".repeat(129), 42, []],
  })) {
    for (const bad of invalids) {
      assert.equal(normalize({ [field]: bad }), null, `${field}: ${JSON.stringify(bad)}`);
    }
  }
  assert.equal(normalize({ message_template_name: "🧪".repeat(256) }), null);
  assert.equal(normalize({}, entry.id, new Date(NaN)), null);
  assert.equal(normalizeTemplateStatusChange({ entry, change: { value: [] } }), null);
});

test("preflight rejects values exceeding the Shared size contract without leaking raw source data", () => {
  assert.equal(normalize({ message_template_name: "🧪".repeat(2048) }), null);
  const fields = normalize();
  assert.ok(fields);
  assert.equal(MetaTemplateStatusObservationV2Schema.safeParse({
    ...createTemplateStatusObservation(fields, uuid), extraProviderField: "unexpected",
  }).success, false);
  assert.equal(MetaTemplateStatusObservationV2Schema.safeParse({
    ...fixture.observation, schemaVersion: 1,
  }).success, false);
});

test("creates a fresh v4 UUID per observation; a deterministic fixture remains reproducible", () => {
  const fields = normalize();
  assert.ok(fields);
  const first = createTemplateStatusObservation(fields);
  const second = createTemplateStatusObservation(fields);
  assert.notEqual(first.eventIdentity, second.eventIdentity);
  assert.equal(first.receivedAt, fields.receivedAt);
  assert.deepEqual(createTemplateStatusObservation(fields, uuid), fixture.observation);
  assert.throws(() => createTemplateStatusObservation(fields, "00000000-0000-1000-8000-000000000000"), TypeError);
});
