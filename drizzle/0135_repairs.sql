CREATE TYPE "public"."repair_status" AS ENUM('received', 'waiting_parts', 'in_repair', 'ready', 'picked_up', 'cancelled');--> statement-breakpoint
CREATE TABLE "people" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "people_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"technician" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_name_present" CHECK (length(trim("people"."name")) between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "repair_labor" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repair_labor_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repair_id" integer NOT NULL,
	"minutes" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_labor_minutes_steps" CHECK ("repair_labor"."minutes" > 0 and "repair_labor"."minutes" <= 6000 and "repair_labor"."minutes" % 15 = 0)
);
--> statement-breakpoint
CREATE TABLE "repair_parts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repair_parts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repair_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "repair_parts_one_per_product" UNIQUE("repair_id","product_id"),
	CONSTRAINT "repair_parts_quantity_positive" CHECK ("repair_parts"."quantity" between 1 and 999)
);
--> statement-breakpoint
CREATE TABLE "repairs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repairs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"status" "repair_status" DEFAULT 'received' NOT NULL,
	"customer_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"tool" text NOT NULL,
	"serial" text,
	"problem" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"technician_id" integer,
	"draft_order_id" text,
	"draft_order_name" text,
	"order_id" text,
	"order_name" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repairs_draft_name_pair" CHECK (("repairs"."draft_order_id" is null) = ("repairs"."draft_order_name" is null)),
	CONSTRAINT "repairs_order_pair" CHECK (("repairs"."order_id" is null) = ("repairs"."order_name" is null)),
	CONSTRAINT "repairs_order_when_paid" CHECK ("repairs"."order_id" is null or ("repairs"."status" = 'picked_up' and "repairs"."draft_order_id" is null)),
	CONSTRAINT "repairs_no_draft_when_closed" CHECK ("repairs"."draft_order_id" is null or "repairs"."status" not in ('picked_up', 'cancelled')),
	CONSTRAINT "repairs_tool_present" CHECK (length(trim("repairs"."tool")) > 0)
);
--> statement-breakpoint
ALTER TABLE "repair_labor" ADD CONSTRAINT "repair_labor_repair_id_repairs_id_fk" FOREIGN KEY ("repair_id") REFERENCES "public"."repairs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_parts" ADD CONSTRAINT "repair_parts_repair_id_repairs_id_fk" FOREIGN KEY ("repair_id") REFERENCES "public"."repairs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_parts" ADD CONSTRAINT "repair_parts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_technician_id_people_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_name_unique" ON "people" USING btree (lower("name")) WHERE "people"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "repair_labor_repair_idx" ON "repair_labor" USING btree ("repair_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repairs_draft_order_unique" ON "repairs" USING btree ("draft_order_id");--> statement-breakpoint
CREATE INDEX "repairs_open_idx" ON "repairs" USING btree ("status") WHERE "repairs"."status" not in ('picked_up', 'cancelled');--> statement-breakpoint
CREATE INDEX "repairs_customer_idx" ON "repairs" USING btree ("customer_id");--> statement-breakpoint
GRANT SELECT ON "people", "repairs", "repair_labor", "repair_parts" TO katasync_mcp;