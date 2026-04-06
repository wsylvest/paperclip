-- Phase 2: Reporting, Analytics & CEO Chat
ALTER TABLE "issues" ADD COLUMN "kind" text NOT NULL DEFAULT 'task';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "target_agent_id" uuid REFERENCES "public"."agents"("id");--> statement-breakpoint

ALTER TABLE "issue_comments" ADD COLUMN "intent" text;--> statement-breakpoint

CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"report_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");--> statement-breakpoint

CREATE INDEX "report_snapshots_company_report_period_idx" ON "report_snapshots" USING btree ("company_id","report_type","period_start");
