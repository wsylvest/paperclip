-- Phase 1: Admin Governance & Multi-User Roles
-- Add invited_by and last_active_at to company_memberships
ALTER TABLE "company_memberships" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint

-- Create audit_events table
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"previous_state" jsonb,
	"new_state" jsonb,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Create audit_retention_policies table
CREATE TABLE "audit_retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"category" text NOT NULL,
	"retention_days" integer DEFAULT 365 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Create role_permission_templates table
CREATE TABLE "role_permission_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permission_keys" jsonb NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Foreign keys
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_retention_policies" ADD CONSTRAINT "audit_retention_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Indexes for audit_events
CREATE INDEX "audit_events_company_occurred_idx" ON "audit_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_company_category_occurred_idx" ON "audit_events" USING btree ("company_id","category","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_occurred_idx" ON "audit_events" USING btree ("actor_type","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint

-- Unique index for audit_retention_policies (for upsert)
CREATE UNIQUE INDEX "audit_retention_policies_company_category_uniq" ON "audit_retention_policies" USING btree ("company_id","category");
