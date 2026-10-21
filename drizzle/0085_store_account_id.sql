ALTER TABLE "stores" ADD COLUMN "account_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_channel_account" ON "stores" USING btree ("channel","account_id");