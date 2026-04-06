import { z } from "zod";
import { ACCOUNTING_PROVIDERS } from "../constants.js";

export const connectAccountingSchema = z.object({
  provider: z.enum(ACCOUNTING_PROVIDERS),
  redirectUrl: z.string().url(),
});

export type ConnectAccounting = z.infer<typeof connectAccountingSchema>;

export const updateChartMappingSchema = z.object({
  mapping: z.record(z.string(), z.string()),
});

export type UpdateChartMapping = z.infer<typeof updateChartMappingSchema>;

export const triggerSyncSchema = z.object({
  direction: z.enum(["push", "pull"] as const).default("push"),
  entityType: z.enum(["invoices", "expenses"] as const).optional(),
});

export type TriggerSync = z.infer<typeof triggerSyncSchema>;
