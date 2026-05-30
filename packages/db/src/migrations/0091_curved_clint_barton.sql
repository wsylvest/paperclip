CREATE TABLE IF NOT EXISTS "heartbeat_run_stages" (
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
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_run_stages" ADD CONSTRAINT "heartbeat_run_stages_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_stages_run_idx" ON "heartbeat_run_stages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_stages_run_ordinal_uq" ON "heartbeat_run_stages" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_stages_run_status_idx" ON "heartbeat_run_stages" USING btree ("run_id","status");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cost_events_stage_id_heartbeat_run_stages_id_fk'
  ) THEN
    ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_stage_id_heartbeat_run_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."heartbeat_run_stages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
