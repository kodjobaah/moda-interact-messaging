import {
  META_TEMPLATE_STATUS_SCHEMA_VERSION,
  MetaTemplateStatusObservationV2Schema,
  formatMetaTemplateStatusEventIdentity,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";
import type { MetaTemplateStatusObservationV2 } from "@modainteract/moda-interact-shared/whatsapp-template-events";

import { asRecord } from "./normalization-utils";

export type PreparedTemplateStatusFields = Omit<MetaTemplateStatusObservationV2, "eventIdentity">;

// A fixed, valid v4 UUID gives preflight a byte-for-byte equivalent wire size
// without allocating an occurrence ID until the *whole* batch is valid.
const PREFLIGHT_OBSERVATION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PREFLIGHT_EVENT_IDENTITY = formatMetaTemplateStatusEventIdentity(PREFLIGHT_OBSERVATION_ID);
const DECIMAL_ID = /^[0-9]{1,32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function decimalProviderId(value: unknown): string | null {
  if (typeof value === "string") return DECIMAL_ID.test(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function boundedProviderText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  if (value.trim() !== value || CONTROL_CHARACTERS.test(value)) return null;
  return value;
}

/**
 * Only maps one already-authenticated Meta status change into transport fields.
 * It does not interpret provider approval, resolve a shop or read Meta/database.
 * Null means a malformed matching change: preflight rejects the entire batch.
 */
export function normalizeTemplateStatusChange({
  entry,
  change,
  receivedAt = new Date(),
}: {
  entry: unknown;
  change: unknown;
  receivedAt?: Date;
}): PreparedTemplateStatusFields | null {
  const entryRecord = asRecord(entry);
  const value = asRecord(asRecord(change)?.value);
  if (!value) return null;

  const wabaId = decimalProviderId(entryRecord?.id);
  const providerTemplateId = value.message_template_id == null
    ? null
    : decimalProviderId(value.message_template_id);
  const providerTemplateName = boundedProviderText(value.message_template_name, 255);
  const providerLanguageCode = boundedProviderText(value.message_template_language, 16);
  const providerStatus = boundedProviderText(value.event, 32);
  const reasonCode = value.reason == null ? null : boundedProviderText(value.reason, 128);

  if (!wabaId || (value.message_template_id != null && !providerTemplateId)
    || !providerTemplateName || !providerLanguageCode || !providerStatus
    || (value.reason != null && reasonCode === null)) return null;

  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) return null;
  const candidate = {
    schemaVersion: META_TEMPLATE_STATUS_SCHEMA_VERSION,
    eventIdentity: PREFLIGHT_EVENT_IDENTITY,
    wabaId,
    providerTemplateId,
    providerTemplateName,
    providerLanguageCode,
    providerStatus,
    reasonCode,
    receivedAt: receivedAt.toISOString(),
  };
  // Shared enforces exact own-key set, canonical time and <= 4096 UTF-8 bytes.
  // The generated identity always has this placeholder's exact byte length.
  const result = MetaTemplateStatusObservationV2Schema.safeParse(candidate);
  if (!result.success) return null;
  const { eventIdentity: _validatedIdentity, ...fields } = result.data;
  return fields;
}
