CREATE TABLE "supplier_contacts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_contacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"supplier_id" integer NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "supplier_contacts_email_shape" CHECK ("supplier_contacts"."email" ~ '^[^@\s]+@[^@\s]+$')
);
--> statement-breakpoint
ALTER TABLE "purchase_order_damage_reports" ALTER COLUMN "sent_to" SET DATA TYPE text[] USING ARRAY["sent_to"];--> statement-breakpoint
ALTER TABLE "purchase_orders" ALTER COLUMN "sent_to" SET DATA TYPE text[] USING CASE WHEN "sent_to" IS NULL THEN NULL ELSE ARRAY["sent_to"] END;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_contacts_email" ON "supplier_contacts" USING btree ("supplier_id",lower("email"));--> statement-breakpoint
-- Each address in suppliers.email becomes a contact. Sumtracker imports
-- sometimes hold several, split by commas or semicolons. The first contact
-- takes contact_name.
INSERT INTO "supplier_contacts" ("supplier_id", "name", "email", "position")
SELECT s."id", CASE WHEN a.n = 1 THEN nullif(trim(s."contact_name"), '') END, a.email, a.n - 1
FROM "suppliers" s
CROSS JOIN LATERAL (
	SELECT d.email, row_number() OVER (ORDER BY d.ord) AS n
	FROM (
		SELECT DISTINCT ON (lower(trim(u.e))) trim(u.e) AS email, u.ord
		FROM unnest(regexp_split_to_array(s."email", '[,;]')) WITH ORDINALITY AS u(e, ord)
		WHERE trim(u.e) ~ '^[^@\s]+@[^@\s]+$'
		ORDER BY lower(trim(u.e)), u.ord
	) d
) a
WHERE s."email" IS NOT NULL;--> statement-breakpoint
-- Nothing dropped silently: a name with no usable address, and any address
-- that isn't one, are kept in the supplier's notes.
UPDATE "suppliers" s SET "notes" = concat_ws(E'\n', nullif(s."notes", ''), 'Contact: ' || trim(s."contact_name"))
WHERE nullif(trim(s."contact_name"), '') IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "supplier_contacts" c WHERE c."supplier_id" = s."id");--> statement-breakpoint
UPDATE "suppliers" s SET "notes" = concat_ws(E'\n', nullif(s."notes", ''), 'Email: ' || trim(s."email"))
WHERE EXISTS (
	SELECT 1 FROM unnest(regexp_split_to_array(s."email", '[,;]')) AS u(e)
	WHERE trim(u.e) <> '' AND trim(u.e) !~ '^[^@\s]+@[^@\s]+$'
);--> statement-breakpoint
ALTER TABLE "suppliers" DROP COLUMN "contact_name";--> statement-breakpoint
ALTER TABLE "suppliers" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "purchase_order_damage_reports" ADD CONSTRAINT "purchase_order_damage_reports_sent_to_someone" CHECK (cardinality("purchase_order_damage_reports"."sent_to") > 0);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_sent_to_someone" CHECK ("purchase_orders"."sent_to" is null or cardinality("purchase_orders"."sent_to") > 0);--> statement-breakpoint
GRANT SELECT ON "supplier_contacts" TO katasync_mcp;