CREATE TABLE IF NOT EXISTS "deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "work_product_id" uuid,
  "issue_id" uuid,
  "agent_id" uuid,
  "environment" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "url" text,
  "provider" text,
  "external_deploy_id" text,
  "commit_sha" text,
  "health_check_url" text,
  "health_status" text DEFAULT 'unknown' NOT NULL,
  "last_health_check_at" timestamp with time zone,
  "metadata" jsonb,
  "deployed_at" timestamp with time zone,
  "rolled_back_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_sandboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "execution_workspace_id" uuid,
  "agent_id" uuid,
  "provider" text NOT NULL,
  "external_sandbox_id" text,
  "status" text DEFAULT 'provisioning' NOT NULL,
  "template_id" text,
  "region" text,
  "cpu_cores" integer,
  "memory_mb" integer,
  "timeout_seconds" integer,
  "last_activity_at" timestamp with time zone,
  "cost_accumulated_cents" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "maximizer_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "maximizer_config" jsonb;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autonomy_level" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "parallel_execution_limit" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deployments" ADD CONSTRAINT "deployments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deployments" ADD CONSTRAINT "deployments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deployments" ADD CONSTRAINT "deployments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_sandboxes" ADD CONSTRAINT "cloud_sandboxes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_sandboxes" ADD CONSTRAINT "cloud_sandboxes_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_sandboxes" ADD CONSTRAINT "cloud_sandboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_company_status_idx" ON "deployments" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_company_issue_idx" ON "deployments" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_sandboxes_company_status_idx" ON "cloud_sandboxes" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_sandboxes_company_agent_idx" ON "cloud_sandboxes" USING btree ("company_id","agent_id");
