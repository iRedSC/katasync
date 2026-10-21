CREATE TYPE "public"."email_template_kind" AS ENUM('purchase_order', 'damage_report');--> statement-breakpoint
CREATE TABLE "email_templates" (
	"kind" "email_template_kind" PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_templates_subject_given" CHECK (btrim("email_templates"."subject") <> ''),
	CONSTRAINT "email_templates_body_given" CHECK (btrim("email_templates"."body") <> '')
);
--> statement-breakpoint
GRANT SELECT ON "email_templates" TO katasync_mcp;
