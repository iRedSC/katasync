CREATE TABLE "marketplace_statements" (
	"channel" "channel" NOT NULL,
	"period" text NOT NULL,
	"statement" jsonb,
	"read_at" timestamp with time zone,
	"error" text,
	"errored_at" timestamp with time zone,
	CONSTRAINT "marketplace_statements_channel_period_pk" PRIMARY KEY("channel","period"),
	CONSTRAINT "marketplace_statements_read" CHECK (("marketplace_statements"."statement" is null) = ("marketplace_statements"."read_at" is null)),
	CONSTRAINT "marketplace_statements_error" CHECK (("marketplace_statements"."error" is null) = ("marketplace_statements"."errored_at" is null)),
	CONSTRAINT "marketplace_statements_period" CHECK ("marketplace_statements"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
GRANT SELECT ON "marketplace_statements" TO katasync_mcp;
