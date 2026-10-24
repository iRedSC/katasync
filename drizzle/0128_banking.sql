CREATE TYPE "public"."bank_row_outcome" AS ENUM('accepted', 'invalid', 'duplicate', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."bank_target_kind" AS ENUM('payout');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "bank_accounts_name_unique" UNIQUE("name"),
	CONSTRAINT "bank_accounts_currency" CHECK ("bank_accounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bank_accounts_name" CHECK ("bank_accounts"."name" = btrim("bank_accounts"."name") and length("bank_accounts"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "bank_import_rows" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_import_rows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"import_id" integer NOT NULL,
	"row_number" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"outcome" "bank_row_outcome" NOT NULL,
	"problem" text,
	"duplicate_of" integer,
	CONSTRAINT "bank_import_rows_import_row" UNIQUE("import_id","row_number"),
	CONSTRAINT "bank_import_rows_problem" CHECK (("bank_import_rows"."outcome" = 'invalid') = ("bank_import_rows"."problem" is not null)),
	CONSTRAINT "bank_import_rows_duplicate" CHECK (("bank_import_rows"."outcome" = 'duplicate') = ("bank_import_rows"."duplicate_of" is not null))
);
--> statement-breakpoint
CREATE TABLE "bank_imports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_imports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"file_sha256" text NOT NULL,
	"file_name" text,
	"mapping" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" text NOT NULL,
	"created_tx" text DEFAULT txid_current()::text NOT NULL,
	"request_digest" text NOT NULL,
	"replaces_import_id" integer,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	CONSTRAINT "bank_imports_replaces" UNIQUE("replaces_import_id"),
	CONSTRAINT "bank_imports_sha" CHECK ("bank_imports"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bank_imports_row_count" CHECK ("bank_imports"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bank_match_parts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_match_parts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"match_id" integer NOT NULL,
	"target_kind" "bank_target_kind" NOT NULL,
	"payout_id" integer,
	"amount_cents" bigint NOT NULL,
	"observed_amount_cents" bigint NOT NULL,
	"observed_currency" text NOT NULL,
	"observed_status" text NOT NULL,
	"observed_reference" text,
	"observed_on" date NOT NULL,
	CONSTRAINT "bank_match_parts_target" UNIQUE("match_id","target_kind","payout_id"),
	CONSTRAINT "bank_match_parts_payout" CHECK (("bank_match_parts"."target_kind" = 'payout') = ("bank_match_parts"."payout_id" is not null)),
	CONSTRAINT "bank_match_parts_amount" CHECK ("bank_match_parts"."amount_cents" <> 0),
	CONSTRAINT "bank_match_parts_within" CHECK (sign("bank_match_parts"."amount_cents") = sign("bank_match_parts"."observed_amount_cents") and abs("bank_match_parts"."amount_cents") <= abs("bank_match_parts"."observed_amount_cents")),
	CONSTRAINT "bank_match_parts_currency" CHECK ("bank_match_parts"."observed_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "bank_matches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_matches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transaction_id" integer NOT NULL,
	"matched_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"undone_at" timestamp with time zone,
	"matched_by" text NOT NULL,
	"created_tx" text DEFAULT txid_current()::text NOT NULL,
	"undone_by" text,
	"replaces" integer,
	CONSTRAINT "bank_matches_undone_after" CHECK ("bank_matches"."undone_at" is null or "bank_matches"."undone_at" >= "bank_matches"."matched_at")
);
--> statement-breakpoint
CREATE TABLE "bank_payout_guards" (
	"payout_id" integer PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_target_changes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_target_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"target_kind" "bank_target_kind" NOT NULL,
	"payout_id" integer,
	"changed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	CONSTRAINT "bank_target_changes_payout" CHECK (("bank_target_changes"."target_kind" = 'payout') = ("bank_target_changes"."payout_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"import_row_id" integer NOT NULL,
	"posted_on" date NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"bank_ref" text,
	"fingerprint" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	CONSTRAINT "bank_transactions_importRowId_unique" UNIQUE("import_row_id"),
	CONSTRAINT "bank_transactions_amount" CHECK ("bank_transactions"."amount_cents" <> 0),
	CONSTRAINT "bank_transactions_amount_bound" CHECK (abs("bank_transactions"."amount_cents") < 1000000000000),
	CONSTRAINT "bank_transactions_currency" CHECK ("bank_transactions"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "bank_import_rows" ADD CONSTRAINT "bank_import_rows_import_id_bank_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_rows" ADD CONSTRAINT "bank_import_rows_duplicate_of_bank_transactions_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."bank_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_account_id_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_replaces_import_id_bank_imports_id_fk" FOREIGN KEY ("replaces_import_id") REFERENCES "public"."bank_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_parts" ADD CONSTRAINT "bank_match_parts_match_id_bank_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."bank_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_parts" ADD CONSTRAINT "bank_match_parts_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_replaces_bank_matches_id_fk" FOREIGN KEY ("replaces") REFERENCES "public"."bank_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_payout_guards" ADD CONSTRAINT "bank_payout_guards_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_target_changes" ADD CONSTRAINT "bank_target_changes_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_account_id_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_row_id_bank_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."bank_import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_imports_account_file" ON "bank_imports" USING btree ("account_id","file_sha256") WHERE "bank_imports"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "bank_match_parts_payout_idx" ON "bank_match_parts" USING btree ("payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_matches_active_transaction" ON "bank_matches" USING btree ("transaction_id") WHERE "bank_matches"."undone_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_matches_replaces" ON "bank_matches" USING btree ("replaces");--> statement-breakpoint
CREATE INDEX "bank_target_changes_payout_idx" ON "bank_target_changes" USING btree ("payout_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_account_ref" ON "bank_transactions" USING btree ("account_id","bank_ref") WHERE "bank_transactions"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "bank_transactions_account_posted_idx" ON "bank_transactions" USING btree ("account_id","posted_on");--> statement-breakpoint
CREATE INDEX "bank_transactions_fingerprint_idx" ON "bank_transactions" USING btree ("account_id","fingerprint");