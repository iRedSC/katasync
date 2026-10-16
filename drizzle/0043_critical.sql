ALTER TABLE "products" ADD COLUMN "critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "critical_threshold" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_critical_threshold_positive" CHECK ("suppliers"."critical_threshold" > 0);--> statement-breakpoint
-- 0040 made this table without letting the MCP role read it.
GRANT SELECT ON "purchase_order_amendments" TO katasync_mcp;
