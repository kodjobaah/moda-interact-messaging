import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";

import { normalizeInboundMessageFromWebhook } from "./inbound-message-normalizer";
import { normalizeProviderStatusFromWebhook } from "./provider-status-normalizer";
import { normalizeTemplateStatusChange } from "./template-status-normalizer";
import type { PreparedTemplateStatusFields } from "./template-status-normalizer";

export type PreparedWhatsAppEvent =
  | { kind: "inbound"; event: NormalizedWhatsAppInboundMessage }
  | { kind: "status"; event: NormalizedWhatsAppStatus }
  | { kind: "template-status"; event: PreparedTemplateStatusFields };

export type WhatsAppPreflightResult =
  | { valid: true; events: PreparedWhatsAppEvent[] }
  | { valid: false };

const invalidPayload: WhatsAppPreflightResult = { valid: false };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate an authenticated batch completely before the first queue operation. */
export function preflightWhatsAppWebhook(payload: unknown): WhatsAppPreflightResult {
  if (!isObjectRecord(payload) || !Array.isArray(payload.entry)) return invalidPayload;

  const events: PreparedWhatsAppEvent[] = [];
  for (const entry of payload.entry) {
    if (!isObjectRecord(entry)) return invalidPayload;
    const changes = entry.changes;
    if (changes == null) continue;
    if (!Array.isArray(changes)) return invalidPayload;

    for (const change of changes) {
      if (!isObjectRecord(change)) return invalidPayload;
      if (change.field === "message_template_status_update"
        && payload.object === "whatsapp_business_account") {
        const normalized = normalizeTemplateStatusChange({ entry, change });
        if (!normalized) return invalidPayload;
        events.push({ kind: "template-status", event: normalized });
        continue;
      }
      if (change.field !== "messages") continue;
      if (!isObjectRecord(change.value)) return invalidPayload;

      const messages = change.value.messages;
      const statuses = change.value.statuses;
      if (messages != null && !Array.isArray(messages)) return invalidPayload;
      if (statuses != null && !Array.isArray(statuses)) return invalidPayload;

      // The accepted v1/v3 rule publishes messages before statuses in each change.
      for (const message of messages ?? []) {
        const normalized = normalizeInboundMessageFromWebhook({ entry, change, message });
        if (!normalized) return invalidPayload;
        events.push({ kind: "inbound", event: normalized });
      }
      // Individual malformed provider statuses have always been skipped.
      for (const status of statuses ?? []) {
        const normalized = normalizeProviderStatusFromWebhook({ entry, change, status });
        if (normalized) events.push({ kind: "status", event: normalized });
      }
    }
  }
  return { valid: true, events };
}
