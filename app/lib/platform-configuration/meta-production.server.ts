import { Pool } from "pg";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import {
  parseCredentialKeyring,
  resolveActiveCredentialKey,
} from "@modainteract/moda-interact-shared/security/credentials/node";

import {
  isDeploymentEnvironment,
  MetaConfigurationFailure,
  type MetaWebhookCredentialsReader,
} from "./meta-contract.server";
import { createPgMetaConfigRepository } from "./meta-repository.server";
import { createMetaWebhookCredentialsReader } from "./meta-reader.server";

const POOL_MAX = 2;
const CONNECTION_TIMEOUT_MS = 1_000;
const QUERY_TIMEOUT_MS = 2_000;

let pool: Pool | undefined;
let logger: StructuredLogger | undefined;
let productionReader: MetaWebhookCredentialsReader | undefined;

function productionLogger(environment: string): StructuredLogger {
  logger ??= createLogger({
    serviceName: "moda-interact-messaging",
    environment,
  });
  return logger;
}

function createProductionReader(): MetaWebhookCredentialsReader {
  const environment = process.env.DEPLOYMENT_ENVIRONMENT_NAME;
  if (!isDeploymentEnvironment(environment)) {
    throw new MetaConfigurationFailure("INVALID");
  }

  const appLogger = productionLogger(environment);
  const databaseUrl = process.env.DATABASE_URL;
  const repository = databaseUrl
    ? createPgMetaConfigRepository(getPool(databaseUrl, appLogger))
    : {
        async readMeta() {
          throw new MetaConfigurationFailure("DB_UNAVAILABLE");
        },
      };

  return createMetaWebhookCredentialsReader({
    repository,
    environment,
    unsealKeyring: () => loadDeploymentEncryptionKeyring(),
    logger: appLogger,
  });
}

/** Read only the unified deployment pair; persisted envelopes select historical keys. */
export function loadDeploymentEncryptionKeyring(environment: Readonly<NodeJS.ProcessEnv> = process.env) {
  try {
    const keyring = parseCredentialKeyring(environment.MODA_ENCRYPTION_KEYS_JSON);
    resolveActiveCredentialKey(keyring, environment.MODA_ENCRYPTION_ACTIVE_KEY_ID);
    return keyring;
  } catch {
    throw new MetaConfigurationFailure("UNSEAL_FAILED");
  }
}

function getPool(databaseUrl: string, appLogger: StructuredLogger): Pool {
  if (pool) return pool;
  const nextPool = new Pool({
    connectionString: databaseUrl,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
  });
  nextPool.on("error", () => {
    try {
      appLogger.warn("messaging.platform_configuration.pool_idle_error", {
        key: "messaging.meta",
        reasonCode: "DB_UNAVAILABLE",
      });
    } catch {
      // Pool error reporting cannot break request handling.
    }
  });
  pool = nextPool;
  return nextPool;
}

export function getProductionMetaWebhookCredentialsReader(): MetaWebhookCredentialsReader {
  return {
    read() {
      try {
        productionReader ??= createProductionReader();
        return productionReader.read();
      } catch (error) {
        if (error instanceof MetaConfigurationFailure) return Promise.reject(error);
        try {
          const environment = process.env.DEPLOYMENT_ENVIRONMENT_NAME;
          if (isDeploymentEnvironment(environment)) {
            productionLogger(environment).error(
              "messaging.platform_configuration.reader_initialization_failed",
              { reasonCode: "UNEXPECTED" },
            );
          }
        } catch {
          // Shared logger sink failures must not change the bounded failure response.
        }
        return Promise.reject(new MetaConfigurationFailure("DB_UNAVAILABLE"));
      }
    },
  };
}
