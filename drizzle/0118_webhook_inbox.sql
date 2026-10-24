CREATE TABLE "webhook_inbox" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel" "channel" NOT NULL,
	"order_id" text NOT NULL,
	"event_digest" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "webhook_inbox_lease_pair" CHECK (("webhook_inbox"."lease_token" is null) = ("webhook_inbox"."lease_expires_at" is null)),
	CONSTRAINT "webhook_inbox_error_pair" CHECK (("webhook_inbox"."last_error" is null) = ("webhook_inbox"."last_error_at" is null)),
	CONSTRAINT "webhook_inbox_generation_positive" CHECK ("webhook_inbox"."generation" >= 1),
	CONSTRAINT "webhook_inbox_failures_nonnegative" CHECK ("webhook_inbox"."failures" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_order_idx" ON "webhook_inbox" USING btree ("channel","order_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_due_idx" ON "webhook_inbox" USING btree ("next_attempt_at");