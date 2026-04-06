import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { secretProviderConfigs } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { awsSecretsManagerProvider } from "./external-secrets/aws-secrets-manager.js";
import { gcpSecretManagerProvider } from "./external-secrets/gcp-secret-manager.js";
import { vaultProvider } from "./external-secrets/vault.js";

function resolveProvider(provider: string, config: Record<string, string>) {
  switch (provider) {
    case "aws_secrets_manager":
      return awsSecretsManagerProvider(config);
    case "gcp_secret_manager":
      return gcpSecretManagerProvider(config);
    case "vault":
      return vaultProvider(config);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function secretProviderConfigService(db: Db) {
  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(secretProviderConfigs)
        .where(eq(secretProviderConfigs.companyId, companyId));
    },

    configure: async (
      companyId: string,
      input: { provider: string; config: Record<string, string> },
    ) => {
      // Check for existing config with same provider
      const [existing] = await db
        .select()
        .from(secretProviderConfigs)
        .where(
          and(
            eq(secretProviderConfigs.companyId, companyId),
            eq(secretProviderConfigs.provider, input.provider),
          ),
        )
        .limit(1);

      if (existing) {
        const [row] = await db
          .update(secretProviderConfigs)
          .set({
            config: input.config,
            status: "configured",
            testError: null,
            updatedAt: new Date(),
          })
          .where(eq(secretProviderConfigs.id, existing.id))
          .returning();
        return row;
      }

      const [row] = await db
        .insert(secretProviderConfigs)
        .values({
          companyId,
          provider: input.provider,
          config: input.config,
          status: "configured",
        })
        .returning();
      return row;
    },

    testConnection: async (companyId: string, configId: string) => {
      const [row] = await db
        .select()
        .from(secretProviderConfigs)
        .where(
          and(
            eq(secretProviderConfigs.id, configId),
            eq(secretProviderConfigs.companyId, companyId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Secret provider config not found");

      const adapter = resolveProvider(
        row.provider,
        (row.config as Record<string, string>) ?? {},
      );
      const result = await adapter.testConnection();

      const [updated] = await db
        .update(secretProviderConfigs)
        .set({
          lastTestedAt: new Date(),
          testError: result.ok ? null : (result.error ?? "Unknown error"),
          status: result.ok ? "active" : "error",
          updatedAt: new Date(),
        })
        .where(eq(secretProviderConfigs.id, configId))
        .returning();

      return updated;
    },

    remove: async (companyId: string, configId: string) => {
      const [row] = await db
        .delete(secretProviderConfigs)
        .where(
          and(
            eq(secretProviderConfigs.id, configId),
            eq(secretProviderConfigs.companyId, companyId),
          ),
        )
        .returning();
      if (!row) throw notFound("Secret provider config not found");
      return row;
    },
  };
}
