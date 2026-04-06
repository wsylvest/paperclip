import { z } from "zod";
import { ISSUE_KINDS, ISSUE_SCOPES, COMMENT_INTENTS } from "../constants.js";

export const createComposerThreadSchema = z.object({
  title: z.string().min(1).max(500),
  kind: z.enum(ISSUE_KINDS).default("strategy"),
  scope: z.enum(ISSUE_SCOPES).optional(),
  targetAgentId: z.string().uuid().optional(),
  content: z.string().min(1),
});

export type CreateComposerThread = z.infer<typeof createComposerThreadSchema>;

export const addComposerMessageSchema = z.object({
  content: z.string().min(1),
  intent: z.enum(COMMENT_INTENTS).optional(),
});

export type AddComposerMessage = z.infer<typeof addComposerMessageSchema>;

export const convertToTaskSchema = z.object({
  assigneeAgentId: z.string().uuid(),
});

export type ConvertToTask = z.infer<typeof convertToTaskSchema>;
