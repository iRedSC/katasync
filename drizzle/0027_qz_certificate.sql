CREATE TABLE "qz_certificate" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"certificate" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qz_certificate_single" CHECK ("qz_certificate"."id" = 1)
);
