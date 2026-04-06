import { api } from "./client";

export interface ComposerThread {
  id: string;
  title: string;
  kind: string;
  scope: string | null;
  targetAgentId: string | null;
  status: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface ComposerMessage {
  id: string;
  issueId: string;
  body: string;
  intent: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

export const composerApi = {
  createThread: (companyId: string, input: { title: string; kind?: string; scope?: string; targetAgentId?: string; content: string }) =>
    api.post<ComposerThread>(`/companies/${companyId}/composer/threads`, input),
  listThreads: (companyId: string, kind?: string, scope?: string) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (scope) params.set("scope", scope);
    const qs = params.toString();
    return api.get<ComposerThread[]>(`/companies/${companyId}/composer/threads${qs ? `?${qs}` : ""}`);
  },
  addMessage: (companyId: string, threadId: string, input: { content: string; intent?: string }) =>
    api.post<ComposerMessage>(`/companies/${companyId}/composer/threads/${threadId}/messages`, input),
  convertToTask: (companyId: string, threadId: string, input: { assigneeAgentId: string }) =>
    api.post<ComposerThread>(`/companies/${companyId}/composer/threads/${threadId}/convert-to-task`, input),
};
