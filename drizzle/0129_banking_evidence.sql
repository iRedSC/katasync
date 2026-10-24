CREATE FUNCTION bank_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only bank evidence', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION bank_close_once() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(OLD) - TG_ARGV) <> (to_jsonb(NEW) - TG_ARGV)
    OR to_jsonb(OLD) ->> TG_ARGV[0] IS NOT NULL
    OR to_jsonb(NEW) ->> TG_ARGV[0] IS NULL
    OR to_jsonb(NEW) ->> TG_ARGV[1] IS NULL THEN
    RAISE EXCEPTION '% evidence can only be closed once', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'bank_transactions' AND EXISTS (SELECT FROM bank_matches WHERE transaction_id = OLD.id AND undone_at IS NULL) THEN
    RAISE EXCEPTION 'Undo this bank row''s match before correcting it';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_imports_append_only" BEFORE UPDATE OR DELETE ON "bank_imports"
  FOR EACH ROW EXECUTE FUNCTION bank_close_once('voided_at', 'voided_by');
--> statement-breakpoint
CREATE TRIGGER "bank_import_rows_append_only" BEFORE UPDATE OR DELETE ON "bank_import_rows"
  FOR EACH ROW EXECUTE FUNCTION bank_append_only();
--> statement-breakpoint
CREATE TRIGGER "bank_transactions_append_only" BEFORE UPDATE OR DELETE ON "bank_transactions"
  FOR EACH ROW EXECUTE FUNCTION bank_close_once('voided_at', 'voided_by');
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
  IF (to_jsonb(NEW) - 'name') IS DISTINCT FROM (to_jsonb(OLD) - 'name') THEN
    RAISE EXCEPTION 'only a bank account''s name can change';
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
    OR NEW."undone_by" IS NULL
    OR (to_jsonb(NEW) - ARRAY['undone_at', 'undone_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['undone_at', 'undone_by']) THEN
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
  UPDATE bank_accounts SET name = name WHERE id = NEW.account_id;
  IF NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL THEN
    RAISE EXCEPTION 'New bank rows start active';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "bank_accounts" a
    WHERE a."id" = NEW."account_id" AND a."currency" = NEW."currency"
  ) THEN
    RAISE EXCEPTION 'a bank row must be in its account''s currency';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "bank_import_rows" r JOIN "bank_imports" i ON i."id" = r."import_id"
    WHERE r."id" = NEW."import_row_id" AND i."account_id" = NEW."account_id" AND r."outcome" = 'accepted'
      AND i.created_tx = txid_current()::text AND i.voided_at IS NULL
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
  IF NOT EXISTS (SELECT FROM bank_matches m JOIN bank_transactions t ON t.id = m.transaction_id
    WHERE m.id = NEW.match_id AND m.created_tx = txid_current()::text AND m.undone_at IS NULL AND t.voided_at IS NULL) THEN
    RAISE EXCEPTION 'Match parts are sealed with their active match';
  END IF;
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
    INSERT INTO bank_payout_guards (payout_id) VALUES (NEW.payout_id)
      ON CONFLICT (payout_id) DO UPDATE SET version = bank_payout_guards.version + 1;
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
--> statement-breakpoint
CREATE FUNCTION bank_match_active() RETURNS trigger AS $$
DECLARE
  owner_id integer;
BEGIN
  SELECT account_id INTO owner_id FROM bank_transactions WHERE id = NEW.transaction_id AND voided_at IS NULL;
  IF owner_id IS NULL OR NEW.undone_at IS NOT NULL OR NEW.undone_by IS NOT NULL THEN
    RAISE EXCEPTION 'A new match requires an active bank transaction';
  END IF;
  UPDATE bank_accounts SET name = name WHERE id = owner_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bank_match_active BEFORE INSERT ON bank_matches FOR EACH ROW EXECUTE FUNCTION bank_match_active();
--> statement-breakpoint
DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['bank_accounts', 'bank_imports', 'bank_import_rows', 'bank_transactions', 'bank_matches', 'bank_match_parts', 'bank_target_changes'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bank_append_only()', relation || '_no_truncate', relation);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row(%L)', relation || '_audit', relation, 'id');
  END LOOP;
END;
$$;
--> statement-breakpoint
GRANT SELECT ON bank_accounts, bank_imports, bank_import_rows, bank_transactions, bank_matches, bank_match_parts, bank_target_changes TO katasync_mcp;
