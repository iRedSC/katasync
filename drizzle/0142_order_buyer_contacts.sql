CREATE TABLE "order_buyer_contacts" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "sender_authenticated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_buyer_contacts" ADD CONSTRAINT "order_buyer_contacts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Buyers' addresses: never the query tool's (SECRET_TABLES in src/mcp/query.ts).
REVOKE ALL ON "order_buyer_contacts" FROM katasync_mcp;
