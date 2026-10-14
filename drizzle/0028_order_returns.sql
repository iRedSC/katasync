CREATE TABLE "order_returns" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_returns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_line_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"restocked" boolean NOT NULL,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_returns_quantity_positive" CHECK ("order_returns"."quantity" > 0),
	CONSTRAINT "order_returns_restocked_has_batch" CHECK ("order_returns"."restocked" = ("order_returns"."batch_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_returns_line_idx" ON "order_returns" USING btree ("order_line_id");--> statement-breakpoint
-- Readable by the MCP query tool (see 0027_mcp_role.sql).
GRANT SELECT ON "order_returns" TO katasync_mcp;
