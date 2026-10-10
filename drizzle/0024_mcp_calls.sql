CREATE TABLE "mcp_calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mcp_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"token_name" text NOT NULL,
	"tool" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "can_write" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_calls_created_idx" ON "mcp_calls" USING btree ("created_at");