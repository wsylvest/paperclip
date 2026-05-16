-- MCP gateway tables. The snapshot at meta/0085_snapshot.json was also
-- caught up to reflect tables created by migrations 0083 / 0084 whose
-- drizzle snapshots had been omitted; this migration itself only ships
-- the MCP DDL so existing DBs are not double-CREATE'd.
CREATE TABLE IF NOT EXISTS "mcp_invocations" (
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
CREATE TABLE IF NOT EXISTS "mcp_server_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid,
	"tool_allowlist" jsonb,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_servers" (
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
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocations" ADD CONSTRAINT "mcp_invocations_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_grants" ADD CONSTRAINT "mcp_server_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_grants" ADD CONSTRAINT "mcp_server_grants_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_grants" ADD CONSTRAINT "mcp_server_grants_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_invocations_company_idx" ON "mcp_invocations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_invocations_run_idx" ON "mcp_invocations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_invocations_server_idx" ON "mcp_invocations" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_invocations_started_idx" ON "mcp_invocations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_server_grants_company_idx" ON "mcp_server_grants" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_server_grants_server_idx" ON "mcp_server_grants" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_server_grants_principal_idx" ON "mcp_server_grants" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_server_grants_server_principal_uq" ON "mcp_server_grants" USING btree ("mcp_server_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_company_idx" ON "mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_company_health_idx" ON "mcp_servers" USING btree ("company_id","health_status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_company_name_uq" ON "mcp_servers" USING btree ("company_id","name");
