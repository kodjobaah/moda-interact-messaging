import type { Pool } from "pg";

import {
  META_CONFIGURATION_KEY,
  isDeploymentEnvironment,
  MetaConfigurationFailure,
  type MetaConfigRepository,
  type MetaConfigRow,
} from "./meta-contract.server";

const META_CONFIG_SQL = `
SELECT "environment", "key", "version", "value"
FROM public."PlatformConfiguration"
WHERE "environment" = $1 AND "key" = $2
LIMIT 2
`;

export function createPgMetaConfigRepository(
  db: Pick<Pool, "query">,
): MetaConfigRepository {
  return {
    async readMeta(environment: string): Promise<MetaConfigRow | null> {
      if (!isDeploymentEnvironment(environment)) {
        throw new MetaConfigurationFailure("INVALID");
      }
      try {
        const result = await db.query<MetaConfigRow>(META_CONFIG_SQL, [
          environment,
          META_CONFIGURATION_KEY,
        ]);
        if (result.rows.length > 1) {
          throw new MetaConfigurationFailure("DB_UNAVAILABLE");
        }
        return result.rows[0] ?? null;
      } catch (error) {
        if (error instanceof MetaConfigurationFailure) throw error;
        throw new MetaConfigurationFailure("DB_UNAVAILABLE");
      }
    },
  };
}
