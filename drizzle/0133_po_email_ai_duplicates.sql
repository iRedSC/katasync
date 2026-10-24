ALTER TYPE "public"."po_email_ai_state" ADD VALUE 'set_aside';--> statement-breakpoint
ALTER TABLE "po_email_ai" DROP CONSTRAINT "po_email_ai_po";--> statement-breakpoint
ALTER TABLE "po_email_ai" DROP CONSTRAINT "po_email_ai_applied";--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD COLUMN "duplicate_of" integer;--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD CONSTRAINT "po_email_ai_duplicate_of_po_emails_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."po_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD CONSTRAINT "po_email_ai_duplicate" CHECK (("po_email_ai"."state"::text = 'set_aside' or ("po_email_ai"."state"::text = 'undone' and "po_email_ai"."purchase_order_id" is null)) = ("po_email_ai"."duplicate_of" is not null));--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD CONSTRAINT "po_email_ai_po" CHECK (("po_email_ai"."state"::text in ('filed', 'suggested') or ("po_email_ai"."state"::text = 'undone' and "po_email_ai"."duplicate_of" is null)) = ("po_email_ai"."purchase_order_id" is not null));--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD CONSTRAINT "po_email_ai_applied" CHECK (("po_email_ai"."state"::text = 'filed' or ("po_email_ai"."state"::text = 'undone' and "po_email_ai"."purchase_order_id" is not null)) = ("po_email_ai"."applied" is not null));