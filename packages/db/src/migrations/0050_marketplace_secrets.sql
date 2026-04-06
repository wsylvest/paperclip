CREATE TABLE IF NOT EXISTS "marketplace_listings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "publisher_user_id" text NOT NULL,
  "publisher_company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text NOT NULL,
  "long_description" text,
  "category" text NOT NULL,
  "tags" text[],
  "version" text,
  "portable_package" jsonb,
  "agent_count" integer NOT NULL DEFAULT 0,
  "project_count" integer NOT NULL DEFAULT 0,
  "downloads" integer NOT NULL DEFAULT 0,
  "average_rating" text,
  "rating_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'draft',
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_listings_slug_idx" ON "marketplace_listings" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_listings_status_published_at_idx" ON "marketplace_listings" ("status", "published_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL REFERENCES "marketplace_listings"("id"),
  "user_id" text NOT NULL,
  "rating" integer NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL REFERENCES "marketplace_listings"("id"),
  "version" text NOT NULL,
  "portable_package" jsonb,
  "changelog" text,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_provider_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "provider" text NOT NULL,
  "status" text NOT NULL DEFAULT 'configured',
  "config" jsonb,
  "last_tested_at" timestamp with time zone,
  "test_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_provider_configs_company_id_idx" ON "secret_provider_configs" ("company_id");
