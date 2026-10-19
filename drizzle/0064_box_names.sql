ALTER TABLE "packages" DROP CONSTRAINT "packages_pin_unique";--> statement-breakpoint
ALTER TABLE "packages" DROP CONSTRAINT "packages_pin_range";--> statement-breakpoint
ALTER TABLE "packages" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "pin";--> statement-breakpoint
-- A name that's only a size (the old default, "12 × 9 × 4") says nothing the
-- size doesn't, so those boxes go nameless.
UPDATE "packages" SET "name" = NULL
WHERE "name" ~* '^\s*[0-9.]+\s*[×x*]\s*[0-9.]+\s*[×x*]\s*[0-9.]+\s*(in|")?\s*$'
	OR btrim("name") = '';--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_name_not_blank" CHECK ("packages"."name" <> '');