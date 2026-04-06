import { z } from "zod";
import { REPORT_TYPES } from "../constants.js";

export const reportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  granularity: z.enum(["daily", "weekly", "monthly"] as const).default("daily"),
  agentId: z.string().uuid().optional(),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportExportSchema = z.object({
  type: z.enum(REPORT_TYPES),
  format: z.enum(["csv", "json"] as const).default("csv"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type ReportExport = z.infer<typeof reportExportSchema>;
