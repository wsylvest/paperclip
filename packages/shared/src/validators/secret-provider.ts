import { z } from "zod";
import { SECRET_PROVIDER_TYPES } from "../constants.js";

export const configureProviderSchema = z.object({
  provider: z.enum(SECRET_PROVIDER_TYPES),
  config: z.record(z.string(), z.string()),
});
export type ConfigureProvider = z.infer<typeof configureProviderSchema>;
