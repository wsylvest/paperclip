import { z } from "zod";
import { DEPLOYMENT_ENVIRONMENTS, DEPLOYMENT_PROVIDERS, DEPLOYMENT_STATUSES } from "../constants.js";

export const createDeploymentSchema = z.object({
  issueId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  workProductId: z.string().uuid().optional(),
  environment: z.enum(DEPLOYMENT_ENVIRONMENTS),
  provider: z.enum(DEPLOYMENT_PROVIDERS).optional(),
  url: z.string().url().optional(),
  commitSha: z.string().optional(),
  healthCheckUrl: z.string().url().optional(),
});
export type CreateDeployment = z.infer<typeof createDeploymentSchema>;

export const updateDeploymentStatusSchema = z.object({
  status: z.enum(DEPLOYMENT_STATUSES),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateDeploymentStatus = z.infer<typeof updateDeploymentStatusSchema>;
