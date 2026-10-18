CREATE TABLE "dismissals" (
	"key" text PRIMARY KEY NOT NULL,
	"error" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
