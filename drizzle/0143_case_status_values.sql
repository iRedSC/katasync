ALTER TYPE "public"."return_request_status" ADD VALUE 'processing' BEFORE 'shipped';--> statement-breakpoint
ALTER TYPE "public"."return_request_status" ADD VALUE 'unknown' BEFORE 'shipped';--> statement-breakpoint
