import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

const { createStatusJobId } = await import("../app/routes/whatsapp.tsx");
const {
  normalizeProviderStatus,
  normalizeProviderStatusFromWebhook,
} = await import("../app/lib/whatsapp/provider-status-normalizer.ts");

const base = {
  entryId: "waba-1",
  phoneNumberId: "phone-1",
};

for (const [providerStatus, expectedStatus] of [
  ["sent", "SENT"],
  ["delivered", "DELIVERED"],
  ["read", "READ"],
  ["failed", "FAILED"],
]) {
  test(`normalizes ${providerStatus} provider status`, () => {
    const event = normalizeProviderStatus({
      ...base,
      status: {
        id: "wamid-1",
        status: providerStatus,
        timestamp: "1788144000",
      },
    });

    assert.deepEqual(event, {
      schemaVersion: 3,
      providerAccountId: "waba-1",
      providerPhoneNumberId: "phone-1",
      providerMessageId: "wamid-1",
      status: expectedStatus,
      occurredAt: "2026-08-31T02:40:00.000Z",
    });
  });
}

test("retains bounded optional pricing metadata without monetary invention", () => {
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-2",
      status: "delivered",
      timestamp: "1788144000",
      pricing: {
        billable: true,
        category: "utility",
        pricing_model: "PMP",
        amount: "999.00",
      },
    },
  });

  assert.deepEqual(event?.pricing, {
    billable: true,
    category: "utility",
    model: "PMP",
  });
});

test("normalizes provider status identities from a realistic Meta webhook payload", () => {
  const event = normalizeProviderStatusFromWebhook({
    entry: {
      id: "waba-1",
    },
    change: {
      field: "messages",
      value: {
        metadata: {
          display_phone_number: "+15555550123",
          phone_number_id: "phone-1",
        },
        statuses: [{
          id: "wamid-1",
          status: "delivered",
          timestamp: "1788144000",
          pricing: {
            billable: true,
            pricing_model: "PMP",
            category: "utility",
          },
        }],
      },
    },
    status: {
      id: "wamid-1",
      status: "delivered",
      timestamp: "1788144000",
      pricing: {
        billable: true,
        pricing_model: "PMP",
        category: "utility",
      },
    },
  });

  assert.deepEqual(event, {
    schemaVersion: 3,
    providerAccountId: "waba-1",
    providerPhoneNumberId: "phone-1",
    providerMessageId: "wamid-1",
    status: "DELIVERED",
    occurredAt: "2026-08-31T02:40:00.000Z",
    pricing: {
      billable: true,
      category: "utility",
      model: "PMP",
    },
  });
  assert.equal("shopId" in event, false);
});

test("normalizes finite integer provider failure codes to decimal text", () => {
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-failed-numeric",
      status: "failed",
      timestamp: "1788144000",
      errors: [{ code: 131026, title: "not copied", message: "not copied" }],
    },
  });

  assert.equal(event?.schemaVersion, 3);
  assert.deepEqual(event?.failure, { providerCode: "131026" });
  assert.equal("title" in (event ?? {}), false);
});

test("omits an over-bound numeric provider code without dropping FAILED status", () => {
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-failed-large-numeric",
      status: "failed",
      timestamp: "1788144000",
      errors: [{ code: 1e100 }],
    },
  });

  assert.equal(event?.schemaVersion, 3);
  assert.equal(event?.status, "FAILED");
  assert.equal("failure" in (event ?? {}), false);
});

test("continues to later valid evidence after an over-bound numeric provider code", () => {
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-failed-large-numeric-then-valid",
      status: "failed",
      timestamp: "1788144000",
      errors: [{ code: 1e100 }, { code: "provider-42" }],
    },
  });

  assert.equal(event?.schemaVersion, 3);
  assert.equal(event?.status, "FAILED");
  assert.deepEqual(event?.failure, { providerCode: "provider-42" });
});

test("trims bounded string failure codes and selects the first valid entry", () => {
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-failed-string",
      status: "failed",
      timestamp: "1788144000",
      errors: [
        null,
        { code: 1.5 },
        { code: "   " },
        { code: "x".repeat(65) },
        { code: "  provider-42  ", error_data: { details: "not copied" } },
        { code: "later-valid-code" },
      ],
    },
  });

  assert.equal(event?.failure?.providerCode, "provider-42");
  assert.equal(JSON.stringify(event).includes("not copied"), false);
  assert.equal(JSON.stringify(event).includes("later-valid-code"), false);
});

test("accepts string failure codes at the 64-character bound", () => {
  const providerCode = "x".repeat(64);
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-failed-max-code",
      status: "failed",
      timestamp: "1788144000",
      errors: [{ code: providerCode }],
    },
  });

  assert.equal(event?.failure?.providerCode, providerCode);
});

test("omits malformed optional failure evidence without dropping FAILED status", () => {
  for (const errors of [
    "not-an-array",
    [{ code: Number.POSITIVE_INFINITY }, { code: 2.25 }, { code: "" }],
    [{ code: "x".repeat(65) }],
  ]) {
    const event = normalizeProviderStatus({
      ...base,
      status: {
        id: "wamid-failed-no-code",
        status: "failed",
        timestamp: "1788144000",
        errors,
      },
    });

    assert.equal(event?.status, "FAILED");
    assert.equal(event?.schemaVersion, 3);
    assert.equal("failure" in (event ?? {}), false);
  }
});

test("never attaches failure evidence to non-FAILED statuses", () => {
  const event = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-delivered-with-malformed-errors",
      status: "delivered",
      timestamp: "1788144000",
      errors: [{ code: "provider-42" }],
    },
  });

  assert.equal(event?.status, "DELIVERED");
  assert.equal("failure" in (event ?? {}), false);
});

test("rejects missing provider identity or routing identity safely", () => {
  assert.equal(normalizeProviderStatus({
    ...base,
    status: { status: "sent", timestamp: "1788144000" },
  }), null);
  assert.equal(normalizeProviderStatus({
    entryId: "waba-1",
    status: { id: "wamid-3", status: "sent", timestamp: "1788144000" },
  }), null);
  assert.equal(normalizeProviderStatus({
    ...base,
    status: { id: "wamid-4", status: "queued", timestamp: "1788144000" },
  }), null);
  assert.equal(normalizeProviderStatus({
    ...base,
    status: { id: "wamid-6", status: "sent", timestamp: "not-a-timestamp" },
  }), null);
});

test("uses deterministic identity for duplicate status delivery", () => {
  const first = normalizeProviderStatus({
    ...base,
    status: { id: "wamid-5", status: "read", timestamp: "1788144000" },
  });
  const duplicate = normalizeProviderStatus({
    ...base,
    status: { id: "wamid-5", status: "read", timestamp: "1788144010" },
  });

  assert.ok(first);
  assert.ok(duplicate);
  assert.equal(createStatusJobId(first), createStatusJobId(duplicate));
  assert.ok(createStatusJobId(first).length <= 64);
  assert.equal(
    createStatusJobId(first),
    "ws-" + createHash("sha256")
      .update("waba-1:phone-1:wamid-5:READ")
      .digest("hex").slice(0, 61),
  );
  assert.equal("shopId" in first, false);
});

test("distinguishes FAILED evidence jobs while deduplicating exact evidence", () => {
  const failedWithoutEvidence = normalizeProviderStatus({
    ...base,
    status: { id: "wamid-job-id", status: "failed", timestamp: "1788144000" },
  });
  const failedWithEvidence = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-job-id",
      status: "failed",
      timestamp: "1788144010",
      errors: [{ code: " provider-42 " }],
    },
  });
  const duplicateEvidence = normalizeProviderStatus({
    ...base,
    status: {
      id: "wamid-job-id",
      status: "failed",
      timestamp: "1788144020",
      errors: [{ code: "provider-42" }],
    },
  });

  assert.ok(failedWithoutEvidence);
  assert.ok(failedWithEvidence);
  assert.ok(duplicateEvidence);
  assert.notEqual(createStatusJobId(failedWithoutEvidence), createStatusJobId(failedWithEvidence));
  assert.equal(
    createStatusJobId(failedWithoutEvidence),
    "ws-" + createHash("sha256")
      .update("waba-1:phone-1:wamid-job-id:FAILED")
      .digest("hex").slice(0, 61),
  );
  assert.equal(createStatusJobId(failedWithEvidence), createStatusJobId(duplicateEvidence));
});