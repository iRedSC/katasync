import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { LoaderCircle, Phone, RotateCw, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AudioRecording } from "#/components/emails/reader";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import type { MarketMailPage } from "#/inbox/market-mail";
import { isMp3, voicemailContent } from "#/inbox/voicemail-model";
import {
	getMailOrders,
	getVoicemailProducts,
	retryVoicemailTriage,
} from "#/server/inbox";
import { OrderStrip } from "./buyer-order";

type Email = MarketMailPage["emails"][number];

export function VoicemailMessage({ email }: { email: Email }) {
	const router = useRouter();
	const [retrying, setRetrying] = useState(false);
	const state = email.voicemail;
	const content = voicemailContent(email.body);
	const productIds = state?.state === "ready" ? state.productIds : [];
	const orderIds = state?.state === "ready" ? state.orderIds : [];
	const context = useQuery({
		queryKey: ["voicemail-products", email.id, productIds],
		queryFn: () => getVoicemailProducts({ data: { id: email.id } }),
		enabled: productIds.length > 0,
		retry: false,
	});
	const relatedOrders = useQuery({
		queryKey: ["voicemail-orders", email.id, orderIds],
		queryFn: () => getMailOrders({ data: { id: email.id } }),
		enabled: orderIds.length > 0,
		retry: false,
	});
	useEffect(() => {
		if (state?.state !== "pending" && state?.state !== "processing") return;
		const timer = setInterval(() => void router.invalidate(), 15_000);
		return () => clearInterval(timer);
	}, [state?.state, router]);
	if (!state) return null;
	async function retry() {
		if (retrying) return;
		setRetrying(true);
		try {
			await retryVoicemailTriage({ data: { id: email.id } });
			await router.invalidate();
		} catch {
			toast.error("Couldn't queue voicemail. Try again.");
		} finally {
			setRetrying(false);
		}
	}
	const recordings = email.attachments.filter(isMp3);
	return (
		<div className="space-y-4 py-4 animate-in fade-in-0">
			<div className="space-y-3 px-5">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Volume2 className="size-4 text-muted-foreground" />
					{content.callerName && (
						<span className="font-medium">{content.callerName}</span>
					)}
					{content.callerNumber && (
						<a
							href={`tel:${content.callerNumber.replace(/[^+\d]/g, "")}`}
							className="inline-flex items-center gap-1 text-link"
						>
							<Phone className="size-3.5" />
							{content.callerNumber}
						</a>
					)}
					{content.duration && (
						<span className="ml-auto text-muted-foreground tabular-nums">
							{content.duration}
						</span>
					)}
				</div>
				{state.state === "ready" ? (
					<>
						<h3 className="text-lg font-semibold">{state.title}</h3>
						<p className="text-sm whitespace-pre-wrap">{state.summary}</p>
					</>
				) : state.state === "pending" || state.state === "processing" ? (
					<output className="flex items-center gap-2 rounded-lg bg-surface p-3 text-sm">
						<LoaderCircle className="size-4 animate-spin text-primary" />
						{state.state === "pending"
							? "Queued for triage"
							: "Reading voicemail"}
					</output>
				) : (
					<div
						className={
							state.state === "review"
								? "rounded-lg border border-warning-fill bg-warning-surface p-3"
								: "rounded-lg bg-surface p-3"
						}
					>
						<p className="text-sm font-medium">
							{state.state === "review" ? "Needs review" : "Dismissed"}
						</p>
						<p className="mt-1 text-sm text-muted-foreground">{state.reason}</p>
						{state.state === "review" && email.doneAt === null && (
							<Button
								className="mt-2"
								size="sm"
								variant="secondary"
								disabled={retrying}
								onClick={retry}
							>
								{retrying ? (
									<LoaderCircle className="animate-spin" />
								) : (
									<RotateCw />
								)}
								Retry triage
							</Button>
						)}
					</div>
				)}
				{relatedOrders.data?.orders.map((order) => (
					<OrderStrip key={order.id} order={order} />
				))}
				{orderIds.length > 0 && relatedOrders.isPending && (
					<output
						className="block h-14 animate-pulse rounded-lg bg-surface"
						aria-label="Loading orders"
					/>
				)}
				{relatedOrders.isError && (
					<Button
						size="sm"
						variant="ghost"
						disabled={relatedOrders.isFetching}
						onClick={() => void relatedOrders.refetch()}
					>
						<RotateCw
							className={relatedOrders.isFetching ? "animate-spin" : undefined}
						/>
						Retry loading orders
					</Button>
				)}
				{context.data && context.data.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{context.data.map((product) => (
							<Link
								key={product.id}
								to="/products/$sku"
								params={{ sku: product.sku }}
								className="flex max-w-full items-center gap-2 rounded-lg border p-2 hover:bg-surface"
							>
								<ProductImage src={product.imageUrl} className="size-10" />
								<span className="min-w-0 text-sm">
									<span className="block truncate font-medium">
										{product.name}
									</span>
									<span className="text-xs text-muted-foreground">
										{product.sku}
									</span>
								</span>
							</Link>
						))}
					</div>
				)}
				{state.state === "ready" &&
					state.productIds.length > 0 &&
					context.isPending && (
						<output
							className="block h-14 animate-pulse rounded-lg bg-surface"
							aria-label="Loading products"
						/>
					)}
				{context.isError && (
					<Button
						size="sm"
						variant="ghost"
						disabled={context.isFetching}
						onClick={() => void context.refetch()}
					>
						<RotateCw
							className={context.isFetching ? "animate-spin" : undefined}
						/>
						Retry loading products
					</Button>
				)}
			</div>
			{recordings.map((recording) =>
				recording.kept ? (
					<AudioRecording
						key={recording.id}
						url={`/api/market-email-attachments/${recording.id}`}
						filename={recording.filename}
						transcript={content.transcript}
					/>
				) : (
					<p
						key={recording.id}
						role="alert"
						className="px-5 text-sm text-critical-text"
					>
						Recording too large to keep. Listen in Outlook.
					</p>
				),
			)}
			{recordings.length === 0 && (
				<p role="alert" className="px-5 text-sm text-critical-text">
					No recording attached.
				</p>
			)}
			<div className="space-y-2 border-t px-5 pt-4">
				<h4 className="text-xs font-semibold text-muted-foreground">
					Original transcript
				</h4>
				<p className="text-sm whitespace-pre-wrap">
					{content.transcript ||
						"No transcript available. Listen to the recording."}
				</p>
			</div>
			<details className="border-t px-5 pt-3 text-sm">
				<summary className="cursor-pointer text-muted-foreground">
					Original email
				</summary>
				<p className="mt-3 whitespace-pre-wrap break-words">{email.body}</p>
			</details>
		</div>
	);
}

export function voicemailRow(email: Email): Email {
	if (!email.voicemail) return email;
	const content = voicemailContent(email.body);
	return {
		...email,
		fromName: content.callerName ?? content.callerNumber ?? "Voicemail",
		subject:
			email.voicemail.state === "ready" ? email.voicemail.title : email.subject,
		body:
			email.voicemail.state === "ready"
				? email.voicemail.summary
				: content.transcript || "Listen to recording",
	};
}
