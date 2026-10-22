import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Components that hand a `title` straight to the DOM, where the browser would
// show its own tooltip. Button's type already leaves `title` out.
const passesToDom = new Set(["Link", "PopoverTrigger", "Slot.Root"]);

// Every `title` attribute that would become a native browser tooltip.
function nativeTitles(): string[] {
	const files = execSync("git ls-files 'src/**/*.tsx'", { encoding: "utf8" })
		.trim()
		.split("\n");
	const found: string[] = [];
	for (const file of files) {
		const source = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		const visit = (node: ts.Node): void => {
			if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
				const tag = node.tagName.getText(source);
				// An iframe's title names the frame for screen readers (and lint
				// requires it); browsers don't show it on hover.
				if (tag !== "iframe" && (/^[a-z]/.test(tag) || passesToDom.has(tag)))
					for (const attr of node.attributes.properties)
						if (ts.isJsxAttribute(attr) && attr.name.getText(source) === "title") {
							const { line } = source.getLineAndCharacterOfPosition(
								attr.getStart(source),
							);
							found.push(`${file}:${line + 1} <${tag} title>`);
						}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return found;
}

describe("tooltips", () => {
	it("never fall back to the browser's own; use <Tip>", () => {
		expect(nativeTitles()).toEqual([]);
	});
});
