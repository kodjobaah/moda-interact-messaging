import { normalizeInboundMessageFromWebhook } from "./inbound-message-normalizer";
import { normalizeProviderStatusFromWebhook } from "./provider-status-normalizer";
import { enqueueInboundMessage, enqueueProviderStatus } from "./whatsapp-job-publisher.server";

export type WhatsAppDispatchOutcome = "accepted" | "invalid_payload";

type WhatsAppPublishers = {
  enqueueInboundMessage: typeof enqueueInboundMessage;
  enqueueProviderStatus: typeof enqueueProviderStatus;
};

const productionPublishers: WhatsAppPublishers = {
  enqueueInboundMessage,
  enqueueProviderStatus,
};

// Deliberately retain the pre-ARCH-034 envelope/traversal semantics. MESSAGING-005
// will separately add full-batch shape validation and pre-publication preflight.
export async function dispatchWhatsAppWebhook(
  payload: any,
  publishers: WhatsAppPublishers = productionPublishers,
): Promise<WhatsAppDispatchOutcome> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") {
        continue;
      }

      const value = change.value;
      // Inbound messages are always published before statuses for this change.
      for (const message of value.messages ?? []) {
        const normalized = normalizeInboundMessageFromWebhook({
          entry,
          change,
          message,
        });

        if (!normalized) {
          return "invalid_payload";
        }

        await publishers.enqueueInboundMessage(normalized);
      }

      // Unknown or malformed individual provider statuses are silently ignored.
      for (const status of value.statuses ?? []) {
        const normalized = normalizeProviderStatusFromWebhook({
          entry,
          change,
          status,
        });
        if (normalized) {
          await publishers.enqueueProviderStatus(normalized);
        }
      }
    }
  }

  return "accepted";
}
