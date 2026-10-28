import { Buffer } from "node:buffer";
import {
  decryptCredential,
  type CredentialEnvelope,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import {
  isDeploymentEnvironment,
  META_CONFIGURATION_KEY,
  MetaConfigurationFailure,
  type MetaConfigRepository,
  type MetaConfigRow,
  type MetaCredentialsSnapshot,
  type MetaUnsealKeyringProvider,
  type MetaWebhookCredentials,
  type MetaWebhookCredentialsReader,
} from "./meta-contract.server";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SEALED_FIELDS = [
  "kind",
  "schemaVersion",
  "algorithm",
  "wrappingKeyId",
  "nonce",
  "ciphertext",
  "authTag",
].sort();
const DISABLED_FIELDS = ["kind", "schemaVersion"].sort();
const CREDENTIAL_FIELDS = ["appSecret", "verifyToken"].sort();

type MetaReaderLogger = Pick<StructuredLogger, "info" | "warn">;

function failure(code: ConstructorParameters<typeof MetaConfigurationFailure>[0]): never {
  throw new MetaConfigurationFailure(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value).sort();
  return ownKeys.length === keys.length &&
    ownKeys.every((key, index) => key === keys[index]);
}

function canonicalBase64(value: unknown, expectedLength?: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !BASE64_PATTERN.test(value)) {
    return failure("INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length === 0 || bytes.length > 8192 ||
      expectedLength !== undefined && bytes.length !== expectedLength) {
    return failure("INVALID");
  }
  return Uint8Array.from(bytes);
}

function parseEnvelope(value: unknown): CredentialEnvelope {
  if (!isRecord(value)) return failure("INVALID");
  if (value.kind === "disabled") {
    if (!hasExactKeys(value, DISABLED_FIELDS) || value.schemaVersion !== 1) {
      return failure("INVALID");
    }
    return failure("DISABLED");
  }
  if (!hasExactKeys(value, SEALED_FIELDS) || value.kind !== "sealed" ||
      value.schemaVersion !== 1 || value.algorithm !== "AES-256-GCM" ||
      typeof value.wrappingKeyId !== "string" || !KEY_ID_PATTERN.test(value.wrappingKeyId) ||
      ["__proto__", "prototype", "constructor"].includes(value.wrappingKeyId)) {
    return failure("INVALID");
  }
  return {
    keyId: value.wrappingKeyId,
    nonce: canonicalBase64(value.nonce, 12),
    ciphertext: canonicalBase64(value.ciphertext),
    authTag: canonicalBase64(value.authTag, 16),
  };
}

function validateRow(row: MetaConfigRow, environment: string): void {
  if (!isRecord(row) || row.environment !== environment || row.key !== META_CONFIGURATION_KEY ||
      !Number.isSafeInteger(row.version) || row.version < 1) {
    return failure("INVALID");
  }
}

function parseCredentials(plaintext: string): MetaWebhookCredentials {
  if (Buffer.byteLength(plaintext, "utf8") > 8192) return failure("INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return failure("INVALID");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, CREDENTIAL_FIELDS)) {
    return failure("INVALID");
  }
  for (const field of ["appSecret", "verifyToken"] as const) {
    const value = parsed[field];
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        Buffer.byteLength(value, "utf8") > 4096 || CONTROL_PATTERN.test(value)) {
      return failure("INVALID");
    }
  }
  return Object.freeze({
    appSecret: parsed.appSecret as string,
    verifyToken: parsed.verifyToken as string,
  });
}

function safeLog(
  logger: MetaReaderLogger | undefined,
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    logger?.[level](event, fields);
  } catch {
    // Logging failures must not change webhook admission behavior.
  }
}

export function createMetaWebhookCredentialsReader(input: {
  repository: MetaConfigRepository;
  environment: string;
  unsealKeyring: MetaUnsealKeyringProvider;
  logger?: MetaReaderLogger;
}): MetaWebhookCredentialsReader {
  if (!isDeploymentEnvironment(input.environment)) return failure("INVALID");

  return {
    async read(): Promise<MetaCredentialsSnapshot> {
      let version: number | undefined;
      try {
        const row = await input.repository.readMeta(input.environment);
        if (row === null) return failure("MISSING");
        validateRow(row, input.environment);
        version = row.version;

        const envelope = parseEnvelope(row.value);
        let keyring;
        try {
          keyring = input.unsealKeyring();
        } catch {
          return failure("UNSEAL_FAILED");
        }

        let plaintext: string;
        try {
          const aad = JSON.stringify([
            "moda-platform-config-v1",
            input.environment,
            META_CONFIGURATION_KEY,
            row.version,
            1,
          ]);
          plaintext = decryptCredential({ keyring, envelope, aad });
        } catch {
          return failure("UNSEAL_FAILED");
        }

        const credentials = parseCredentials(plaintext);
        const snapshot = Object.freeze({
          key: META_CONFIGURATION_KEY,
          version: row.version,
          value: credentials,
        });
        safeLog(input.logger, "info", "messaging.platform_configuration.read_succeeded", {
          key: META_CONFIGURATION_KEY,
          version: row.version,
        });
        return snapshot;
      } catch (error) {
        safeLog(input.logger, "warn", "messaging.platform_configuration.read_failed", {
          key: META_CONFIGURATION_KEY,
          reasonCode: error instanceof MetaConfigurationFailure ? error.code : "UNEXPECTED",
          ...(version === undefined ? {} : { version }),
          environment: input.environment,
        });
        throw error;
      }
    },
  };
}
