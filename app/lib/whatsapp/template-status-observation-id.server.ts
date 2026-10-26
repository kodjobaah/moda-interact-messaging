import { randomUUID } from "node:crypto";

import {
  MetaTemplateStatusObservationV2Schema,
  formatMetaTemplateStatusEventIdentity,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";
import type { MetaTemplateStatusObservationV2 } from "@modainteract/moda-interact-shared/whatsapp-template-events";

import type { PreparedTemplateStatusFields } from "./template-status-normalizer";

/** Create one new observation identity only after whole-batch preflight succeeds. */
export function createTemplateStatusObservation(
  fields: PreparedTemplateStatusFields,
  observationId: string = randomUUID(),
): MetaTemplateStatusObservationV2 {
  return MetaTemplateStatusObservationV2Schema.parse({
    ...fields,
    eventIdentity: formatMetaTemplateStatusEventIdentity(observationId),
  });
}
