import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  accountingConnections,
  accountingSyncLog,
  stripeInvoices,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { loadConfig } from "../config.js";
import { randomUUID } from "node:crypto";

export function accountingService(db: Db) {
  return {
    initiateOAuthFlow: async (
      companyId: string,
      provider: string,
      redirectUrl: string,
    ) => {
      const config = loadConfig();
      const state = Buffer.from(
        JSON.stringify({ companyId, nonce: randomUUID() }),
      ).toString("base64url");

      let authorizationUrl: string;

      if (provider === "quickbooks_online") {
        const clientId =
          process.env.QUICKBOOKS_CLIENT_ID ?? "QUICKBOOKS_CLIENT_ID";
        authorizationUrl =
          `https://appcenter.intuit.com/connect/oauth2?` +
          `client_id=${encodeURIComponent(clientId)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent("com.intuit.quickbooks.accounting")}` +
          `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
          `&state=${encodeURIComponent(state)}`;
      } else if (provider === "xero") {
        const clientId = process.env.XERO_CLIENT_ID ?? "XERO_CLIENT_ID";
        authorizationUrl =
          `https://login.xero.com/identity/connect/authorize?` +
          `client_id=${encodeURIComponent(clientId)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent("openid profile email accounting.transactions accounting.settings")}` +
          `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
          `&state=${encodeURIComponent(state)}`;
      } else {
        throw unprocessable(`Unsupported accounting provider: ${provider}`);
      }

      return { authorizationUrl, state };
    },

    handleOAuthCallback: async (
      companyId: string,
      provider: string,
      code: string,
      state: string,
    ) => {
      // In production, exchange code for tokens using the provider's OAuth endpoint.
      // For now, store the code and mark as connected.
      const [existing] = await db
        .select()
        .from(accountingConnections)
        .where(
          and(
            eq(accountingConnections.companyId, companyId),
            eq(accountingConnections.provider, provider),
          ),
        )
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(accountingConnections)
          .set({
            status: "connected",
            accessToken: code, // Placeholder: would be exchanged token
            tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
            updatedAt: new Date(),
          })
          .where(eq(accountingConnections.id, existing.id))
          .returning();
        return updated;
      }

      const [record] = await db
        .insert(accountingConnections)
        .values({
          companyId,
          provider,
          status: "connected",
          accessToken: code, // Placeholder: would be exchanged token
          tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        })
        .returning();

      return record;
    },

    refreshTokenIfNeeded: async (connectionId: string) => {
      const [connection] = await db
        .select()
        .from(accountingConnections)
        .where(eq(accountingConnections.id, connectionId))
        .limit(1);

      if (!connection) {
        throw notFound("Accounting connection not found");
      }

      // Check if token expires within 5 minutes
      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
      if (
        connection.tokenExpiresAt &&
        connection.tokenExpiresAt > fiveMinutesFromNow
      ) {
        return connection;
      }

      // Token needs refresh — in production, call the provider's refresh endpoint.
      // Placeholder: extend expiry.
      const [updated] = await db
        .update(accountingConnections)
        .set({
          tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
          updatedAt: new Date(),
        })
        .where(eq(accountingConnections.id, connectionId))
        .returning();

      return updated;
    },

    getConnections: async (companyId: string) => {
      const rows = await db
        .select()
        .from(accountingConnections)
        .where(eq(accountingConnections.companyId, companyId));

      return rows;
    },

    disconnect: async (connectionId: string) => {
      const [updated] = await db
        .update(accountingConnections)
        .set({
          status: "disconnected",
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(accountingConnections.id, connectionId))
        .returning();

      if (!updated) {
        throw notFound("Accounting connection not found");
      }

      return updated;
    },

    syncInvoicesToAccounting: async (
      companyId: string,
      connectionId: string,
    ) => {
      const [connection] = await db
        .select()
        .from(accountingConnections)
        .where(eq(accountingConnections.id, connectionId))
        .limit(1);

      if (!connection) {
        throw notFound("Accounting connection not found");
      }

      if (connection.status !== "connected") {
        throw unprocessable("Accounting connection is not active");
      }

      // Fetch unsynchronized stripe invoices for this company
      const invoices = await db
        .select()
        .from(stripeInvoices)
        .where(eq(stripeInvoices.companyId, companyId));

      // Determine which invoices haven't been synced yet
      const existingSyncEntries = await db
        .select()
        .from(accountingSyncLog)
        .where(
          and(
            eq(accountingSyncLog.companyId, companyId),
            eq(accountingSyncLog.connectionId, connectionId),
            eq(accountingSyncLog.entityType, "stripe_invoice"),
          ),
        );

      const syncedEntityIds = new Set(
        existingSyncEntries.map((e) => e.entityId),
      );
      const unsyncedInvoices = invoices.filter(
        (inv) => !syncedEntityIds.has(inv.id),
      );

      const errors: Array<{ invoiceId: string; error: string }> = [];

      for (const invoice of unsyncedInvoices) {
        try {
          // Create a sync log entry with status "pending"
          // Actual provider API calls would go to provider-specific adapters
          await db.insert(accountingSyncLog).values({
            companyId,
            connectionId,
            direction: "outbound",
            entityType: "stripe_invoice",
            entityId: invoice.id,
            status: "pending",
          });
        } catch (err: any) {
          errors.push({
            invoiceId: invoice.id,
            error: err.message ?? "Unknown error",
          });
        }
      }

      return { syncedCount: unsyncedInvoices.length - errors.length, errors };
    },

    getSyncLog: async (companyId: string, connectionId?: string) => {
      const conditions = [eq(accountingSyncLog.companyId, companyId)];

      if (connectionId) {
        conditions.push(eq(accountingSyncLog.connectionId, connectionId));
      }

      const rows = await db
        .select()
        .from(accountingSyncLog)
        .where(and(...conditions))
        .orderBy(desc(accountingSyncLog.createdAt));

      return rows;
    },

    getChartOfAccounts: async (connectionId: string) => {
      const [connection] = await db
        .select()
        .from(accountingConnections)
        .where(eq(accountingConnections.id, connectionId))
        .limit(1);

      if (!connection) {
        throw notFound("Accounting connection not found");
      }

      // Placeholder chart of accounts structure
      // Actual provider calls would be in accounting-providers/
      return {
        connectionId,
        provider: connection.provider,
        accounts: [
          { id: "revenue", name: "Revenue", type: "income" },
          { id: "cogs", name: "Cost of Goods Sold", type: "expense" },
          {
            id: "accounts_receivable",
            name: "Accounts Receivable",
            type: "asset",
          },
          {
            id: "accounts_payable",
            name: "Accounts Payable",
            type: "liability",
          },
        ],
        mapping: connection.chartOfAccountsMapping,
      };
    },

    updateAccountMapping: async (
      connectionId: string,
      mapping: Record<string, unknown>,
    ) => {
      const [updated] = await db
        .update(accountingConnections)
        .set({
          chartOfAccountsMapping: mapping,
          updatedAt: new Date(),
        })
        .where(eq(accountingConnections.id, connectionId))
        .returning();

      if (!updated) {
        throw notFound("Accounting connection not found");
      }

      return updated;
    },
  };
}
