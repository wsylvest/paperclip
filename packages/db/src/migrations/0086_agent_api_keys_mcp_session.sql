-- Add label and expiresAt columns to agent_api_keys for MCP gateway session keys.
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "label" text;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
