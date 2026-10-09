CREATE TYPE "public"."location_kind" AS ENUM('owned', 'fba');--> statement-breakpoint
CREATE TYPE "public"."movement_reason" AS ENUM('receipt', 'sale', 'return', 'adjustment', 'transfer_out', 'transfer_in', 'assembly_consume', 'assembly_produce');--> statement-breakpoint
CREATE TYPE "public"."sku_kind" AS ENUM('simple', 'kit', 'bundle');--> statement-breakpoint
CREATE TABLE "locations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "locations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" "location_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" uuid NOT NULL,
	"sku_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"reason" "movement_reason" NOT NULL,
	"reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movements_delta_nonzero" CHECK ("movements"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "sku_components" (
	"parent_sku_id" integer NOT NULL,
	"component_sku_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "sku_components_parent_sku_id_component_sku_id_pk" PRIMARY KEY("parent_sku_id","component_sku_id"),
	CONSTRAINT "sku_components_quantity_positive" CHECK ("sku_components"."quantity" > 0),
	CONSTRAINT "sku_components_not_self" CHECK ("sku_components"."parent_sku_id" <> "sku_components"."component_sku_id")
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "skus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "sku_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"sku_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stock_levels_sku_id_location_id_pk" PRIMARY KEY("sku_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_components" ADD CONSTRAINT "sku_components_parent_sku_id_skus_id_fk" FOREIGN KEY ("parent_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_components" ADD CONSTRAINT "sku_components_component_sku_id_skus_id_fk" FOREIGN KEY ("component_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movements_sku_location_idx" ON "movements" USING btree ("sku_id","location_id");--> statement-breakpoint
CREATE INDEX "movements_created_at_idx" ON "movements" USING btree ("created_at");