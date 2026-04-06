CREATE TABLE "instance_registry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" text NOT NULL,
  "hostname" text,
  "port" integer,
  "status" text DEFAULT 'active' NOT NULL,
  "version" text,
  "last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "instance_registry_instance_id_uniq" ON "instance_registry" USING btree ("instance_id");
