CREATE TABLE "order_buyer_contacts" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_threads" (
	"thread_id" integer PRIMARY KEY NOT NULL,
	"reply_token" text NOT NULL,
	CONSTRAINT "shopify_threads_replyToken_unique" UNIQUE("reply_token")
);
--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "sender_authenticated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_buyer_contacts" ADD CONSTRAINT "order_buyer_contacts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_threads" ADD CONSTRAINT "shopify_threads_thread_id_buyer_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."buyer_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Buyers' addresses and their threads' reply tokens: never the query tool's
-- (SECRET_TABLES in src/mcp/query.ts).
REVOKE ALL ON "order_buyer_contacts", "shopify_threads" FROM katasync_mcp;
