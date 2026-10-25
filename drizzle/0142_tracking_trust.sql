CREATE TABLE "package_tracking" (
	"carrier" text NOT NULL,
	"number" text NOT NULL,
	"status" "tracking_status" NOT NULL,
	"status_detail" text,
	"status_at" timestamp with time zone,
	"eta" timestamp with time zone,
	"original_eta" timestamp with time zone,
	"service" text,
	"origin" text,
	"destination" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "package_tracking_carrier_number_pk" PRIMARY KEY("carrier","number"),
	CONSTRAINT "package_tracking_carrier" CHECK ("package_tracking"."carrier" in ('ups', 'usps', 'fedex'))
);
--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "unfollowed_at" timestamp with time zone;