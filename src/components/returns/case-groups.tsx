import { Fragment } from "react";
import type { useRowLink } from "#/lib/row-link";
import type { CaseRequest } from "#/orders/returns-due";
import { CaseRow } from "./case-row";

export function CaseGroups({
	cases,
	link,
}: {
	cases: CaseRequest[];
	link: ReturnType<typeof useRowLink>["link"];
}) {
	const groups = [
		{
			label: "Refunds to answer",
			rows: cases.filter(
				(request) => request.waitingOn === "us" && request.kind === "refund",
			),
		},
		{
			label: "Returns to answer",
			rows: cases.filter(
				(request) => request.waitingOn === "us" && request.kind === "return",
			),
		},
		{
			label: "Waiting on buyer",
			rows: cases.filter((request) => request.waitingOn === "buyer"),
		},
		{
			label: "Marketplace processing",
			rows: cases.filter((request) => request.waitingOn === "marketplace"),
		},
	];
	return groups
		.filter((group) => group.rows.length > 0)
		.map((group) => (
			<Fragment key={group.label}>
				<tr className="border-t bg-subtle">
					<td
						colSpan={8}
						className="px-4 py-2 text-xs font-medium text-muted-foreground"
					>
						{group.label}
						<span className="ml-1.5 tabular-nums">{group.rows.length}</span>
					</td>
				</tr>
				{group.rows.map((request) => (
					<CaseRow key={request.id} request={request} link={link} />
				))}
			</Fragment>
		));
}
