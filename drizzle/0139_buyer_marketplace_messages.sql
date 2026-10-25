CREATE TYPE "public"."marketplace_message_kind" AS ENUM('assistant', 'notice', 'order_card', 'shipping_card', 'other');--> statement-breakpoint
CREATE TABLE "buyer_marketplace_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_marketplace_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"thread_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"kind" "marketplace_message_kind" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"order_ref" text,
	"package_ref" text,
	"at" timestamp with time zone NOT NULL,
	"language" text,
	"english" text,
	CONSTRAINT "buyer_marketplace_messages_card_has_order" CHECK (("buyer_marketplace_messages"."kind" in ('order_card', 'shipping_card')) = ("buyer_marketplace_messages"."order_ref" is not null)),
	CONSTRAINT "buyer_marketplace_messages_words_have_body" CHECK ("buyer_marketplace_messages"."kind" not in ('assistant', 'notice') or "buyer_marketplace_messages"."body" <> '')
);
--> statement-breakpoint
ALTER TABLE "buyer_marketplace_messages" ADD CONSTRAINT "buyer_marketplace_messages_thread_id_buyer_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."buyer_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_marketplace_messages_thread_external_id" ON "buyer_marketplace_messages" USING btree ("thread_id","external_id");
--> statement-breakpoint
GRANT SELECT ON "buyer_marketplace_messages" TO katasync_mcp;--> statement-breakpoint
-- Read TikTok's conversations again in full, so threads already kept get
-- the marketplace's messages too.
UPDATE "buyer_threads" SET "read_latest_id" = NULL WHERE "market" = 'tiktok';
--> statement-breakpoint
UPDATE "buyer_message_checks" SET "read_through" = NULL WHERE "market" = 'tiktok';
--> statement-breakpoint
-- Translate buyers' words again, now knowing the trade.
UPDATE "buyer_messages" SET "language" = NULL, "english" = NULL WHERE "from_buyer" AND "language" IS NOT NULL AND "language" <> 'en';
