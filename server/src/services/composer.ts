import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueComments } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function composerService(db: Db) {
  return {
    createThread: async (
      companyId: string,
      userId: string,
      input: {
        title: string;
        kind: "strategy" | "question" | "decision";
        scope?: string;
        targetAgentId?: string;
        content: string;
      },
    ) => {
      const [issue] = await db
        .insert(issues)
        .values({
          companyId,
          title: input.title,
          kind: input.kind,
          scope: input.scope,
          targetAgentId: input.targetAgentId,
          createdByUserId: userId,
          status: "backlog",
        })
        .returning();

      await db.insert(issueComments).values({
        companyId,
        issueId: issue.id,
        authorUserId: userId,
        body: input.content,
        intent: "board_question",
      });

      return issue;
    },

    addMessage: async (
      companyId: string,
      issueId: string,
      userId: string,
      content: string,
      intent?: string,
    ) => {
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: userId,
          body: content,
          intent: intent ?? null,
        })
        .returning();

      return comment;
    },

    convertToTask: async (
      companyId: string,
      issueId: string,
      assigneeAgentId: string,
    ) => {
      const [updated] = await db
        .update(issues)
        .set({
          kind: "task",
          assigneeAgentId,
          status: "todo",
        })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .returning();

      if (!updated) throw notFound("Issue not found");

      return updated;
    },

    listThreads: async (
      companyId: string,
      filters?: { kind?: string; scope?: string },
    ) => {
      const conditions: ReturnType<typeof eq>[] = [eq(issues.companyId, companyId)];

      if (filters?.kind) {
        conditions.push(eq(issues.kind, filters.kind));
      } else {
        conditions.push(ne(issues.kind, "task"));
      }

      if (filters?.scope) {
        conditions.push(eq(issues.scope, filters.scope));
      }

      return db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(desc(issues.createdAt));
    },
  };
}
