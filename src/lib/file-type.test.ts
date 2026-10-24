import { describe, expect, it } from "vitest";
import { fileType } from "#/lib/file-type";

describe("fileType", () => {
	it("takes the sender's type when it says something", () => {
		expect(fileType("Application/PDF; name=x.pdf", "x.pdf")).toBe(
			"application/pdf",
		);
		expect(fileType("text/csv", "report.pdf")).toBe("text/csv");
	});

	it("goes by the name when the type is generic or missing", () => {
		expect(
			fileType("application/octet-stream", "Dura-Stilts Invoice 195043.pdf"),
		).toBe("application/pdf");
		expect(fileType("", "Forwarded.EML")).toBe("message/rfc822");
		expect(fileType("", "scan.jpeg")).toBe("image/jpeg");
		expect(fileType("application/octet-stream", "data.zip")).toBe(
			"application/octet-stream",
		);
	});
});
