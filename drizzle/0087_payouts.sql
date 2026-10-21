CREATE TYPE "public"."payout_status" AS ENUM('sent', 'pending', 'failed');--> statement-breakpoint
CREATE TABLE "payout_checks" (
	"channel" "channel" PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"status" "payout_status" NOT NULL,
	"deposited_at" timestamp with time zone NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"bank_tail" text,
	"reference" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_channel_external_id" UNIQUE("channel","external_id")
);
--> statement-breakpoint
CREATE INDEX "payouts_deposited_at_idx" ON "payouts" USING btree ("deposited_at");--> statement-breakpoint
-- The read-only MCP role sees payouts like every other table.
GRANT SELECT ON "payouts", "payout_checks" TO katasync_mcp;