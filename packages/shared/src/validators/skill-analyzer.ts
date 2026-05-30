import { z } from "zod";

export const skillAnalyzerRequestSchema = z.object({
  taskTitle: z.string(),
  taskBody: z.string(),
  availableSkills: z.array(z.string()),
  availableMcpTools: z.array(z.string()),
});

export const skillAnalyzerResponseSchema = z.object({
  selectedSkills: z.array(z.string()),
  selectedMcpTools: z.array(z.string()),
  rationale: z.string(),
});

export type SkillAnalyzerRequest = z.infer<typeof skillAnalyzerRequestSchema>;
export type SkillAnalyzerResponse = z.infer<typeof skillAnalyzerResponseSchema>;
