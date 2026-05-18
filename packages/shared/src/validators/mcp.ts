import { z } from "zod";

const MCP_TRANSPORTS = ["stdio", "streamable_http", "sse_legacy"] as const;
const MCP_AUTH_TYPES = ["none", "bearer_ref", "oauth_ref", "signed_jwt"] as const;
const MCP_PRINCIPAL_TYPES = ["agent", "routine", "project", "company"] as const;

export const createMcpServerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional().nullable(),
  transport: z.enum(MCP_TRANSPORTS).default("streamable_http"),
  endpoint: z.string().trim().min(1).max(2048),
  authType: z.enum(MCP_AUTH_TYPES).default("none"),
  authSecretRef: z.string().uuid().optional().nullable(),
  capabilities: z.record(z.unknown()).optional().nullable(),
  allowlist: z.record(z.unknown()).optional().nullable(),
  surchargeMicrocents: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (value.authType !== "none" && !value.authSecretRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authSecretRef"],
      message: "authSecretRef is required when authType is not 'none'",
    });
  }
  if (value.authType === "none" && value.authSecretRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authSecretRef"],
      message: "authSecretRef must be null when authType is 'none'",
    });
  }
});

export type CreateMcpServer = z.infer<typeof createMcpServerSchema>;

export const updateMcpServerSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  transport: z.enum(MCP_TRANSPORTS).optional(),
  endpoint: z.string().trim().min(1).max(2048).optional(),
  authType: z.enum(MCP_AUTH_TYPES).optional(),
  authSecretRef: z.string().uuid().optional().nullable(),
  capabilities: z.record(z.unknown()).optional().nullable(),
  allowlist: z.record(z.unknown()).optional().nullable(),
  surchargeMicrocents: z.number().int().min(0).optional(),
});

export type UpdateMcpServer = z.infer<typeof updateMcpServerSchema>;

export const createMcpServerGrantSchema = z.object({
  mcpServerId: z.string().uuid(),
  principalType: z.enum(MCP_PRINCIPAL_TYPES),
  principalId: z.string().uuid().optional().nullable(),
  toolAllowlist: z.array(z.string()).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.principalType === "company" && value.principalId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["principalId"],
      message: "principalId must be null when principalType is 'company'",
    });
  }
  if (value.principalType !== "company" && !value.principalId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["principalId"],
      message: "principalId is required when principalType is not 'company'",
    });
  }
});

export type CreateMcpServerGrant = z.infer<typeof createMcpServerGrantSchema>;
