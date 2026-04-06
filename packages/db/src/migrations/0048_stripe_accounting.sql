CREATE TABLE IF NOT EXISTS "stripe_customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text,
  "subscription_status" text,
  "current_plan_id" uuid,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "default_payment_method_id" text,
  "trial_ends_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "stripe_price_id" text,
  "stripe_metered_price_id" text,
  "base_monthly_cents" integer DEFAULT 0 NOT NULL,
  "included_usage_cents" integer DEFAULT 0 NOT NULL,
  "overage_rate_cents_per_1000" integer DEFAULT 0 NOT NULL,
  "features" jsonb,
  "is_active" boolean DEFAULT true NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "stripe_invoice_id" text NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "status" text NOT NULL,
  "amount_due_cents" integer DEFAULT 0 NOT NULL,
  "amount_paid_cents" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "hosted_invoice_url" text,
  "invoice_pdf" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "stripe_payment_method_id" text NOT NULL,
  "type" text NOT NULL,
  "last4" text,
  "brand" text,
  "exp_month" integer,
  "exp_year" integer,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stripe_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "processed" boolean DEFAULT false NOT NULL,
  "processing_error" text,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "status" text DEFAULT 'disconnected' NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "token_expires_at" timestamp with time zone,
  "realm_id" text,
  "tenant_id" text,
  "last_sync_at" timestamp with time zone,
  "sync_error" text,
  "chart_of_accounts_mapping" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_sync_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "direction" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "external_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "error_detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stripe_invoices" ADD CONSTRAINT "stripe_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "accounting_sync_log" ADD CONSTRAINT "accounting_sync_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "accounting_sync_log" ADD CONSTRAINT "accounting_sync_log_connection_id_accounting_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."accounting_connections"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_company_uniq" ON "stripe_customers" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_stripe_customer_uniq" ON "stripe_customers" USING btree ("stripe_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_invoices_stripe_invoice_uniq" ON "stripe_invoices" USING btree ("stripe_invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_invoices_company_status_idx" ON "stripe_invoices" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_stripe_method_uniq" ON "payment_methods" USING btree ("stripe_payment_method_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_methods_company_idx" ON "payment_methods" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_webhook_events_stripe_event_uniq" ON "stripe_webhook_events" USING btree ("stripe_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_connections_company_provider_idx" ON "accounting_connections" USING btree ("company_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_sync_log_company_connection_idx" ON "accounting_sync_log" USING btree ("company_id","connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_sync_log_status_idx" ON "accounting_sync_log" USING btree ("status");
