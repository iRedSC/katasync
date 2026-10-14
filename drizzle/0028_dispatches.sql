CREATE TABLE "dispatch_orders" (
	"dispatch_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"channel_sent_at" timestamp with time zone,
	"channel_fulfillment_id" text,
	"channel_error" text,
	CONSTRAINT "dispatch_orders_dispatch_id_order_id_pk" PRIMARY KEY("dispatch_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dispatches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contents_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "dispatch_id" integer;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_orders_order_idx" ON "dispatch_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "dispatches_contents_idx" ON "dispatches" USING btree ("contents_key","created_at");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Every label so far was one box for one order: each becomes its own
-- dispatch, under the label's id, keeping its tracking handoff.
INSERT INTO "dispatches" ("id", "contents_key", "created_at") OVERRIDING SYSTEM VALUE
	SELECT "id", "contents_key", "created_at" FROM "shipments";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('dispatches', 'id'), coalesce((SELECT max("id") FROM "dispatches"), 0) + 1, false);--> statement-breakpoint
UPDATE "shipments" SET "dispatch_id" = "id";--> statement-breakpoint
INSERT INTO "dispatch_orders" ("dispatch_id", "order_id", "channel_sent_at", "channel_fulfillment_id", "channel_error")
	SELECT "id", "order_id", "channel_sent_at", "channel_fulfillment_id", "channel_error" FROM "shipments";
