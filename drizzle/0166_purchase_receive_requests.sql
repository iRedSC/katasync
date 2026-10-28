CREATE TABLE "purchase_receive_requests" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receive_requests_kind" CHECK ("purchase_receive_requests"."kind" in ('line', 'extra', 'all')),
	CONSTRAINT "purchase_receive_requests_key" CHECK (length("purchase_receive_requests"."key") > 0)
);
