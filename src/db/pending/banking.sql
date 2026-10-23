CREATE FUNCTION bank_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only bank evidence', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_imports_append_only" BEFORE UPDATE OR DELETE ON "bank_imports"
  FOR EACH ROW EXECUTE FUNCTION bank_append_only();
--> statement-breakpoint
CREATE TRIGGER "bank_import_rows_append_only" BEFORE UPDATE OR DELETE ON "bank_import_rows"
  FOR EACH ROW EXECUTE FUNCTION bank_append_only();
--> statement-breakpoint
CREATE TRIGGER "bank_transactions_append_only" BEFORE UPDATE OR DELETE ON "bank_transactions"
  FOR EACH ROW EXECUTE FUNCTION bank_append_only();
--> statement-breakpoint
CREATE TRIGGER "bank_match_parts_append_only" BEFORE UPDATE OR DELETE ON "bank_match_parts"
  FOR EACH ROW EXECUTE FUNCTION bank_append_only();
--> statement-breakpoint
CREATE TRIGGER "bank_target_changes_append_only" BEFORE UPDATE OR DELETE ON "bank_target_changes"
  FOR EACH ROW EXECUTE FUNCTION bank_append_only();
--> statement-breakpoint
CREATE FUNCTION bank_accounts_keep_currency() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank accounts are kept';
  END IF;
  IF NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'a bank account''s currency is fixed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_accounts_keep_currency" BEFORE UPDATE OR DELETE ON "bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION bank_accounts_keep_currency();
--> statement-breakpoint
CREATE FUNCTION bank_matches_only_undo() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank matches are kept; undo them instead';
  END IF;
  IF OLD."undone_at" IS NOT NULL
    OR NEW."undone_at" IS NULL
    OR (NEW."id", NEW."transaction_id", NEW."matched_at", NEW."replaces")
      IS DISTINCT FROM (OLD."id", OLD."transaction_id", OLD."matched_at", OLD."replaces") THEN
    RAISE EXCEPTION 'a bank match can only be undone, once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_matches_only_undo" BEFORE UPDATE OR DELETE ON "bank_matches"
  FOR EACH ROW EXECUTE FUNCTION bank_matches_only_undo();
--> statement-breakpoint
CREATE FUNCTION bank_transactions_currency() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "bank_accounts" a
    WHERE a."id" = NEW."account_id" AND a."currency" = NEW."currency"
  ) THEN
    RAISE EXCEPTION 'a bank row must be in its account''s currency';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "bank_import_rows" r JOIN "bank_imports" i ON i."id" = r."import_id"
    WHERE r."id" = NEW."import_row_id" AND i."account_id" = NEW."account_id" AND r."outcome" = 'accepted'
  ) THEN
    RAISE EXCEPTION 'a bank row must come from an accepted row of its account''s import';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_transactions_currency" BEFORE INSERT ON "bank_transactions"
  FOR EACH ROW EXECUTE FUNCTION bank_transactions_currency();
--> statement-breakpoint
CREATE FUNCTION bank_match_parts_guard() RETURNS trigger AS $$
DECLARE
  bank_currency text;
  bank_sign int;
  used bigint;
BEGIN
  SELECT t."currency", sign(t."amount_cents") INTO bank_currency, bank_sign
  FROM "bank_matches" m JOIN "bank_transactions" t ON t."id" = m."transaction_id"
  WHERE m."id" = NEW."match_id";
  IF NEW."observed_currency" <> bank_currency THEN
    RAISE EXCEPTION 'bank match parts must be in the bank row''s currency';
  END IF;
  IF sign(NEW."amount_cents") <> bank_sign THEN
    RAISE EXCEPTION 'a bank match part must go the same way as its bank row';
  END IF;
  IF NEW."target_kind" = 'payout' THEN
    PERFORM 1 FROM "payouts" WHERE "id" = NEW."payout_id" FOR UPDATE;
    SELECT coalesce(sum(p."amount_cents"), 0) INTO used
    FROM "bank_match_parts" p JOIN "bank_matches" m ON m."id" = p."match_id"
    WHERE p."payout_id" = NEW."payout_id" AND m."undone_at" IS NULL AND p."id" <> NEW."id";
    IF abs(used + NEW."amount_cents") > abs(NEW."observed_amount_cents") THEN
      RAISE EXCEPTION 'payout % would be matched past its amount', NEW."payout_id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_match_parts_guard" BEFORE INSERT ON "bank_match_parts"
  FOR EACH ROW EXECUTE FUNCTION bank_match_parts_guard();
--> statement-breakpoint
CREATE FUNCTION bank_matches_conserve() RETURNS trigger AS $$
DECLARE
  total bigint;
  wanted bigint;
BEGIN
  SELECT coalesce(sum(p."amount_cents"), 0) INTO total FROM "bank_match_parts" p WHERE p."match_id" = NEW."id";
  SELECT t."amount_cents" INTO wanted FROM "bank_transactions" t WHERE t."id" = NEW."transaction_id";
  IF total <> wanted THEN
    RAISE EXCEPTION 'bank match % parts add to % cents; its bank row is % cents', NEW."id", total, wanted;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "bank_matches_conserve" AFTER INSERT ON "bank_matches"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bank_matches_conserve();
--> statement-breakpoint
CREATE FUNCTION bank_payout_changed() RETURNS trigger AS $$
BEGIN
  IF (NEW."amount", upper(NEW."currency"), NEW."status"::text, NEW."reference")
    IS NOT DISTINCT FROM (OLD."amount", upper(OLD."currency"), OLD."status"::text, OLD."reference") THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "bank_match_parts" p JOIN "bank_matches" m ON m."id" = p."match_id"
    WHERE p."payout_id" = NEW."id" AND m."undone_at" IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "bank_target_changes" ("target_kind", "payout_id", "before", "after")
  VALUES (
    'payout', NEW."id",
    jsonb_build_object('amountCents', round(OLD."amount" * 100)::bigint, 'currency', upper(OLD."currency"), 'status', OLD."status"::text, 'reference', OLD."reference"),
    jsonb_build_object('amountCents', round(NEW."amount" * 100)::bigint, 'currency', upper(NEW."currency"), 'status', NEW."status"::text, 'reference', NEW."reference")
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_payout_changed" AFTER UPDATE ON "payouts"
  FOR EACH ROW EXECUTE FUNCTION bank_payout_changed();
