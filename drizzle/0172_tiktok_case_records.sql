CREATE TYPE "public"."record_media_copy" AS ENUM('kept', 'unfetched', 'gone', 'refused', 'none');--> statement-breakpoint
CREATE TYPE "public"."record_media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."webhook_target" AS ENUM('order', 'order_returns', 'aftersales');--> statement-breakpoint
CREATE TABLE "return_request_media" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_request_media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"request_id" integer NOT NULL,
	"record_id" integer,
	"position" integer,
	"kind" "record_media_kind" NOT NULL,
	"url" text,
	"cover_url" text,
	"source_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"copy" "record_media_copy" NOT NULL,
	"failed_fetches" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	"data" "bytea",
	CONSTRAINT "return_request_media_source" UNIQUE("request_id","source_key"),
	CONSTRAINT "return_request_media_position" UNIQUE("record_id","position"),
	CONSTRAINT "return_request_media_placed" CHECK (("return_request_media"."record_id" is null) = ("return_request_media"."position" is null)),
	CONSTRAINT "return_request_media_kept_has_data" CHECK (("return_request_media"."copy" = 'kept') = ("return_request_media"."data" is not null and "return_request_media"."content_type" is not null)),
	CONSTRAINT "return_request_media_video_fields" CHECK ("return_request_media"."kind" = 'video' or ("return_request_media"."duration_ms" is null and "return_request_media"."cover_url" is null and "return_request_media"."copy" <> 'none'))
);
--> statement-breakpoint
CREATE TABLE "return_request_records" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_request_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"request_id" integer NOT NULL,
	"position" integer NOT NULL,
	"role" text,
	"event" text,
	"description" text,
	"reason_text" text,
	"note" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "return_request_records_position" UNIQUE("request_id","position")
);
--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "source_versioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "records_unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "records_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "target" "webhook_target" DEFAULT 'order' NOT NULL;--> statement-breakpoint
ALTER TABLE "return_request_media" ADD CONSTRAINT "return_request_media_request_id_return_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_media" ADD CONSTRAINT "return_request_media_record_id_return_request_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."return_request_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_records" ADD CONSTRAINT "return_request_records_request_id_return_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_case_targets_tiktok" CHECK ("webhook_inbox"."target" = 'order' or "webhook_inbox"."channel" = 'tiktok');--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_case_key" CHECK ("webhook_inbox"."target" = 'order' or "webhook_inbox"."order_id" like "webhook_inbox"."target"::text || ':%');