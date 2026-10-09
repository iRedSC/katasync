ALTER TABLE "orders" ADD COLUMN "fulfilled_by_channel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Orders saved before this column existed: FBA orders were labeled by channel.
UPDATE "orders" SET "fulfilled_by_channel" = true WHERE "sales_channel" = 'Amazon FBA';
