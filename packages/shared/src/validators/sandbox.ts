import { z } from "zod";
import { SANDBOX_PROVIDERS } from "../constants.js";

export const provisionSandboxSchema = z.object({
  agentId: z.string().uuid().optional(),
  provider: z.enum(SANDBOX_PROVIDERS),
  templateId: z.string().optional(),
  region: z.string().optional(),
  cpuCores: z.number().int().min(1).max(16).optional(),
  memoryMb: z.number().int().min(256).max(32768).optional(),
  timeoutSeconds: z.number().int().min(60).max(86400).optional(),
});
export type ProvisionSandbox = z.infer<typeof provisionSandboxSchema>;

export const extendSandboxSchema = z.object({
  additionalSeconds: z.number().int().min(60).max(86400),
});
export type ExtendSandbox = z.infer<typeof extendSandboxSchema>;
