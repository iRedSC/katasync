CREATE TABLE "product_views" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_views_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"sort" text DEFAULT 'name' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_views_name_unique" UNIQUE("name")
);
--> statement-breakpoint
-- The tabs the products page had built in, carried over as saved views.
INSERT INTO "product_views" ("name", "filters", "sort", "position") VALUES
	('Oversold', '[{"field":"status","value":"oversold","exclude":false,"and":false,"exact":true}]', 'inventory', 1),
	('Tool sets missing parts', '[{"field":"status","value":"missing parts","exclude":false,"and":false,"exact":true}]', 'name', 2),
	('Sold out', '[{"field":"status","value":"sold out","exclude":false,"and":false,"exact":true}]', 'name', 3),
	('Tool sets', '[{"field":"status","value":"tool set","exclude":false,"and":false,"exact":true}]', 'name', 4),
	('A items', '[{"field":"class","value":"A","exclude":false,"and":false,"exact":true}]', 'value', 5),
	('B items', '[{"field":"class","value":"B","exclude":false,"and":false,"exact":true}]', 'value', 6),
	('C items', '[{"field":"class","value":"C","exclude":false,"and":false,"exact":true}]', 'value', 7);
