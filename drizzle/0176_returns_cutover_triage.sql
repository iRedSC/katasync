ALTER TABLE "repairs" ADD COLUMN "cutover_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "cutover_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "cutover_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "bench_id" integer;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_cutover_returned" CHECK ("repairs"."cutover_at" is null or "repairs"."return_line_id" is not null);--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_cutover_replaced" CHECK (("order_returns"."cutover_quantity" is null) = ("order_returns"."cutover_at" is null)
				and ("order_returns"."cutover_quantity" is null or (not "order_returns"."pre_cutover"
					and "order_returns"."cutover_quantity" between 1 and "order_returns"."quantity")));