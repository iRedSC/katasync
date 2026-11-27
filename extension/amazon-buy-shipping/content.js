// Fills Seller Central's single-box Buy Shipping form with the box packed in
// katasync's quick ship, which opens this page with the box after the #
// (src/components/quick-ship/amazon-form.ts).
//
// It types the box size, the dangerous goods box, and the weight, and
// nothing else: it never picks a service, never buys, never reads the
// buyer or the address, and sends nothing anywhere.
//
// Size goes in first and weight last, and only once the page shows the size
// took. Amazon lists no service until there's a weight, so a size that
// didn't take can never be priced: the form is just left for typing by hand.
//
// Runs before the page's own scripts, so the # is read before anything can
// drop it.
(() => {
	const TAG = "[katasync]";
	const found = location.hash.match(/(?:^#|&)katasync=([^&]+)/);
	if (!found) return;

	// The box as katasync sent it, or null when it isn't one this version
	// knows how to type.
	function parse(text) {
		try {
			const p = JSON.parse(decodeURIComponent(text));
			const size = (n) => typeof n === "number" && n > 0 && n <= 600;
			const ok =
				p?.v === 1 &&
				Array.isArray(p.in) &&
				p.in.length === 3 &&
				p.in.every(size) &&
				Number.isInteger(p.lb) &&
				p.lb >= 0 &&
				typeof p.oz === "number" &&
				p.oz >= 0 &&
				p.oz < 16 &&
				p.lb + p.oz > 0 &&
				typeof p.hazmat === "boolean";
			return ok ? p : null;
		} catch {
			return null;
		}
	}

	const pause = (ms) => new Promise((done) => setTimeout(done, ms));

	// What check() gives once it gives something, or null after ms.
	async function until(check, ms) {
		const end = Date.now() + ms;
		for (;;) {
			const result = check();
			if (result) return result;
			if (Date.now() > end) return null;
			await pause(100);
		}
	}

	const shown = (el) => el.getClientRects().length > 0;
	const byTest = (id) => document.querySelector(`[data-test-id="${id}"]`);
	// Amazon keeps a hidden copy of a popover's contents; the one on screen.
	const shownByTest = (id) =>
		[...document.querySelectorAll(`[data-test-id="${id}"]`)].find(shown) ??
		null;

	// Types into a field the way the page's own scripts notice.
	function type(input, value) {
		input.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		).set.call(input, String(value));
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
		input.blur();
	}

	function style() {
		if (document.getElementById("katasync-style")) return;
		const el = document.createElement("style");
		el.id = "katasync-style";
		el.textContent = `
			.katasync-ok { outline: 3px solid #16a34a !important; outline-offset: 2px; border-radius: 4px; }
			.katasync-bad { outline: 3px solid #dc2626 !important; outline-offset: 2px; border-radius: 4px; animation: katasync-shake .4s; }
			@keyframes katasync-shake { 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
			#katasync-why { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 12px; border-radius: 8px; background: #dc2626; color: #fff; font: 600 14px system-ui, sans-serif; }
		`;
		document.documentElement.append(el);
	}

	const ok = (...els) => {
		style();
		for (const el of els) el?.classList.add("katasync-ok");
	};

	// Red on the part that didn't take, and why in a few words. The form is
	// left as it is, to finish by hand.
	function fail(el, why, detail) {
		console.warn(TAG, why, detail ?? "");
		style();
		el?.classList.add("katasync-bad");
		const note = document.createElement("div");
		note.id = "katasync-why";
		note.textContent = why;
		document.body.append(note);
		return false;
	}

	// The packaging dropdown is Amazon's own component; from here only its
	// attributes and its children can be read.
	const dropdown = () =>
		byTest("shipping-package-dimension-label")
			?.closest(".a-section")
			?.querySelector("kat-dropdown") ?? null;
	const chosen = () => dropdown()?.querySelector("kat-option[selected]") ?? null;
	const packaging = () =>
		`${dropdown()?.getAttribute("value")}|${chosen()?.getAttribute("value")}`;

	// Whether text names this size: the three numbers in order, none of them
	// part of a longer number.
	function names(text, sides) {
		const n = (v) => `(?<![\\d.])${String(v).replace(".", "\\.")}(?:\\.0+)?(?![\\d.])`;
		return new RegExp(sides.map(n).join("\\D+")).test(text ?? "");
	}

	// Opens "Change parcel dimensions", types the size, applies it, and waits
	// for the page to show it took.
	async function setSize(sides) {
		const link = byTest("add-package-text-popover");
		if (!link) return fail(null, "Box size link not found");
		const before = packaging();
		link.click();
		const fields = await until(() => {
			const all = [0, 1, 2].map((i) =>
				shownByTest(`add-package-preload-input-${i}`),
			);
			return all.every(Boolean) && all;
		}, 3000);
		if (!fields) return fail(link, "Box size fields didn't open");
		fields.forEach((field, i) => {
			type(field, sides[i]);
		});

		const apply = await until(() => {
			const button = shownByTest("add-package-preload-apply");
			const input = button?.querySelector("input");
			const off =
				!button ||
				button.closest(".disabled") ||
				button.classList.contains("a-button-disabled") ||
				input?.disabled;
			return off ? null : (input ?? button);
		}, 3000);
		if (!apply) {
			return fail(fields[0], "Amazon didn't take the box size", {
				typed: sides,
				shows: fields.map((f) => f.value),
			});
		}
		apply.click();

		// Took: the popover closed, and the packaging is no longer what it was
		// or now names this size.
		const took = await until(
			() =>
				!fields.some(shown) &&
				(packaging() !== before ||
					names(chosen()?.textContent, sides) ||
					names(link.textContent, sides)),
			4000,
		);
		if (!took) {
			return fail(link, "Box size not confirmed", {
				typed: sides,
				before,
				after: packaging(),
				chosen: chosen()?.textContent?.trim(),
				link: link.textContent?.trim(),
				open: fields.some(shown),
			});
		}
		ok(link);
		return true;
	}

	async function setHazmat(hazmat) {
		const row = byTest("buy-shipping-dg-checkbox");
		const box = row?.querySelector('input[type="checkbox"]');
		if (!box) return fail(null, "Dangerous goods box not found");
		if (box.checked !== hazmat) box.click();
		await pause(300);
		if (box.checked !== hazmat)
			return fail(row, "Dangerous goods box didn't change");
		if (hazmat) ok(row);
		return true;
	}

	async function setWeight(lbField, ozField, lb, oz) {
		type(lbField, lb);
		type(ozField, oz);
		// The page redraws after typing; a value it dropped shows by now.
		await pause(400);
		const section = byTest("shipping-weight-label")?.closest(".a-section");
		const refused = () =>
			[
				...(section?.querySelectorAll(
					".a-alert-inline-warning, .a-alert-inline-error",
				) ?? []),
			].find(shown);
		const took = await until(
			() =>
				lbField.value !== "" &&
				ozField.value !== "" &&
				Number(lbField.value) === lb &&
				Number(ozField.value) === oz &&
				!refused(),
			3000,
		);
		if (!took) {
			return fail(lbField, "Amazon didn't take the weight", {
				typed: [lb, oz],
				shows: [lbField.value, ozField.value],
				says: refused()?.textContent?.trim(),
			});
		}
		ok(lbField, ozField);
		return true;
	}

	async function fill(box) {
		const lbField = await until(
			() => byTest("shipping-weight-input-LB"),
			20000,
		);
		const ozField = byTest("shipping-weight-input-OZ");
		if (!lbField || !ozField) return fail(null, "Weight fields not found");
		// The page's scripts may still be wiring the form up.
		await pause(500);
		if (!(await setSize(box.in))) return;
		if (!(await setHazmat(box.hazmat))) return;
		if (!(await setWeight(lbField, ozField, box.lb, box.oz))) return;
		console.info(TAG, "filled", box);
	}

	const box = parse(found[1]);
	const start = () =>
		box ? fill(box) : fail(null, "katasync sent a box this extension can't read");
	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
})();
