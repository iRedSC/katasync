ALTER TABLE "buyer_chat_starts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer_marketplace_messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer_reply_files" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reply_base_prompt" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reply_drafts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reply_precedents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_threads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "buyer_chat_starts" CASCADE;--> statement-breakpoint
DROP TABLE "buyer_marketplace_messages" CASCADE;--> statement-breakpoint
DROP TABLE "buyer_reply_files" CASCADE;--> statement-breakpoint
DROP TABLE "reply_base_prompt" CASCADE;--> statement-breakpoint
DROP TABLE "reply_drafts" CASCADE;--> statement-breakpoint
DROP TABLE "reply_precedents" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_threads" CASCADE;--> statement-breakpoint
ALTER TABLE "buyer_messages" DROP CONSTRAINT "buyer_messages_refused_by_market_emails_id_fk";
--> statement-breakpoint
DROP INDEX "buyer_messages_refused_by";--> statement-breakpoint
DROP INDEX "buyer_messages_unsettled_idx";--> statement-breakpoint
ALTER TABLE "buyer_messages" DROP COLUMN "in_reply_to";--> statement-breakpoint
ALTER TABLE "buyer_messages" DROP COLUMN "recipient";--> statement-breakpoint
ALTER TABLE "buyer_messages" DROP COLUMN "refused_by";--> statement-breakpoint
ALTER TABLE "buyer_messages" DROP COLUMN "language";--> statement-breakpoint
ALTER TABLE "buyer_messages" DROP COLUMN "english";--> statement-breakpoint
DROP TYPE "public"."buyer_chat_start_status";--> statement-breakpoint
DROP TYPE "public"."marketplace_message_kind";--> statement-breakpoint
DROP TYPE "public"."reply_draft_state";