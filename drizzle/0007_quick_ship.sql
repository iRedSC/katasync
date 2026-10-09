CREATE TABLE "packages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "packages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"pin" smallint NOT NULL,
	"name" text NOT NULL,
	"length_mm" integer NOT NULL,
	"width_mm" integer NOT NULL,
	"height_mm" integer NOT NULL,
	"weight_grams" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_pin_unique" UNIQUE("pin"),
	CONSTRAINT "packages_pin_three_digits" CHECK ("packages"."pin" between 100 and 999)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shipments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"package_id" integer,
	"contents_key" text NOT NULL,
	"length_mm" integer NOT NULL,
	"width_mm" integer NOT NULL,
	"height_mm" integer NOT NULL,
	"weight_grams" integer NOT NULL,
	"provider" text NOT NULL,
	"carrier" text NOT NULL,
	"service" text NOT NULL,
	"service_name" text NOT NULL,
	"cost" numeric(12, 2) NOT NULL,
	"insured_amount" numeric(12, 2),
	"tracking_number" text,
	"label_url" text NOT NULL,
	"external_id" text NOT NULL,
	"test" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_externalId_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "ship_from_name" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "address1" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "address2" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ship_address1" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ship_address2" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ship_postal_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ship_phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pin" smallint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "insure_when_shipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_contents_idx" ON "shipments" USING btree ("contents_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_pin_unique" ON "orders" USING btree ("pin") WHERE "orders"."pin" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pin_three_digits" CHECK ("orders"."pin" between 100 and 999);