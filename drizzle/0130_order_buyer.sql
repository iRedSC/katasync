ALTER TABLE "orders" ADD COLUMN "buyer_id" text;--> statement-breakpoint
CREATE INDEX "orders_buyer_id_idx" ON "orders" USING btree ("store_id","buyer_id") WHERE "orders"."buyer_id" is not null;