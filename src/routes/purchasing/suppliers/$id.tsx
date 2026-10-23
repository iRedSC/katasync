import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, Mail, MapPin, Phone, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Card, Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import { SupplierCatalogs } from "#/components/supplier-catalogs";
import { SupplierDialog } from "#/components/supplier-dialog";
import type { Supplier } from "#/components/supplier-form";
import {
	MonthlySpend,
	PoList,
	StatTiles,
	TopBought,
	TopSelling,
} from "#/components/supplier-page/insights";
import { Button } from "#/components/ui/button";
import { optimistic } from "#/lib/optimism";
import { telHref } from "#/lib/phone";
import { getSupplierDetail, type SupplierDetail } from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/suppliers/$id")({
	loader: ({ params }) =>
		getSupplierDetail({ data: { id: Number(params.id) } }),
	component: SupplierPage,
	pendingComponent: () => (
		<ListSkeleton title="Supplier" back={{ to: "/purchasing/suppliers" }} />
	),
});

const supplierData = optimistic<SupplierDetail>("supplier");

// One supplier: what buying from it looks like (spend, POs, its products by
// what we buy and what sells), how to reach it, the catalogs it carries,
// and its details to edit from the contact card.
function SupplierPage() {
	const loaded = Route.useLoaderData();
	const d = supplierData.useData(loaded.supplier.id, loaded);
	const s = d.supplier;
	const draft = d.open.find((po) => po.status === "draft");
	const [editing, setEditing] = useState(false);

	return (
		<Page
			title={
				<span className="flex items-baseline gap-2">
					{s.name}
					<span className="text-sm font-normal text-muted-foreground">
						{s.code}
					</span>
				</span>
			}
			back={{ to: "/purchasing/suppliers" }}
			width="wide"
			actions={
				draft && (
					<Button size="sm" variant="outline" asChild>
						<Link to="/purchasing/$id" params={{ id: String(draft.id) }}>
							<ClipboardList />
							Open draft PO {draft.id}
						</Link>
					</Button>
				)
			}
		>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<div className="flex min-w-0 flex-col gap-4">
					<StatTiles d={d} />
					<MonthlySpend d={d} />
					<PoList
						title="Open POs"
						pos={d.open}
						empty="Nothing on order or in draft."
					/>
					<div className="grid gap-4 lg:grid-cols-2">
						<TopBought d={d} />
						<TopSelling d={d} />
					</div>
					<PoList
						title="Recent POs"
						pos={d.recent}
						empty="No closed POs yet."
					/>
				</div>
				<div className="flex flex-col gap-4">
					<ContactCard s={s} onEdit={() => setEditing(true)} />
					<Card title="Catalogs">
						<p className="mb-2 text-xs text-muted-foreground">
							It sells everything in the catalogs it carries.
						</p>
						<SupplierCatalogs supplier={s} />
					</Card>
				</div>
			</div>
			<SupplierDialog
				supplier={s}
				leadTime={d.leadTime}
				open={editing}
				onOpenChange={setEditing}
				patch={(saved) =>
					supplierData.patch(s.id, (x) => ({ ...x, supplier: saved }))
				}
			/>
		</Page>
	);
}

// How to reach them, each a link that does it: email, call, map.
function ContactCard({ s, onEdit }: { s: Supplier; onEdit: () => void }) {
	const address = [
		s.address1,
		s.address2,
		[s.city, s.region].filter(Boolean).join(", "),
		s.postalCode,
		s.country,
	]
		.filter(Boolean)
		.join(", ");
	const none = !s.contactName && !s.email && !s.phone && address === "";
	return (
		<Card
			title="Contact"
			aside={
				<button
					type="button"
					onClick={onEdit}
					className="text-link hover:underline"
				>
					Edit
				</button>
			}
		>
			{none ? (
				<button
					type="button"
					onClick={onEdit}
					className="text-muted-foreground hover:text-foreground"
				>
					No contact details yet
				</button>
			) : (
				<ul className="flex flex-col gap-2">
					{s.contactName && (
						<ContactLine icon={<User />}>{s.contactName}</ContactLine>
					)}
					{s.email && (
						<ContactLine icon={<Mail />}>
							<a
								href={`mailto:${s.email}`}
								className="text-link hover:underline"
							>
								{s.email}
							</a>
						</ContactLine>
					)}
					{s.phone && (
						<ContactLine icon={<Phone />}>
							<a href={telHref(s.phone)} className="text-link hover:underline">
								{s.phone}
							</a>
						</ContactLine>
					)}
					{address !== "" && (
						<ContactLine icon={<MapPin />}>
							<a
								href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
								target="_blank"
								rel="noreferrer"
								className="text-link hover:underline"
							>
								{address}
							</a>
						</ContactLine>
					)}
				</ul>
			)}
			{s.paymentTerms && (
				<p className="mt-3 border-t pt-3 text-muted-foreground">
					Pays {s.paymentTerms}
				</p>
			)}
		</Card>
	);
}

function ContactLine({
	icon,
	children,
}: {
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<li className="flex items-start gap-2 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
			{icon}
			<span className="min-w-0 break-words">{children}</span>
		</li>
	);
}
