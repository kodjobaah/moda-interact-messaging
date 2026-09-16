import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const {
  createJobId,
  normalizeInboundMessageFromWebhook,
} = await import("../app/routes/whatsapp.tsx");

const entry = { id: "waba-123" };
const change = {
  field: "messages",
  value: {
    metadata: {
      display_phone_number: "+15555550123",
      phone_number_id: "phone-number-456",
    },
  },
};

function normalize(message) {
  return normalizeInboundMessageFromWebhook({ entry, change, message });
}

test("preserves explicit text reply context", () => {
  assert.deepEqual(normalize({
    id: "wamid-text-reply",
    from: "15555550123",
    timestamp: "1788144000",
    type: "text",
    context: { id: "wamid-outbound" },
    text: { body: "Where is my order?" },
  }), {
    schemaVersion: 1,
    provider: "whatsapp",
    providerAccountId: "waba-123",
    providerPhoneNumberId: "phone-number-456",
    providerMessageId: "wamid-text-reply",
    customerPhone: "15555550123",
    contextMessageId: "wamid-outbound",
    occurredAt: "2026-08-31T02:40:00.000Z",
    content: { type: "text", text: "Where is my order?" },
  });
});

test("represents a contextless text message with null context", () => {
  const event = normalize({
    id: "wamid-text",
    from: "15555550123",
    timestamp: "1788144000",
    type: "text",
    text: { body: "Hello" },
  });

  assert.equal(event?.contextMessageId, null);
  assert.deepEqual(event?.content, { type: "text", text: "Hello" });
});

test("preserves voice-note media identity and metadata", () => {
  const event = normalize({
    id: "wamid-audio",
    from: "15555550123",
    timestamp: "1788144000",
    type: "audio",
    audio: {
      id: "media-789",
      mime_type: "audio/ogg; codecs=opus",
      sha256: "abc123",
      voice: true,
    },
  });

  assert.deepEqual(event?.content, {
    type: "audio",
    mediaId: "media-789",
    mimeType: "audio/ogg; codecs=opus",
    sha256: "abc123",
    voice: true,
  });
});

test("preserves context on audio and allows omitted optional metadata", () => {
  const event = normalize({
    id: "wamid-audio-reply",
    from: "15555550123",
    timestamp: "1788144000",
    type: "audio",
    context: { id: "wamid-outbound-audio" },
    audio: { id: "media-790" },
  });

  assert.equal(event?.contextMessageId, "wamid-outbound-audio");
  assert.deepEqual(event?.content, {
    type: "audio",
    mediaId: "media-790",
    mimeType: null,
    sha256: null,
    voice: null,
  });
});

for (const providerType of ["image", "document", "video", "sticker", "location"]) {
  test(`maps ${providerType} to explicit unsupported content`, () => {
    const event = normalize({
      id: `wamid-${providerType}`,
      from: "15555550123",
      timestamp: "1788144000",
      type: providerType,
      [providerType]: { id: "provider-content" },
    });

    assert.deepEqual(event?.content, {
      type: "unsupported",
      providerType,
    });
    assert.equal("text" in (event?.content ?? {}), false);
  });
}

test("keeps WABA and phone-number provider identities separate", () => {
  const event = normalize({
    id: "wamid-identities",
    from: "15555550123",
    timestamp: "1788144000",
    type: "text",
    text: { body: "Identity check" },
  });

  assert.equal(event?.providerAccountId, entry.id);
  assert.equal(event?.providerPhoneNumberId, change.value.metadata.phone_number_id);
  assert.notEqual(event?.providerAccountId, event?.providerPhoneNumberId);
  assert.equal("customerAddress" in (event ?? {}), false);
});

test("rejects malformed identities, content, context and timestamps", () => {
  assert.equal(normalize({
    id: "",
    from: "15555550123",
    timestamp: "1788144000",
    type: "text",
    text: { body: "Invalid id" },
  }), null);
  assert.equal(normalize({
    id: "wamid-invalid-text",
    from: "15555550123",
    timestamp: "1788144000",
    type: "text",
    text: { body: "" },
  }), null);
  assert.equal(normalize({
    id: "wamid-invalid-audio",
    from: "15555550123",
    timestamp: "1788144000",
    type: "audio",
    audio: {},
  }), null);
  assert.equal(normalize({
    id: "wamid-invalid-context",
    from: "15555550123",
    timestamp: "1788144000",
    type: "text",
    context: { id: 123 },
    text: { body: "Invalid context" },
  }), null);
  assert.equal(normalize({
    id: "wamid-invalid-time",
    from: "15555550123",
    timestamp: "not-a-timestamp",
    type: "text",
    text: { body: "Invalid time" },
  }), null);
});

test("duplicate provider messages receive the same bounded deterministic job ID", () => {
  assert.equal(createJobId("wamid-duplicate"), createJobId("wamid-duplicate"));
  assert.match(createJobId("wamid-duplicate"), /^wa-[a-f0-9]{64}$/);
});

test("does not log raw webhook bodies or audio payloads", () => {
  const source = readFileSync(new URL("../app/routes/whatsapp.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*rawBody/);
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*audio/);
  assert.doesNotMatch(source, /customerAddress/);
});