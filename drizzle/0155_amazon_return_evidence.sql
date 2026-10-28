ALTER TABLE "return_request_lines" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "return_request_lines" ADD COLUMN "raw_status" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "a_to_z_claim" boolean;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "safet_claim" jsonb;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "in_policy" boolean;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "return_type" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "label" jsonb;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_safet_claim_has_id" CHECK ("return_requests"."safet_claim" is null or jsonb_typeof("return_requests"."safet_claim"->'id') = 'string');--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_label_object" CHECK ("return_requests"."label" is null or jsonb_typeof("return_requests"."label") = 'object');