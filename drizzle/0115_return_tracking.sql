CREATE TABLE "return_tracking" (
	"return_request_id" integer PRIMARY KEY NOT NULL,
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
	CONSTRAINT "return_tracking_number_shape" CHECK ("return_tracking"."number" ~ '^[0-9A-Z]{8,40}$'),
	CONSTRAINT "return_tracking_carrier" CHECK ("return_tracking"."carrier" in ('ups', 'usps', 'fedex'))
);
--> statement-breakpoint
ALTER TABLE "return_tracking" ADD CONSTRAINT "return_tracking_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT ON "return_tracking" TO katasync_mcp;
