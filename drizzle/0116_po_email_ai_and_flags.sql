CREATE TYPE "public"."po_email_ai_state" AS ENUM('working', 'filed', 'suggested', 'unmatched', 'failed', 'undone');--> statement-breakpoint
CREATE TYPE "public"."po_flag_kind" AS ENUM('price', 'quantity', 'back_order', 'note');--> statement-breakpoint
CREATE TYPE "public"."po_flag_resolution" AS ENUM('applied', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."po_email_match" ADD VALUE 'ai';--> statement-breakpoint
CREATE TABLE "po_email_ai" (
	"email_id" integer PRIMARY KEY NOT NULL,
	"state" "po_email_ai_state" NOT NULL,
	"purchase_order_id" integer,
	"reason" text,
	"proposal" jsonb,
	"applied" jsonb,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "po_email_ai_po" CHECK (("po_email_ai"."state" in ('filed', 'suggested', 'undone')) = ("po_email_ai"."purchase_order_id" is not null)),
	CONSTRAINT "po_email_ai_applied" CHECK (("po_email_ai"."state" in ('filed', 'undone')) = ("po_email_ai"."applied" is not null)),
	CONSTRAINT "po_email_ai_proposal" CHECK ("po_email_ai"."state" <> 'suggested' or "po_email_ai"."proposal" is not null)
);
--> statement-breakpoint
CREATE TABLE "po_flags" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_flags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"email_id" integer,
	"product_id" integer,
	"kind" "po_flag_kind" NOT NULL,
	"value" numeric(12, 4),
	"note" text NOT NULL,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" "po_flag_resolution",
	"before" numeric(12, 4),
	CONSTRAINT "po_flags_shape" CHECK (case "po_flags"."kind"
				when 'price' then "po_flags"."product_id" is not null and "po_flags"."value" >= 0
				when 'quantity' then "po_flags"."product_id" is not null and "po_flags"."value" >= 0 and "po_flags"."value" = trunc("po_flags"."value")
				when 'back_order' then "po_flags"."product_id" is not null and "po_flags"."value" is null
				else "po_flags"."value" is null
			end),
	CONSTRAINT "po_flags_resolved" CHECK (("po_flags"."resolved_at" is null) = ("po_flags"."resolution" is null)),
	CONSTRAINT "po_flags_before_applied" CHECK ("po_flags"."before" is null or "po_flags"."resolution" = 'applied')
);
--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD CONSTRAINT "po_email_ai_email_id_po_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."po_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_email_ai" ADD CONSTRAINT "po_email_ai_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_flags" ADD CONSTRAINT "po_flags_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_flags" ADD CONSTRAINT "po_flags_email_id_po_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."po_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_flags" ADD CONSTRAINT "po_flags_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "po_flags_po_idx" ON "po_flags" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "po_flags_email_idx" ON "po_flags" USING btree ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_flags_one_open" ON "po_flags" USING btree ("purchase_order_id","product_id","kind") WHERE "po_flags"."resolved_at" is null and "po_flags"."kind" <> 'note';--> statement-breakpoint
-- Claude reads these like every other table (src/mcp/query.ts).
GRANT SELECT ON "po_email_ai", "po_flags" TO katasync_mcp;
