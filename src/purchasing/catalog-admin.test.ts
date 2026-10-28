import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { catalogDetail, findForCatalog } from "./catalog-detail";
import {
	addCatalogPhoto,
	createCatalog,
	deleteCatalog,
	describeCatalog,
	ensureCatalog,
	listCatalogs,
	restoreCatalog,
	setCarried,
	setCatalogPhoto,
	setProductsCatalog,
} from "./catalogs";
import { createPurchasingDb } from "./purchasing.fixtures";

let db: Db;
let canam: number;
beforeEach(async () => {
	({ db, canam } = await createPurchasingDb());
});

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test("a new catalog refuses a name taken in any case, and keeps its description", async () => {
	const id = await createCatalog(db, {
		name: "  Columbia  Taping ",
		description: " Banjos, boxes ",
	});
	await expect(
		createCatalog(db, { name: "columbia taping", description: null }),
	).rejects.toThrow('There\'s already a catalog "columbia taping"');
	const [c] = await listCatalogs(db);
	expect(c).toMatchObject({
		id,
		name: "Columbia Taping",
		description: "Banjos, boxes",
		photoId: null,
	});
});

test("one catalog per name in any case, even made at the same moment", async () => {
	const [a, b] = await Promise.all([
		ensureCatalog(db, "Blades"),
		ensureCatalog(db, "blades"),
	]);
	expect(b).toBe(a);
	expect((await listCatalogs(db)).map((c) => c.name)).toEqual(["Blades"]);
	await expect(
		db.insert(schema.catalogs).values({ name: "BLADES" }),
	).rejects.toThrow();
});

test("describing returns the description before, and blank clears it", async () => {
	const id = await createCatalog(db, { name: "Tools", description: "Old" });
	expect(await describeCatalog(db, id, "New")).toBe("Old");
	expect(await describeCatalog(db, id, "   ")).toBe("New");
	expect((await listCatalogs(db))[0].description).toBeNull();
});

test("a photo swap returns the one before, which stays for undo", async () => {
	const id = await createCatalog(db, { name: "Tools", description: null });
	const first = await addCatalogPhoto(db, jpeg);
	const second = await addCatalogPhoto(db, jpeg);
	expect(await setCatalogPhoto(db, id, first)).toBeNull();
	expect(await setCatalogPhoto(db, id, second)).toBe(first);
	expect(await setCatalogPhoto(db, id, first)).toBe(second);
	expect((await listCatalogs(db))[0].photoId).toBe(first);
});

test("only images are kept as photos", async () => {
	await expect(
		addCatalogPhoto(db, new TextEncoder().encode("<svg></svg>")),
	).rejects.toThrow("JPEG, PNG, or WebP");
});

test("a deleted catalog comes back with its details and carriers", async () => {
	const id = await createCatalog(db, { name: "Tools", description: "Taping" });
	const photoId = await addCatalogPhoto(db, jpeg);
	await setCatalogPhoto(db, id, photoId);
	await setCarried(db, { supplierId: canam, catalogId: id, carried: true });

	const gone = await deleteCatalog(db, id);
	expect(gone).toEqual({
		name: "Tools",
		description: "Taping",
		photoId,
		supplierIds: [canam],
	});
	expect(await listCatalogs(db)).toEqual([]);

	await restoreCatalog(db, gone);
	const [back] = await listCatalogs(db);
	expect(back).toMatchObject({
		name: "Tools",
		description: "Taping",
		photoId,
		suppliers: [{ id: canam }],
	});
});

test("a catalog with products can't be deleted", async () => {
	const id = await createCatalog(db, { name: "Tools", description: null });
	const p = await createProduct(db, "T-1", "simple");
	await setProductsCatalog(db, [p], id);
	await expect(deleteCatalog(db, id)).rejects.toThrow("still has 1 product");
});

test("the page lists its products, and finding one says where it is now", async () => {
	const tools = await createCatalog(db, { name: "Tools", description: null });
	const other = await createCatalog(db, { name: "Other", description: null });
	await setCarried(db, { supplierId: canam, catalogId: tools, carried: true });
	const inTools = await createProduct(db, "BOX-1", "simple");
	const elsewhere = await createProduct(db, "BOX-2", "simple");
	await setProductsCatalog(db, [inTools], tools);
	await setProductsCatalog(db, [elsewhere], other);

	const d = await catalogDetail(db, tools);
	expect(d.carriers.map((c) => c.id)).toEqual([canam]);
	expect(d.products.map((p) => p.id)).toEqual([inTools]);
	expect(d.products[0].offers.map((o) => o.supplierId)).toEqual([canam]);

	const found = await findForCatalog(db, "box");
	expect(found.map((f) => [f.sku, f.catalogName])).toEqual([
		["BOX-1", "Tools"],
		["BOX-2", "Other"],
	]);
	expect(await findForCatalog(db, "  ")).toEqual([]);
});
