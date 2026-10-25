CREATE TABLE "order_channel_tracking" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"packages" jsonb NOT NULL,
	"read_for" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_channel_tracking" ADD CONSTRAINT "order_channel_tracking_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT ON "order_channel_tracking" TO katasync_mcp;