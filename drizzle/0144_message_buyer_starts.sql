CREATE TYPE "public"."buyer_chat_start_status" AS ENUM('sending', 'sent', 'refused', 'unsure');--> statement-breakpoint
CREATE TABLE "buyer_chat_starts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_chat_starts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"request_key" uuid NOT NULL,
	"order_id" integer NOT NULL,
	"body" text NOT NULL,
	"status" "buyer_chat_start_status" DEFAULT 'sending' NOT NULL,
	"message_id" text,
	"thread_id" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_chat_starts_requestKey_unique" UNIQUE("request_key"),
	CONSTRAINT "buyer_chat_starts_sent_has_id" CHECK (("buyer_chat_starts"."status" = 'sent') = ("buyer_chat_starts"."message_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "order_ref" text;--> statement-breakpoint
ALTER TABLE "buyer_chat_starts" ADD CONSTRAINT "buyer_chat_starts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_chat_starts" ADD CONSTRAINT "buyer_chat_starts_thread_id_buyer_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."buyer_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buyer_chat_starts_order_idx" ON "buyer_chat_starts" USING btree ("order_id","created_at");--> statement-breakpoint
GRANT SELECT ON "buyer_chat_starts" TO katasync_mcp;