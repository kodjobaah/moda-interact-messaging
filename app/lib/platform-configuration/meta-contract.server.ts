export const META_CONFIGURATION_KEY = "messaging.meta" as const;

export const DEPLOYMENT_ENVIRONMENTS = [
  "local",
  "test",
  "development",
  "staging",
  "production",
] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export type MetaWebhookCredentials = Readonly<{
  appSecret: string;
  verifyToken: string;
}>;

export type MetaConfigRow = Readonly<{
  environment: string;
  key: string;
  version: number;
  value: unknown;
}>;

export type MetaCredentialsSnapshot = Readonly<{
  key: typeof META_CONFIGURATION_KEY;
  version: number;
  value: MetaWebhookCredentials;
}>;

export type MetaConfigurationFailureCode =
  | "MISSING"
  | "DISABLED"
  | "INVALID"
  | "UNSEAL_FAILED"
  | "DB_UNAVAILABLE";

const FAILURE_MESSAGES: Record<MetaConfigurationFailureCode, string> = {
  MISSING: "Meta webhook configuration is missing.",
  DISABLED: "Meta webhook configuration is disabled.",
  INVALID: "Meta webhook configuration is invalid.",
  UNSEAL_FAILED: "Meta webhook configuration could not be unsealed.",
  DB_UNAVAILABLE: "Meta webhook configuration is unavailable.",
};

export class MetaConfigurationFailure extends Error {
  readonly code: MetaConfigurationFailureCode;

  constructor(code: MetaConfigurationFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "MetaConfigurationFailure";
    this.code = code;
  }
}

export interface MetaConfigRepository {
  readMeta(environment: string): Promise<MetaConfigRow | null>;
}

export interface MetaWebhookCredentialsReader {
  read(): Promise<MetaCredentialsSnapshot>;
}

export type MetaUnsealKeyringProvider = () => import(
  "@modainteract/moda-interact-shared/security/credentials/node"
).CredentialKeyring;

export function isDeploymentEnvironment(value: unknown): value is DeploymentEnvironment {
  return typeof value === "string" &&
    (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value);
}
