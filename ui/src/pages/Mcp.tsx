import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Edit3,
  ExternalLink,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  Agent,
  CompanySecret,
  McpAuthType,
  McpHealthCheckResult,
  McpHealthStatus,
  McpInvocation,
  McpInvocationStatus,
  McpPrincipalType,
  McpServer,
  McpServerGrant,
  McpServerSuggestion,
  McpTransport,
  Project,
  RoutineListItem,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import {
  mcpApi,
  type CreateMcpServerGrantInput,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from "../api/mcp";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "../lib/utils";

const TRANSPORTS: { value: McpTransport; label: string; helper?: string }[] = [
  { value: "streamable_http", label: "HTTP" },
  { value: "sse_legacy", label: "SSE" },
  { value: "stdio", label: "stdio", helper: "Not yet supported by the gateway" },
];

const AUTH_TYPES: { value: McpAuthType; label: string; helper?: string }[] = [
  { value: "none", label: "None" },
  { value: "bearer_ref", label: "Bearer (secret ref)" },
  { value: "oauth_ref", label: "OAuth 2.1 Client Credentials" },
  { value: "signed_jwt", label: "Signed JWT", helper: "Not yet supported" },
];

const PRINCIPAL_TYPES: { value: McpPrincipalType; label: string }[] = [
  { value: "company", label: "Whole company" },
  { value: "agent", label: "Agent" },
  { value: "routine", label: "Routine" },
  { value: "project", label: "Project" },
];

const INVOCATION_STATUSES: McpInvocationStatus[] = [
  "pending",
  "succeeded",
  "failed",
  "denied",
  "approval_pending",
];

interface ServerFormState {
  name: string;
  description: string;
  transport: McpTransport;
  endpoint: string;
  authType: McpAuthType;
  authSecretRef: string;
  allowlist: string;
  oauthTokenEndpoint: string;
  oauthScopes: string;
  oauthResource: string;
}

function emptyServerForm(): ServerFormState {
  return {
    name: "",
    description: "",
    transport: "streamable_http",
    endpoint: "",
    authType: "none",
    authSecretRef: "",
    allowlist: "",
    oauthTokenEndpoint: "",
    oauthScopes: "",
    oauthResource: "",
  };
}

function serverToForm(server: McpServer): ServerFormState {
  let allowlistText = "";
  if (server.allowlist && typeof server.allowlist === "object") {
    const tools = (server.allowlist as { tools?: unknown }).tools;
    if (Array.isArray(tools)) {
      allowlistText = tools.filter((t): t is string => typeof t === "string").join(", ");
    }
  }
  return {
    name: server.name,
    description: server.description ?? "",
    transport: server.transport,
    endpoint: server.endpoint,
    authType: server.authType,
    authSecretRef: server.authSecretRef ?? "",
    allowlist: allowlistText,
    oauthTokenEndpoint: server.oauthTokenEndpoint ?? "",
    oauthScopes: server.oauthScopes ?? "",
    oauthResource: server.oauthResource ?? "",
  };
}

function parseAllowlistInput(value: string): Record<string, unknown> | null {
  const tools = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tools.length === 0) return null;
  return { tools };
}

function transportLabel(transport: McpTransport): string {
  return TRANSPORTS.find((t) => t.value === transport)?.label ?? transport;
}

function authTypeLabel(authType: McpAuthType): string {
  return AUTH_TYPES.find((a) => a.value === authType)?.label ?? authType;
}

function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "Never";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function healthBadgeClasses(status: McpHealthStatus): string {
  switch (status) {
    case "healthy":
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400";
    case "degraded":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400";
    case "dead":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  }
}

function invocationStatusClasses(status: McpInvocationStatus): string {
  switch (status) {
    case "succeeded":
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400";
    case "failed":
    case "denied":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400";
    case "approval_pending":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400";
    case "pending":
      return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  }
}

function formatMicrocents(microcents: number): string {
  const dollars = microcents / 1_000_000;
  return `$${dollars.toFixed(4)}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function Mcp() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [form, setForm] = useState<ServerFormState>(() => emptyServerForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [installTarget, setInstallTarget] = useState<McpServerSuggestion | null>(null);
  const [installEndpoint, setInstallEndpoint] = useState("");
  const [installSecretRef, setInstallSecretRef] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "MCP" }]);
  }, [setBreadcrumbs]);

  const serversQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.mcp.servers(selectedCompanyId)
      : ["mcp", "servers", "__disabled__"],
    queryFn: () => mcpApi.listServers(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled:
      Boolean(selectedCompanyId) && (createOpen || editing !== null || installTarget !== null),
  });

  const suggestionsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.mcp.suggestions(selectedCompanyId)
      : ["mcp", "suggestions", "__disabled__"],
    queryFn: () => mcpApi.listSuggestions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const servers = serversQuery.data ?? [];
  const secrets = secretsQuery.data ?? [];
  const suggestions = suggestionsQuery.data ?? [];

  function invalidateServers() {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers(selectedCompanyId) });
  }

  function invalidateSuggestions() {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.mcp.suggestions(selectedCompanyId) });
  }

  const installMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId || !installTarget) throw new Error("No suggestion selected");
      return mcpApi.installSuggestion(selectedCompanyId, installTarget.key, {
        endpoint: installEndpoint.trim() || undefined,
        authSecretRef:
          installTarget.authType === "none" ? undefined : installSecretRef || undefined,
      });
    },
    onSuccess: (created) => {
      pushToast({ title: "MCP server installed", body: created.name, tone: "success" });
      closeInstall();
      invalidateServers();
      invalidateSuggestions();
    },
    onError: (error) => {
      setInstallError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  function openInstall(suggestion: McpServerSuggestion) {
    setInstallTarget(suggestion);
    setInstallEndpoint(suggestion.endpoint);
    setInstallSecretRef("");
    setInstallError(null);
  }

  function closeInstall() {
    setInstallTarget(null);
    setInstallEndpoint("");
    setInstallSecretRef("");
    setInstallError(null);
  }

  function submitInstall() {
    if (!installTarget) return;
    if (!installEndpoint.trim()) {
      setInstallError("Endpoint is required");
      return;
    }
    if (installTarget.authType !== "none" && !installSecretRef) {
      setInstallError("Auth secret is required for this server");
      return;
    }
    installMutation.mutate();
  }

  const createMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      const input: CreateMcpServerInput = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        transport: form.transport,
        endpoint: form.endpoint.trim(),
        authType: form.authType,
        authSecretRef: form.authType === "none" ? null : form.authSecretRef || null,
        allowlist: parseAllowlistInput(form.allowlist),
        oauthTokenEndpoint: form.authType === "oauth_ref" ? form.oauthTokenEndpoint.trim() || null : null,
        oauthScopes: form.authType === "oauth_ref" ? form.oauthScopes.trim() || null : null,
        oauthResource: form.authType === "oauth_ref" ? form.oauthResource.trim() || null : null,
      };
      return mcpApi.createServer(selectedCompanyId, input);
    },
    onSuccess: (created) => {
      pushToast({ title: "MCP server registered", body: created.name, tone: "success" });
      setCreateOpen(false);
      setForm(emptyServerForm());
      setFormError(null);
      invalidateServers();
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId || !editing) throw new Error("No server selected");
      const patch: UpdateMcpServerInput = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        transport: form.transport,
        endpoint: form.endpoint.trim(),
        authType: form.authType,
        authSecretRef: form.authType === "none" ? null : form.authSecretRef || null,
        allowlist: parseAllowlistInput(form.allowlist),
        oauthTokenEndpoint: form.authType === "oauth_ref" ? form.oauthTokenEndpoint.trim() || null : null,
        oauthScopes: form.authType === "oauth_ref" ? form.oauthScopes.trim() || null : null,
        oauthResource: form.authType === "oauth_ref" ? form.oauthResource.trim() || null : null,
      };
      return mcpApi.updateServer(selectedCompanyId, editing.id, patch);
    },
    onSuccess: (updated) => {
      pushToast({ title: "MCP server updated", body: updated.name, tone: "success" });
      setEditing(null);
      setForm(emptyServerForm());
      setFormError(null);
      invalidateServers();
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return mcpApi.deleteServer(selectedCompanyId, id);
    },
    onSuccess: (_result, id) => {
      pushToast({ title: "MCP server deleted", tone: "info" });
      setDeleteTarget(null);
      if (expandedId === id) setExpandedId(null);
      invalidateServers();
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  async function probeServer(server: McpServer) {
    if (!selectedCompanyId) return;
    setProbingId(server.id);
    try {
      const result: McpHealthCheckResult = await mcpApi.probeServer(
        selectedCompanyId,
        server.id,
      );
      pushToast({
        title: "Probe complete",
        body: `${server.name}: ${result.status}`,
        tone: result.status === "healthy" ? "success" : "info",
      });
      invalidateServers();
    } catch (error) {
      pushToast({
        title: "Probe failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    } finally {
      setProbingId(null);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyServerForm());
    setFormError(null);
    setCreateOpen(true);
  }

  function openEdit(server: McpServer) {
    setEditing(server);
    setForm(serverToForm(server));
    setFormError(null);
    setCreateOpen(false);
  }

  function closeForm() {
    setCreateOpen(false);
    setEditing(null);
    setForm(emptyServerForm());
    setFormError(null);
  }

  function submitForm() {
    if (!form.name.trim()) {
      setFormError("Name is required");
      return;
    }
    if (!form.endpoint.trim()) {
      setFormError("Endpoint is required");
      return;
    }
    if (form.authType !== "none" && !form.authSecretRef) {
      setFormError("Auth secret is required when auth type is not 'none'");
      return;
    }
    if (form.authType === "oauth_ref" && !form.oauthTokenEndpoint.trim()) {
      setFormError("Token endpoint is required for OAuth auth type");
      return;
    }
    if (editing) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  }

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select a company to manage MCP servers.
      </div>
    );
  }

  const isFormOpen = createOpen || editing !== null;
  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">MCP Servers</h1>
          <div className="ml-auto">
            <Button onClick={openCreate} size="sm" data-testid="mcp-register-button">
              <Plus className="h-3.5 w-3.5 mr-1" /> Register server
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {serversQuery.isError ? (
            <div className="text-sm text-destructive flex items-center gap-2 py-4">
              <AlertCircle className="h-4 w-4" /> Failed to load MCP servers:{" "}
              {(serversQuery.error as Error).message}
              <Button variant="ghost" size="sm" onClick={() => serversQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : servers.length === 0 && !serversQuery.isPending ? (
            <EmptyState
              icon={Plug}
              message="No MCP servers registered yet. Register one to start routing tool calls through the gateway."
              action="Register server"
              onAction={openCreate}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 w-6"></th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-2 py-2 text-left font-medium">Transport</th>
                  <th className="px-2 py-2 text-left font-medium">Endpoint</th>
                  <th className="px-2 py-2 text-left font-medium">Auth</th>
                  <th className="px-2 py-2 text-left font-medium">Health</th>
                  <th className="px-2 py-2 text-left font-medium">Last checked</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => {
                  const isExpanded = expandedId === server.id;
                  return (
                    <ServerRow
                      key={server.id}
                      server={server}
                      isExpanded={isExpanded}
                      probing={probingId === server.id}
                      onToggle={() => setExpandedId(isExpanded ? null : server.id)}
                      onProbe={() => probeServer(server)}
                      onEdit={() => openEdit(server)}
                      onDelete={() => setDeleteTarget(server)}
                      companyId={selectedCompanyId}
                    />
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="mt-6 rounded-md border border-border/60" data-testid="mcp-suggestions">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
              onClick={() => setSuggestionsOpen((open) => !open)}
              aria-expanded={suggestionsOpen}
              aria-controls="mcp-suggestions-body"
              data-testid="mcp-suggestions-toggle"
            >
              {suggestionsOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Suggested servers</span>
              {suggestions.length > 0 ? (
                <span className="text-xs text-muted-foreground">({suggestions.length})</span>
              ) : null}
            </button>

            {suggestionsOpen ? (
              <div id="mcp-suggestions-body" className="border-t border-border/60 px-3 py-3">
                {suggestionsQuery.isError ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" /> Failed to load suggestions:{" "}
                    {(suggestionsQuery.error as Error).message}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => suggestionsQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : suggestionsQuery.isPending ? (
                  <div className="py-2 text-xs text-muted-foreground">Loading suggestions…</div>
                ) : suggestions.length === 0 ? (
                  <div className="py-2 text-xs text-muted-foreground">
                    No suggested servers available.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {suggestions.map((suggestion) => (
                      <SuggestionCard
                        key={suggestion.key}
                        suggestion={suggestion}
                        onInstall={() => openInstall(suggestion)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <Dialog
          open={isFormOpen}
          onOpenChange={(open) => {
            if (!open) closeForm();
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit MCP server" : "Register MCP server"}</DialogTitle>
              <DialogDescription>
                Configure an upstream MCP server. The gateway will route grants and probe health
                automatically.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <Field label="Name" required>
                <Input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="e.g. linear-mcp"
                  data-testid="mcp-form-name"
                />
              </Field>
              <Field label="Description">
                <Textarea
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                  rows={2}
                  placeholder="What this server provides"
                />
              </Field>
              <Field label="Transport" required>
                <Select
                  value={form.transport}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, transport: value as McpTransport }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSPORTS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {TRANSPORTS.find((t) => t.value === form.transport)?.helper ? (
                  <HelperText>{TRANSPORTS.find((t) => t.value === form.transport)!.helper}</HelperText>
                ) : null}
              </Field>
              <Field label="Endpoint" required>
                <Input
                  value={form.endpoint}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, endpoint: event.target.value }))
                  }
                  placeholder={form.transport === "stdio" ? "/usr/local/bin/mcp-server" : "https://example.com/mcp"}
                  data-testid="mcp-form-endpoint"
                />
              </Field>
              <Field label="Auth type" required>
                <Select
                  value={form.authType}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      authType: value as McpAuthType,
                      authSecretRef: value === "none" ? "" : current.authSecretRef,
                      oauthTokenEndpoint: value !== "oauth_ref" ? "" : current.oauthTokenEndpoint,
                      oauthScopes: value !== "oauth_ref" ? "" : current.oauthScopes,
                      oauthResource: value !== "oauth_ref" ? "" : current.oauthResource,
                    }))
                  }
                >
                  <SelectTrigger data-testid="mcp-form-auth-type-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTH_TYPES.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {AUTH_TYPES.find((a) => a.value === form.authType)?.helper ? (
                  <HelperText>{AUTH_TYPES.find((a) => a.value === form.authType)!.helper}</HelperText>
                ) : null}
              </Field>
              {form.authType === "bearer_ref" ? (
                <Field label="Auth secret" required>
                  <Select
                    value={form.authSecretRef}
                    onValueChange={(value) =>
                      setForm((current) => ({ ...current, authSecretRef: value }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a secret" />
                    </SelectTrigger>
                    <SelectContent>
                      {secrets.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          No secrets available
                        </div>
                      ) : (
                        secrets.map((secret: CompanySecret) => (
                          <SelectItem key={secret.id} value={secret.id}>
                            {secret.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              {form.authType === "oauth_ref" ? (
                <>
                  <Field label="OAuth secret (client credentials)" required>
                    <Select
                      value={form.authSecretRef}
                      onValueChange={(value) =>
                        setForm((current) => ({ ...current, authSecretRef: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a secret" />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No secrets available — create a secret with JSON: {`{ "client_id": "...", "client_secret": "..." }`}
                          </div>
                        ) : (
                          secrets.map((secret: CompanySecret) => (
                            <SelectItem key={secret.id} value={secret.id}>
                              {secret.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <HelperText>
                      Secret value must be a JSON object with <code>client_id</code> and <code>client_secret</code>.
                    </HelperText>
                  </Field>
                  <Field label="Token endpoint" required>
                    <Input
                      value={form.oauthTokenEndpoint}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, oauthTokenEndpoint: event.target.value }))
                      }
                      placeholder="https://auth.example.com/oauth/token"
                      data-testid="mcp-form-oauth-token-endpoint"
                    />
                    <HelperText>
                      OAuth 2.1 token endpoint for the Client Credentials flow.
                    </HelperText>
                  </Field>
                  <Field label="Scopes">
                    <Input
                      value={form.oauthScopes}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, oauthScopes: event.target.value }))
                      }
                      placeholder="mcp:tools mcp:resources"
                      data-testid="mcp-form-oauth-scopes"
                    />
                    <HelperText>Space-separated OAuth scopes to request.</HelperText>
                  </Field>
                  <Field label="Resource indicator">
                    <Input
                      value={form.oauthResource}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, oauthResource: event.target.value }))
                      }
                      placeholder="Defaults to endpoint URL (RFC 8707)"
                      data-testid="mcp-form-oauth-resource"
                    />
                    <HelperText>
                      RFC 8707 resource indicator. Binds the issued token to this server.
                      Leave empty to use the endpoint URL.
                    </HelperText>
                  </Field>
                </>
              ) : null}
              <Field label="Tool allowlist">
                <Input
                  value={form.allowlist}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, allowlist: event.target.value }))
                  }
                  placeholder="comma,separated,tools"
                />
                <HelperText>
                  Filters the upstream tool set. Leave empty to expose all discovered tools.
                </HelperText>
              </Field>

              {formError ? (
                <div className="text-xs text-destructive flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" /> {formError}
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={closeForm} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button onClick={submitForm} disabled={isSubmitting} data-testid="mcp-form-submit">
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : null}
                {editing ? "Save changes" : "Register"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete MCP server</DialogTitle>
              <DialogDescription>
                {deleteTarget
                  ? `This will delete "${deleteTarget.name}" and all its grants and invocation history. This cannot be undone.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
                disabled={deleteMutation.isPending}
                data-testid="mcp-confirm-delete"
              >
                {deleteMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : null}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={installTarget !== null}
          onOpenChange={(open) => {
            if (!open) closeInstall();
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add {installTarget?.name ?? "server"}</DialogTitle>
              <DialogDescription>
                {installTarget?.description ??
                  "Register this suggested MCP server with the gateway."}
              </DialogDescription>
            </DialogHeader>

            {installTarget ? (
              <div className="flex flex-col gap-3">
                <Field label="Endpoint" required>
                  <Input
                    value={installEndpoint}
                    onChange={(event) => setInstallEndpoint(event.target.value)}
                    placeholder="https://example.com/mcp"
                    data-testid="mcp-install-endpoint"
                  />
                  <HelperText>
                    Pre-filled from the suggestion. Edit to point at your own deployment.
                  </HelperText>
                </Field>
                {installTarget.authType !== "none" ? (
                  <Field label="Auth secret" required>
                    <Select
                      value={installSecretRef}
                      onValueChange={(value) => setInstallSecretRef(value)}
                    >
                      <SelectTrigger data-testid="mcp-install-secret-trigger">
                        <SelectValue placeholder="Select a secret" />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No secrets available
                          </div>
                        ) : (
                          secrets.map((secret: CompanySecret) => (
                            <SelectItem key={secret.id} value={secret.id}>
                              {secret.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    {installTarget.authHint ? (
                      <HelperText>{installTarget.authHint}</HelperText>
                    ) : null}
                  </Field>
                ) : null}

                {installError ? (
                  <div className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" /> {installError}
                  </div>
                ) : null}
              </div>
            ) : null}

            <DialogFooter>
              <Button
                variant="ghost"
                onClick={closeInstall}
                disabled={installMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={submitInstall}
                disabled={installMutation.isPending}
                data-testid="mcp-install-submit"
              >
                {installMutation.isPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Add server
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

interface ServerRowProps {
  server: McpServer;
  isExpanded: boolean;
  probing: boolean;
  onToggle: () => void;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
  companyId: string;
}

function ServerRow({
  server,
  isExpanded,
  probing,
  onToggle,
  onProbe,
  onEdit,
  onDelete,
  companyId,
}: ServerRowProps) {
  return (
    <>
      <tr
        className={cn(
          "border-b border-border/60 hover:bg-accent/40 cursor-pointer",
          isExpanded && "bg-accent/60",
        )}
        onClick={onToggle}
        data-testid={`mcp-row-${server.id}`}
      >
        <td className="px-2 py-2.5 text-muted-foreground">
          {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        <td className="px-3 py-2.5">
          <div className="font-medium text-foreground">{server.name}</div>
          {server.description ? (
            <div className="text-xs text-muted-foreground">{truncate(server.description, 80)}</div>
          ) : null}
        </td>
        <td className="px-2 py-2.5 text-xs text-muted-foreground">{transportLabel(server.transport)}</td>
        <td className="px-2 py-2.5 text-xs font-mono">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground">{truncate(server.endpoint, 36)}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md break-all">{server.endpoint}</TooltipContent>
          </Tooltip>
        </td>
        <td className="px-2 py-2.5 text-xs text-muted-foreground">{authTypeLabel(server.authType)}</td>
        <td className="px-2 py-2.5 text-xs">
          <span
            className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
              healthBadgeClasses(server.healthStatus),
            )}
            data-testid={`mcp-health-${server.id}`}
          >
            {server.healthStatus}
          </span>
          {server.consecutiveFails > 0 ? (
            <span className="ml-1.5 text-xs text-amber-600">{server.consecutiveFails} fails</span>
          ) : null}
        </td>
        <td className="px-2 py-2.5 text-xs text-muted-foreground">
          {formatRelative(server.healthCheckedAt)}
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={onProbe}
              disabled={probing}
              aria-label={`Probe ${server.name}`}
              data-testid={`mcp-probe-${server.id}`}
            >
              {probing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={onEdit}
              aria-label={`Edit ${server.name}`}
              data-testid={`mcp-edit-${server.id}`}
            >
              <Edit3 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label={`Delete ${server.name}`}
              data-testid={`mcp-delete-${server.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="bg-muted/20">
          <td colSpan={8} className="px-4 py-4">
            <ServerDrilldown server={server} companyId={companyId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

interface DrilldownProps {
  server: McpServer;
  companyId: string;
}

function ServerDrilldown({ server, companyId }: DrilldownProps) {
  const [tab, setTab] = useState<"grants" | "invocations">("grants");
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as "grants" | "invocations")}>
      <TabsList>
        <TabsTrigger value="grants">Grants</TabsTrigger>
        <TabsTrigger value="invocations">Recent invocations</TabsTrigger>
      </TabsList>
      <TabsContent value="grants" className="pt-3">
        <GrantsPanel server={server} companyId={companyId} />
      </TabsContent>
      <TabsContent value="invocations" className="pt-3">
        <InvocationsPanel server={server} companyId={companyId} />
      </TabsContent>
    </Tabs>
  );
}

interface GrantsPanelProps {
  server: McpServer;
  companyId: string;
}

function GrantsPanel({ server, companyId }: GrantsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [addOpen, setAddOpen] = useState(false);
  const [principalType, setPrincipalType] = useState<McpPrincipalType>("company");
  const [principalId, setPrincipalId] = useState<string>("");
  const [toolAllowlist, setToolAllowlist] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServerGrant | null>(null);

  const grantsQuery = useQuery({
    queryKey: queryKeys.mcp.grants(companyId, server.id),
    queryFn: () => mcpApi.listGrants(companyId, server.id),
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: principalType === "agent" || principalType === "routine" || principalType === "project" || true,
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });

  const agents: Agent[] = agentsQuery.data ?? [];
  const projects: Project[] = projectsQuery.data ?? [];
  const routines: RoutineListItem[] = routinesQuery.data ?? [];

  const grants = grantsQuery.data ?? [];

  const principalLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) map.set(`agent:${agent.id}`, agent.name);
    for (const project of projects) map.set(`project:${project.id}`, project.name);
    for (const routine of routines) map.set(`routine:${routine.id}`, routine.title);
    return map;
  }, [agents, projects, routines]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.mcp.grants(companyId, server.id) });
  }

  const createGrantMutation = useMutation({
    mutationFn: () => {
      const tools = toolAllowlist
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const input: CreateMcpServerGrantInput = {
        mcpServerId: server.id,
        principalType,
        principalId: principalType === "company" ? null : principalId || null,
        toolAllowlist: tools.length === 0 ? null : tools,
      };
      return mcpApi.createGrant(companyId, input);
    },
    onSuccess: () => {
      pushToast({ title: "Grant added", tone: "success" });
      setAddOpen(false);
      setPrincipalType("company");
      setPrincipalId("");
      setToolAllowlist("");
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  const deleteGrantMutation = useMutation({
    mutationFn: (id: string) => mcpApi.deleteGrant(companyId, id),
    onSuccess: () => {
      pushToast({ title: "Grant removed", tone: "info" });
      setConfirmDelete(null);
      invalidate();
    },
    onError: (err) => {
      pushToast({
        title: "Delete failed",
        body: err instanceof Error ? err.message : "Try again",
        tone: "error",
      });
    },
  });

  function submitGrant() {
    if (principalType !== "company" && !principalId) {
      setError("Principal is required for non-company grants");
      return;
    }
    createGrantMutation.mutate();
  }

  function principalLabel(grant: McpServerGrant): string {
    if (grant.principalType === "company") return "Whole company";
    const key = `${grant.principalType}:${grant.principalId}`;
    const resolved = principalLookup.get(key);
    return resolved
      ? `${grant.principalType}: ${resolved}`
      : `${grant.principalType}: ${grant.principalId ?? ""}`;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {grants.length} grant{grants.length === 1 ? "" : "s"}
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="mcp-add-grant-button">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add grant
        </Button>
      </div>

      {grantsQuery.isPending ? (
        <div className="text-xs text-muted-foreground">Loading grants…</div>
      ) : grants.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4">No grants yet for this server.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Principal</th>
              <th className="px-2 py-1.5 text-left font-medium">Tools</th>
              <th className="px-2 py-1.5 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => (
              <tr key={grant.id} className="border-t border-border/40" data-testid={`mcp-grant-${grant.id}`}>
                <td className="px-2 py-2 text-sm">{principalLabel(grant)}</td>
                <td className="px-2 py-2 text-xs text-muted-foreground">
                  {grant.toolAllowlist === null
                    ? "All tools allowed"
                    : grant.toolAllowlist.length === 0
                      ? "No tools"
                      : grant.toolAllowlist.join(", ")}
                </td>
                <td className="px-2 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive hover:text-destructive"
                    onClick={() => setConfirmDelete(grant)}
                    aria-label="Delete grant"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add grant</DialogTitle>
            <DialogDescription>
              Grant a principal the ability to call this server's tools through the gateway.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field label="Principal type" required>
              <Select
                value={principalType}
                onValueChange={(value) => {
                  setPrincipalType(value as McpPrincipalType);
                  setPrincipalId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRINCIPAL_TYPES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {principalType !== "company" ? (
              <Field label="Principal" required>
                <Select value={principalId} onValueChange={(value) => setPrincipalId(value)}>
                  <SelectTrigger data-testid="mcp-grant-principal-select">
                    <SelectValue placeholder={`Select a ${principalType}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {principalType === "agent"
                      ? agents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))
                      : principalType === "project"
                        ? projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))
                        : routines.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.title}
                            </SelectItem>
                          ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field label="Tool allowlist">
              <Input
                value={toolAllowlist}
                onChange={(event) => setToolAllowlist(event.target.value)}
                placeholder="comma,separated,tools"
              />
              <HelperText>Leave blank to inherit the server's allowlist.</HelperText>
            </Field>
            {error ? (
              <div className="text-xs text-destructive flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" /> {error}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitGrant}
              disabled={createGrantMutation.isPending}
              data-testid="mcp-grant-submit"
            >
              {createGrantMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : null}
              Add grant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove grant</DialogTitle>
            <DialogDescription>
              The principal will lose access to this MCP server immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && deleteGrantMutation.mutate(confirmDelete.id)}
              disabled={deleteGrantMutation.isPending}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface InvocationsPanelProps {
  server: McpServer;
  companyId: string;
}

const INVOCATION_PAGE_SIZE = 50;

function InvocationsPanel({ server, companyId }: InvocationsPanelProps) {
  const [statusFilter, setStatusFilter] = useState<McpInvocationStatus | "all">("all");
  const [pages, setPages] = useState<McpInvocation[][]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const baseOpts = useMemo(
    () => ({ serverId: server.id, limit: INVOCATION_PAGE_SIZE, beforeId: cursor }),
    [server.id, cursor],
  );

  const invocationsQuery = useQuery({
    queryKey: queryKeys.mcp.invocations(companyId, baseOpts),
    queryFn: () => mcpApi.listInvocations(companyId, baseOpts),
  });

  useEffect(() => {
    if (!invocationsQuery.data) return;
    setPages((current) => {
      // Only append when fetching for the active cursor and we haven't merged yet
      const last = current[current.length - 1];
      if (last && last === invocationsQuery.data) return current;
      if (cursor === undefined) return [invocationsQuery.data];
      return [...current, invocationsQuery.data];
    });
  }, [invocationsQuery.data, cursor]);

  // Reset on server change
  useEffect(() => {
    setPages([]);
    setCursor(undefined);
  }, [server.id]);

  const allInvocations = useMemo(() => {
    const merged = pages.flat();
    if (statusFilter === "all") return merged;
    return merged.filter((inv) => inv.status === statusFilter);
  }, [pages, statusFilter]);

  const latestPage = pages[pages.length - 1] ?? [];
  const canLoadMore = latestPage.length === INVOCATION_PAGE_SIZE;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setStatusFilter(value === "all" ? "all" : (value as McpInvocationStatus))
          }
        >
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {INVOCATION_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto text-xs text-muted-foreground">
          {allInvocations.length} shown
        </div>
      </div>

      {invocationsQuery.isPending && pages.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4">Loading invocations…</div>
      ) : allInvocations.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4">
          No invocations recorded for this server yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Started</th>
              <th className="px-2 py-1.5 text-left font-medium">Tool</th>
              <th className="px-2 py-1.5 text-left font-medium">Status</th>
              <th className="px-2 py-1.5 text-left font-medium">Cost</th>
              <th className="px-2 py-1.5 text-left font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {allInvocations.map((inv) => (
              <tr key={inv.id} className="border-t border-border/40">
                <td className="px-2 py-1.5 text-xs text-muted-foreground">
                  {formatRelative(inv.startedAt)}
                </td>
                <td className="px-2 py-1.5 font-mono text-xs">{inv.toolName}</td>
                <td className="px-2 py-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
                      invocationStatusClasses(inv.status),
                    )}
                  >
                    {inv.status}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-xs font-mono">
                  {formatMicrocents(inv.costMicrocents)}
                </td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground">
                  {inv.errorClass ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canLoadMore ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const lastEntry = latestPage[latestPage.length - 1];
              if (lastEntry) setCursor(lastEntry.id);
            }}
            disabled={invocationsQuery.isFetching}
          >
            {invocationsQuery.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface SuggestionCardProps {
  suggestion: McpServerSuggestion;
  onInstall: () => void;
}

function SuggestionCard({ suggestion, onInstall }: SuggestionCardProps) {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5"
      data-testid={`mcp-suggestion-${suggestion.key}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{suggestion.name}</span>
          <a
            href={suggestion.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-muted-foreground hover:text-foreground"
            aria-label={`Open ${suggestion.name} documentation`}
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{suggestion.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5">{suggestion.source}</span>
          <span className="rounded bg-muted px-1.5 py-0.5">
            {transportLabel(suggestion.transport)}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5">
            {authTypeLabel(suggestion.authType)}
          </span>
        </div>
      </div>
      <div className="shrink-0">
        {suggestion.alreadyRegistered ? (
          <span
            className="inline-flex items-center rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
            data-testid={`mcp-suggestion-registered-${suggestion.key}`}
          >
            Already registered
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onInstall}
            data-testid={`mcp-suggestion-add-${suggestion.key}`}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}

function Field({ label, required, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function HelperText({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}
