CREATE TYPE "public"."feed_state" AS ENUM('ok', 'partial', 'failed', 'pending');--> statement-breakpoint
CREATE TYPE "public"."sync_feed" AS ENUM('orders', 'returns', 'messages', 'charges', 'tracking');--> statement-breakpoint
CREATE TABLE "feed_health" (
	"channel" "channel" NOT NULL,
	"feed" "sync_feed" NOT NULL,
	"state" "feed_state" NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"succeeded_at" timestamp with time zone,
	"covered_through" timestamp with time zone,
	"problems" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"failing_since" timestamp with time zone,
	CONSTRAINT "feed_health_channel_feed_pk" PRIMARY KEY("channel","feed"),
	CONSTRAINT "feed_health_ok" CHECK ("feed_health"."state" <> 'ok' or ("feed_health"."problems" = 0 and "feed_health"."detail" is null and "feed_health"."failing_since" is null and "feed_health"."succeeded_at" is not null and "feed_health"."succeeded_at" = "feed_health"."attempted_at")),
	CONSTRAINT "feed_health_partial" CHECK ("feed_health"."state" <> 'partial' or ("feed_health"."problems" > 0 and "feed_health"."detail" is not null and "feed_health"."failing_since" is null and "feed_health"."succeeded_at" is not null and "feed_health"."succeeded_at" = "feed_health"."attempted_at")),
	CONSTRAINT "feed_health_failed" CHECK ("feed_health"."state" <> 'failed' or ("feed_health"."problems" = 0 and "feed_health"."detail" is not null and "feed_health"."failing_since" is not null and "feed_health"."failing_since" <= "feed_health"."attempted_at" and ("feed_health"."succeeded_at" is null or "feed_health"."succeeded_at" < "feed_health"."failing_since"))),
	CONSTRAINT "feed_health_pending" CHECK ("feed_health"."state" <> 'pending' or ("feed_health"."problems" = 0 and "feed_health"."detail" is null and "feed_health"."failing_since" is null)),
	CONSTRAINT "feed_health_covered_after_success" CHECK ("feed_health"."covered_through" is null or "feed_health"."succeeded_at" is not null)
);
--> statement-breakpoint
-- Each channel's orders feed starts from its latest finished pass, so
-- Diagnostics doesn't read "never" until the next one. The other feeds
-- start at their next attempt.
INSERT INTO "feed_health" ("channel", "feed", "state", "attempted_at", "succeeded_at", "problems", "detail", "failing_since")
SELECT r."channel", 'orders',
	(CASE WHEN r."error" IS NOT NULL THEN 'failed' WHEN r."problems" > 0 THEN 'partial' ELSE 'ok' END)::"feed_state",
	r."started_at",
	CASE WHEN r."error" IS NULL THEN r."started_at" ELSE (
		SELECT max(g."started_at") FROM "sync_runs" g
		WHERE g."channel" = r."channel" AND g."finished_at" IS NOT NULL
			AND g."error" IS NULL AND g."started_at" < r."started_at"
	) END,
	CASE WHEN r."error" IS NULL THEN r."problems" ELSE 0 END,
	CASE
		WHEN r."error" IS NOT NULL THEN r."error"
		WHEN r."problems" > 0 THEN coalesce(
			(SELECT i."message" FROM "sync_issues" i WHERE i."run_id" = r."id" ORDER BY i."id" LIMIT 1),
			r."problems" || ' problems')
	END,
	CASE WHEN r."error" IS NOT NULL THEN r."started_at" END
FROM (
	SELECT DISTINCT ON ("channel") * FROM "sync_runs"
	WHERE "finished_at" IS NOT NULL
	ORDER BY "channel", "started_at" DESC
) r;
--> statement-breakpoint
GRANT SELECT ON "feed_health" TO katasync_mcp;
