import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { composerApi } from "../api/composer";
import type { ComposerThread } from "../api/composer";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { MessageSquare, Plus, Send, ArrowRightLeft } from "lucide-react";

const KIND_LABELS: Record<string, string> = {
  strategy: "Strategy",
  question: "Question",
  decision: "Decision",
};

export function Composer() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState<string>("strategy");
  const [newContent, setNewContent] = useState("");
  const [messageContent, setMessageContent] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Composer" }]);
  }, [setBreadcrumbs]);

  const { data: threads, isLoading } = useQuery({
    queryKey: queryKeys.composer.threads(selectedCompanyId!),
    queryFn: () => composerApi.listThreads(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.composer.thread(selectedThreadId!),
    queryFn: () =>
      fetch(`/api/issues/${selectedThreadId}/comments`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    enabled: !!selectedThreadId,
  });

  const createThread = useMutation({
    mutationFn: () =>
      composerApi.createThread(selectedCompanyId!, {
        title: newTitle,
        kind: newKind,
        content: newContent,
      }),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.composer.threads(selectedCompanyId!),
      });
      setSelectedThreadId(thread.id);
      setShowNewThread(false);
      setNewTitle("");
      setNewContent("");
    },
  });

  const addMessage = useMutation({
    mutationFn: () =>
      composerApi.addMessage(selectedCompanyId!, selectedThreadId!, {
        content: messageContent,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.composer.thread(selectedThreadId!),
      });
      setMessageContent("");
    },
  });

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Thread list sidebar */}
      <div className="w-72 shrink-0 overflow-y-auto rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-semibold">Threads</h2>
          <button
            onClick={() => setShowNewThread(true)}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {!threads?.length ? (
          <div className="p-4 text-xs text-muted-foreground">No threads yet</div>
        ) : (
          <div className="divide-y">
            {threads.map((t: ComposerThread) => (
              <button
                key={t.id}
                onClick={() => {
                  setSelectedThreadId(t.id);
                  setShowNewThread(false);
                }}
                className={`w-full p-3 text-left text-sm hover:bg-muted ${
                  selectedThreadId === t.id ? "bg-muted" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                    {KIND_LABELS[t.kind] ?? t.kind}
                  </span>
                </div>
                <div className="mt-1 truncate font-medium">{t.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(t.createdAt).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main panel */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border bg-card">
        {showNewThread ? (
          <div className="flex flex-1 flex-col p-4">
            <h3 className="mb-4 text-lg font-semibold">New Thread</h3>
            <input
              className="mb-3 rounded border bg-background px-3 py-2 text-sm"
              placeholder="Thread title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <select
              className="mb-3 rounded border bg-background px-3 py-2 text-sm"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
            >
              <option value="strategy">Strategy</option>
              <option value="question">Question</option>
              <option value="decision">Decision</option>
            </select>
            <textarea
              className="mb-3 flex-1 rounded border bg-background px-3 py-2 text-sm"
              placeholder="What would you like to discuss?"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={() => createThread.mutate()}
                disabled={!newTitle.trim() || !newContent.trim() || createThread.isPending}
                className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Create Thread
              </button>
              <button
                onClick={() => setShowNewThread(false)}
                className="rounded px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : selectedThreadId ? (
          <>
            <div className="flex-1 overflow-y-auto p-4">
              {(comments as { id: string; body: string; intent: string | null; authorUserId: string | null; createdAt: string }[] | undefined)?.map(
                (c) => (
                  <div key={c.id} className="mb-3 rounded-lg border p-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{c.authorUserId ?? "Agent"}</span>
                      {c.intent && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                          {c.intent}
                        </span>
                      )}
                      <span>{new Date(c.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{c.body}</p>
                  </div>
                ),
              )}
            </div>
            <div className="flex gap-2 border-t p-3">
              <input
                className="flex-1 rounded border bg-background px-3 py-2 text-sm"
                placeholder="Type a message..."
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && messageContent.trim()) {
                    addMessage.mutate();
                  }
                }}
              />
              <button
                onClick={() => addMessage.mutate()}
                disabled={!messageContent.trim() || addMessage.isPending}
                className="rounded bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={MessageSquare}
              message="Select a thread from the sidebar or create a new one."
            />
          </div>
        )}
      </div>
    </div>
  );
}
