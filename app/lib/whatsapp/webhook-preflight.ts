import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";

import { normalizeInboundMessageFromWebhook } from "./inbound-message-normalizer";
import { normalizeProviderStatusFromWebhook } from "./provider-status-normalizer";

export type PreparedWhatsAppEvent =
  | { kind: "inbound"; event: NormalizedWhatsAppInboundMessage }
  | { kind: "status"; event: NormalizedWhatsAppStatus };

export type WhatsAppPreflightResult =
  | { valid: true; events: PreparedWhatsAppEvent[] }
  | { valid: false };

const invalidPayload = { valid: false } as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only structural envelope fields are validated here. Individual status events
// keep their existing ignore-invalid policy; inbound events must all be valid.
// No queue or other external operation is allowed in this preflight.
export function preflightWhatsAppWebhook(payload: unknown): WhatsAppPreflightResult {
  if (!isObjectRecord(payload) || !Array.isArray(payload.entry)) return invalidPayload;

  const events: PreparedWhatsAppEvent[] = [];

  for (const entry of payload.entry) {
    if (!isObjectRecord(entry)) return invalidPayload;
    if (entry.changes == null) continue;
    if (!Array.isArray(entry.changes)) return invalidPayload;

    for (const change of entry.changes) {
      if (!isObjectRecord(change)) return invalidPayload;
      if (change.field !== "messages") continue;
      if (!isObjectRecord(change.value)) return invalidPayload;

      const { messages, statuses } = change.value;
      if (messages != null && !Array.isArray(messages)) return invalidPayload;
      if (statuses != null && !Array.isArray(statuses)) return invalidPayload;

      // Retain the existing messages-first order for each change.
      for (const message of Array.isArray(messages) ? messages : []) {
        const normalized = normalizeInboundMessageFromWebhook({ entry, change, message });
        if (!normalized) return invalidPayload;
        events.push({ kind: "inbound", event: normalized });
      }

      for (const status of Array.isArray(statuses) ? statuses : []) {
        const normalized = normalizeProviderStatusFromWebhook({ entry, change, status });
        if (normalized) events.push({ kind: "status", event: normalized });
      }
    }
  }

  return { valid: true, events };
}
