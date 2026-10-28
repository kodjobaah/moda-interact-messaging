import { enqueueInboundMessage, enqueueProviderStatus } from "./whatsapp-job-publisher.server";
import { preflightWhatsAppWebhook } from "./webhook-preflight";

export type WhatsAppDispatchOutcome = "accepted" | "invalid_payload";

type WhatsAppPublishers = {
  enqueueInboundMessage: typeof enqueueInboundMessage;
  enqueueProviderStatus: typeof enqueueProviderStatus;
};

const productionPublishers: WhatsAppPublishers = {
  enqueueInboundMessage,
  enqueueProviderStatus,
};

export async function dispatchWhatsAppWebhook(
  payload: unknown,
  publishers: WhatsAppPublishers = productionPublishers,
): Promise<WhatsAppDispatchOutcome> {
  const prepared = preflightWhatsAppWebhook(payload);
  if (!prepared.valid) return "invalid_payload";

  // Only begin side effects after the whole authenticated batch passes preflight.
  // Publication remains sequential and is not a multi-job atomic transaction.
  for (const item of prepared.events) {
    if (item.kind === "inbound") {
      await publishers.enqueueInboundMessage(item.event);
    } else {
      await publishers.enqueueProviderStatus(item.event);
    }
  }

  return "accepted";
}
