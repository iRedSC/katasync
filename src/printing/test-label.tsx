import {
	Document,
	Page,
	renderToBuffer,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";

// A 4x6 label with nothing to ship on it, for checking a label printer from
// Settings. The border shows whether the label is cut off or off center.
export function renderTestLabel(now = new Date()) {
	return renderToBuffer(
		<Document title="Test label" author="katasync">
			<Page size={[288, 432]} style={s.page}>
				<View style={s.border}>
					<Text style={s.title}>Test label</Text>
					<Text>The border should sit just inside every edge.</Text>
					<Text style={s.muted}>
						{now.toLocaleString("en-US", {
							dateStyle: "medium",
							timeStyle: "short",
						})}
					</Text>
				</View>
			</Page>
		</Document>,
	);
}

const s = StyleSheet.create({
	page: { padding: 9, fontFamily: "Helvetica", fontSize: 12 },
	border: {
		flexGrow: 1,
		borderWidth: 2,
		borderColor: "#000",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		padding: 18,
		textAlign: "center",
	},
	title: { fontSize: 28, fontFamily: "Helvetica-Bold" },
	muted: { color: "#555" },
});
