import type { BankCsvMapping } from "#/db/banking-schema";
import type { BankFilePeek, BankFilePreview } from "#/server/banking";

export type Peeked = Extract<BankFilePeek, { ok: true }>["value"];
export type Previewed = Extract<BankFilePreview, { ok: true }>["value"];

export type Draft = {
	text: string;
	fileName: string | null;
	peek: Peeked;
	mapping: BankCsvMapping;
	replacesImportId?: number;
};

export type Step =
	| { kind: "source"; problem: string | null }
	| { kind: "reading" }
	| { kind: "mapping"; draft: Draft; problem: string | null }
	| { kind: "previewing"; draft: Draft }
	| {
			kind: "preview" | "retry";
			draft: Draft;
			preview: Previewed;
			skip: ReadonlySet<number>;
			problem: string | null;
	  }
	| {
			kind: "importing";
			draft: Draft;
			preview: Previewed;
			skip: ReadonlySet<number>;
	  };
