-- Catalogs whose names differ only in case would make the index below fail
-- with Postgres's generic duplicate-key error. Name them instead, so they can
-- be merged or renamed by hand before deploying again. Nothing is merged here.
DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(names, '; ') INTO clashes FROM (
    SELECT string_agg(format('%s (id %s)', name, id), ', ' ORDER BY id) AS names
    FROM catalogs GROUP BY lower(name) HAVING count(*) > 1
  ) c;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'Catalog names that differ only in case: %. Rename or merge them, then migrate again.', clashes;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "catalogs_name_lower" ON "catalogs" USING btree (lower("name"));