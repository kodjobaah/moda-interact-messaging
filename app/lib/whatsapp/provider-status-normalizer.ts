import {
  safeParseNormalizedWhatsAppStatus,
  WHATSAPP_PROVIDER_STATUS_SCHEMA_VERSION,
} from "@modainteract/moda-interact-shared/billing";
import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";

import { asRecord, normalizeOccurredAt } from "./normalization-utils";

export function normalizeProviderStatusFromWebhook({
  entry,
  change,
  status,
}: {
  entry?: unknown;
  change?: unknown;
  status: unknown;
}): NormalizedWhatsAppStatus | null {
  const entryRecord = asRecord(entry);
  const changeRecord = asRecord(change);
  const valueRecord = asRecord(changeRecord?.value);
  const metadataRecord = asRecord(valueRecord?.metadata);

  return normalizeProviderStatus({
    entryId: entryRecord?.id,
    phoneNumberId: metadataRecord?.phone_number_id,
    status,
  });
}

export function normalizeProviderStatus({
  entryId,
  phoneNumberId,
  status,
}: {
  entryId?: unknown;
  phoneNumberId?: unknown;
  status: unknown;
}): NormalizedWhatsAppStatus | null {
  const statusRecord = asRecord(status);
  const providerAccountId = typeof entryId === "string" ? entryId.trim() : "";
  const providerPhoneNumberId = typeof phoneNumberId === "string" ? phoneNumberId.trim() : "";
  const providerMessageId = typeof statusRecord?.id === "string" ? statusRecord.id.trim() : "";
  const normalizedStatus = normalizeProviderStatusName(statusRecord?.status);
  const occurredAt = normalizeOccurredAt(statusRecord?.timestamp);

  if (!providerAccountId || !providerPhoneNumberId || !providerMessageId || !normalizedStatus || !occurredAt) {
    return null;
  }

  const candidate = {
    schemaVersion: WHATSAPP_PROVIDER_STATUS_SCHEMA_VERSION,
    providerAccountId,
    providerPhoneNumberId,
    providerMessageId,
    status: normalizedStatus,
    occurredAt,
    pricing: normalizePricing(statusRecord?.pricing),
    ...(normalizedStatus === "FAILED"
      ? normalizeFailureEvidence(statusRecord?.errors)
      : {}),
  };
  if (!candidate.pricing) delete candidate.pricing;

  const parsed = safeParseNormalizedWhatsAppStatus(candidate);
  return parsed.success ? parsed.data : null;
}

function normalizeFailureEvidence(errors: unknown): { failure?: { providerCode: string } } {
  if (!Array.isArray(errors)) return {};

  for (const error of errors) {
    const errorRecord = asRecord(error);
    const code = errorRecord?.code;

    if (typeof code === "number" && Number.isFinite(code) && Number.isInteger(code)) {
      const providerCode = BigInt(code).toString(10);
      if (providerCode.length <= 64) {
        return { failure: { providerCode } };
      }
    }

    if (typeof code === "string") {
      const providerCode = code.trim();
      if (providerCode.length > 0 && providerCode.length <= 64) {
        return { failure: { providerCode } };
      }
    }
  }

  return {};
}

function normalizeProviderStatusName(value: unknown): NormalizedWhatsAppStatus["status"] | null {
  switch (value) {
    case "sent": return "SENT";
    case "delivered": return "DELIVERED";
    case "read": return "READ";
    case "failed": return "FAILED";
    default: return null;
  }
}

function normalizePricing(value: unknown): NormalizedWhatsAppStatus["pricing"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pricing = value as Record<string, unknown>;
  const normalized: NonNullable<NormalizedWhatsAppStatus["pricing"]> = {};
  if (typeof pricing.billable === "boolean") normalized.billable = pricing.billable;
  if (typeof pricing.category === "string" && pricing.category.length <= 64) normalized.category = pricing.category;
  if (typeof pricing.pricing_model === "string" && pricing.pricing_model.length <= 64) normalized.model = pricing.pricing_model;
  return Object.keys(normalized).length ? normalized : undefined;
}
