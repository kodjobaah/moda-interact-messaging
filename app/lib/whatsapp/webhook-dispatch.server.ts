import {
  enqueueInboundMessage,
  enqueueProviderStatus,
  enqueueTemplateStatus,
} from "./whatsapp-job-publisher.server";
import { createTemplateStatusObservation } from "./template-status-observation-id.server";
import { preflightWhatsAppWebhook } from "./webhook-preflight";

export type WhatsAppDispatchOutcome = "accepted" | "invalid_payload";

type WhatsAppPublishers = {
  enqueueInboundMessage: typeof enqueueInboundMessage;
  enqueueProviderStatus: typeof enqueueProviderStatus;
  enqueueTemplateStatus: typeof enqueueTemplateStatus;
};

const productionPublishers: WhatsAppPublishers = {
  enqueueInboundMessage,
  enqueueProviderStatus,
  enqueueTemplateStatus,
};

export async function dispatchWhatsAppWebhook(
  payload: unknown,
  publishers: WhatsAppPublishers = productionPublishers,
): Promise<WhatsAppDispatchOutcome> {
  const prepared = preflightWhatsAppWebhook(payload);
  if (!prepared.valid) return "invalid_payload";

  for (const item of prepared.events) {
    if (item.kind === "inbound") {
      await publishers.enqueueInboundMessage(item.event);
    } else if (item.kind === "status") {
      await publishers.enqueueProviderStatus(item.event);
    } else {
      await publishers.enqueueTemplateStatus(createTemplateStatusObservation(item.event));
    }
  }

  return "accepted";
}
