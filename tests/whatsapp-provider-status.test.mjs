import assert from "node:assert/strict";
import { test } from "node:test";

const {
  createStatusJobId,
  normalizeProviderStatus,
  normalizeProviderStatusFromWebhook,
} = await import(
  "../app/routes/whatsapp.tsx"
);

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
      schemaVersion: 2,
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
    schemaVersion: 2,
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
  assert.equal("shopId" in first, false);
});