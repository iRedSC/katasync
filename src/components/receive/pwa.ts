// Head tags that make the receiving routes installable ("Add to Home Screen").
// Spread into each receive route's head() so the rest of the app is untouched.
export const receiveHead = () => ({
	meta: [
		{ title: "Receive" },
		{ name: "theme-color", content: "#1a1a1a" },
		{ name: "apple-mobile-web-app-capable", content: "yes" },
		{ name: "mobile-web-app-capable", content: "yes" },
		{ name: "apple-mobile-web-app-title", content: "Receive" },
	],
	links: [
		{ rel: "manifest", href: "/manifest.webmanifest" },
		{ rel: "apple-touch-icon", href: "/receive-192.png" },
	],
});
