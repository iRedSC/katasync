CREATE TABLE "buyer_reply_files" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_reply_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"share_token" text NOT NULL,
	"tiktok_image" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_reply_files_size" CHECK ("buyer_reply_files"."size" <= 4500000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_reply_files_share_token" ON "buyer_reply_files" USING btree ("share_token");