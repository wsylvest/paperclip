CREATE TABLE "heartbeat_run_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_json" jsonb,
	"output_json" jsonb,
	"error_class" text,
	"planned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"mcp_server_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"request_payload_hash" text,
	"response_payload_hash" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_class" text,
	"cost_microcents" integer DEFAULT 0 NOT NULL,
	"approval_id" uuid
);
--> statement-breakpoint
CREATE TABLE "mcp_server_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid,
	"tool_allowlist" jsonb,
	"require_approval_tools" jsonb,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"endpoint" text NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_secret_ref" uuid,
	"capabilities" jsonb,
	"allowlist" jsonb,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_checked_at" timestamp with time zone,
	"consecutive_fails" integer DEFAULT 0 NOT NULL,
	"surcharge_microcents" integer DEFAULT 0 NOT NULL,
	"oauth_token_endpoint" text,
	"oauth_scopes" text,
	"oauth_resource" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"adapter_type" text,
	"input_cost_microcents_per_1k" integer NOT NULL,
	"cached_input_cost_microcents_per_1k" integer,
	"output_cost_microcents_per_1k" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "pre_run_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_run_stages" ADD CONSTRAINT "heartbeat_run_stages_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_grants" ADD CONSTRAINT "mcp_server_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_grants" ADD CONSTRAINT "mcp_server_grants_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_grants" ADD CONSTRAINT "mcp_server_grants_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_run_stages_run_idx" ON "heartbeat_run_stages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_stages_run_ordinal_uq" ON "heartbeat_run_stages" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "heartbeat_run_stages_run_status_idx" ON "heartbeat_run_stages" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "mcp_invocations_company_idx" ON "mcp_invocations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mcp_invocations_run_idx" ON "mcp_invocations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "mcp_invocations_server_idx" ON "mcp_invocations" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "mcp_invocations_started_idx" ON "mcp_invocations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "mcp_server_grants_company_idx" ON "mcp_server_grants" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mcp_server_grants_server_idx" ON "mcp_server_grants" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "mcp_server_grants_principal_idx" ON "mcp_server_grants" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_grants_server_principal_uq" ON "mcp_server_grants" USING btree ("mcp_server_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_company_idx" ON "mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_company_health_idx" ON "mcp_servers" USING btree ("company_id","health_status");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_company_name_uq" ON "mcp_servers" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "pricing_models_provider_model_idx" ON "pricing_models" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX "pricing_models_adapter_type_idx" ON "pricing_models" USING btree ("adapter_type");--> statement-breakpoint
CREATE INDEX "pricing_models_active_idx" ON "pricing_models" USING btree ("active");--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_stage_id_heartbeat_run_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."heartbeat_run_stages"("id") ON DELETE set null ON UPDATE no action;