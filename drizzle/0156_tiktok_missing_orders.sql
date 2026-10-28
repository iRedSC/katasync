CREATE TABLE "tiktok_missing_orders" (
	"store_id" integer NOT NULL,
	"order_id" text NOT NULL,
	"first_missed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_missing_orders_store_id_order_id_pk" PRIMARY KEY("store_id","order_id")
);
--> statement-breakpoint
ALTER TABLE "tiktok_missing_orders" ADD CONSTRAINT "tiktok_missing_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;