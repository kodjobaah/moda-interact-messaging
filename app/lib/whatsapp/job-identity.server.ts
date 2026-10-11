import crypto from "node:crypto";

import { WHATSAPP_PROVIDER_STATUS_SCHEMA_VERSION } from "@modainteract/moda-interact-shared/billing";
import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";

export function createJobId(providerMessageId: string): string {
  return (
    "wa-" + crypto.createHash("sha256").update(providerMessageId).digest("hex")
  );
}

export function createStatusJobId(event: NormalizedWhatsAppStatus): string {
  const identity = `${event.providerAccountId}:${event.providerPhoneNumberId}:${event.providerMessageId}:${event.status}`;
  const failureEvidence = event.schemaVersion === WHATSAPP_PROVIDER_STATUS_SCHEMA_VERSION
    && event.status === "FAILED"
    ? event.failure?.providerCode
    : undefined;

  return (
    "ws-" + crypto.createHash("sha256")
      .update(failureEvidence ? `${identity}:failure:${failureEvidence}` : identity)
      .digest("hex").slice(0, 61)
  );
}
