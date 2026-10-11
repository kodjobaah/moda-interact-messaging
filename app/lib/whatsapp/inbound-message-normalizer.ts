import { safeParseNormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";

import { asRecord, normalizeOccurredAt } from "./normalization-utils";

export function normalizeInboundMessageFromWebhook({
  entry,
  change,
  message,
}: {
  entry?: unknown;
  change?: unknown;
  message: unknown;
}): NormalizedWhatsAppInboundMessage | null {
  const entryRecord = asRecord(entry);
  const changeRecord = asRecord(change);
  const valueRecord = asRecord(changeRecord?.value);
  const metadataRecord = asRecord(valueRecord?.metadata);
  const messageRecord = asRecord(message);
  const audioRecord = asRecord(messageRecord?.audio);
  const contextRecord = asRecord(messageRecord?.context);
  const messageType = typeof messageRecord?.type === "string"
    ? messageRecord.type.trim()
    : "unknown";

  const content = messageType === "text"
    ? {
        type: "text" as const,
        text: asRecord(messageRecord?.text)?.body,
      }
    : messageType === "audio"
      ? {
          type: "audio" as const,
          mediaId: audioRecord?.id,
          mimeType: typeof audioRecord?.mime_type === "string"
            ? audioRecord.mime_type
            : null,
          sha256: typeof audioRecord?.sha256 === "string"
            ? audioRecord.sha256
            : null,
          voice: typeof audioRecord?.voice === "boolean"
            ? audioRecord.voice
            : null,
        }
      : {
          type: "unsupported" as const,
          providerType: messageType,
        };

  const result = safeParseNormalizedWhatsAppInboundMessage({
    schemaVersion: 1,
    provider: "whatsapp",
    providerAccountId: entryRecord?.id,
    providerPhoneNumberId: metadataRecord?.phone_number_id,
    providerMessageId: messageRecord?.id,
    customerPhone: messageRecord?.from,
    contextMessageId: contextRecord ? contextRecord.id : null,
    occurredAt: normalizeOccurredAt(messageRecord?.timestamp),
    content,
  });

  return result.success ? result.data : null;
}
