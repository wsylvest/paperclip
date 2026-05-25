CREATE TABLE IF NOT EXISTS "pricing_models" (
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
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "pre_run_approval_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_models_provider_model_idx" ON "pricing_models" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_models_adapter_type_idx" ON "pricing_models" USING btree ("adapter_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_models_active_idx" ON "pricing_models" USING btree ("active");
