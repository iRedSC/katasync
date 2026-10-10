ALTER TABLE "stores" ADD COLUMN "primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_one_primary" ON "stores" USING btree ("primary") WHERE "stores"."primary";