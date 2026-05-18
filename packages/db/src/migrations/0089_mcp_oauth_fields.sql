ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "oauth_token_endpoint" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "oauth_scopes" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "oauth_resource" text;
