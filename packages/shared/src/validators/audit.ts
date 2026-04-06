import { z } from "zod";
import { AUDIT_CATEGORIES, AUDIT_SEVERITIES } from "../constants.js";

export const auditEventQuerySchema = z.object({
  category: z.enum(AUDIT_CATEGORIES).optional(),
  severity: z.enum(AUDIT_SEVERITIES).optional(),
  actorType: z.enum(["user", "agent", "system"] as const).optional(),
  actorId: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;

export const auditExportQuerySchema = z.object({
  category: z.enum(AUDIT_CATEGORIES).optional(),
  severity: z.enum(AUDIT_SEVERITIES).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(["csv", "json"] as const).default("csv"),
});

export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

export const upsertAuditRetentionPolicySchema = z.object({
  category: z.enum(AUDIT_CATEGORIES),
  retentionDays: z.number().int().min(1).max(3650),
  isActive: z.boolean().default(true),
});

export type UpsertAuditRetentionPolicy = z.infer<typeof upsertAuditRetentionPolicySchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(["owner", "admin", "member", "viewer"] as const),
});

export type UpdateMemberRole = z.infer<typeof updateMemberRoleSchema>;

export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().min(1),
});

export type TransferOwnership = z.infer<typeof transferOwnershipSchema>;
