type Color = [number, number, number, number];
const paper: Color = [255, 255, 255, 1];
const ink: Color = [232, 234, 237, 1];

function luminance(color: Color) {
	const linear = color.slice(0, 3).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function blend(front: Color, back: Color): Color {
	return [0, 1, 2].map(i => front[i] * front[3] + back[i] * (1 - front[3])).concat(1) as Color;
}
function contrast(front: Color, back: Color) {
	const a = luminance(blend(front, back)), b = luminance(back);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function surface(color: Color): Color {
	if (!color[3]) return color;
	const light = luminance(color), channels = color.slice(0, 3), spread = Math.max(...channels) - Math.min(...channels);
	// Preserve already dark surfaces and saturated buttons that work with light text.
	if (light < 0.08 || spread > 48 && light < 0.35) return color;
	const average = channels.reduce((sum, value) => sum + value, 0) / 3;
	return channels.map(value => Math.round(Math.max(18, Math.min(80, 32 + (value - average) * 0.22 + (1 - light) * 10)))).concat(color[3]) as Color;
}
function readable(color: Color, background: Color, minimum = 4.5): Color {
	if (!color[3]) return color;
	const channels = color.slice(0, 3);
	if (minimum === 4.5 && luminance(color) < 0.4 && Math.max(...channels) - Math.min(...channels) < 30 && contrast(ink, background) >= minimum) return ink;
	if (contrast(color, background) >= minimum) return color;
	for (let step = 1; step <= 20; step++) {
		const fraction = step / 20;
		const candidate = color.slice(0, 3).map((value, i) => Math.round(value + (ink[i] - value) * fraction)).concat(1) as Color;
		if (contrast(candidate, background) >= minimum) return candidate;
	}
	const black: Color = [0, 0, 0, 1];
	return contrast(ink, background) >= contrast(black, background) ? ink : black;
}
function cssColor(color: Color) { return `rgba(${color[0]},${color[1]},${color[2]},${color[3]})`; }

/** Presentation only: never change the stored message, quotes or outgoing HTML. */
export function createEmailTheme(root: ShadowRoot) {
	const saved = new Map<HTMLElement, string | null>();
	let applied = false;
	const restore = () => {
		for (const [element, original] of saved) {
			if (original === null) {
				// Remove the attribute node: CSSOM can otherwise serialize a removed style as "".
				const attribute = element.getAttributeNode("style");
				if (attribute) element.removeAttributeNode(attribute);
			} else element.setAttribute("style", original);
		}
		saved.clear(); applied = false;
	};
	function setDark(dark: boolean) {
		if (dark === applied) return;
		if (!dark) { restore(); return; }
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!context) return;
		const colors = new Map<string, Color>();
		const parse = (value: string): Color => {
			const previous = colors.get(value); if (previous) return previous;
			// Canvas resolves supported CSS color syntax, including named colors and Color 4.
			context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
			const pixel = context.getImageData(0, 0, 1, 1).data;
			const result: Color = [pixel[0], pixel[1], pixel[2], pixel[3] / 255]; colors.set(value, result); return result;
		};
		// Read before writing, so child snapshots still describe the original design.
		const entries = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(element => element.style && element.tagName !== "STYLE").map(element => {
			const originalStyle = element.getAttribute("style");
			const style = getComputedStyle(element);
			return { element, originalStyle, color: parse(style.color), background: parse(style.backgroundColor), image: style.backgroundImage, textShadow: style.textShadow, borders: ["top", "right", "bottom", "left"].map(side => ({ name: `border-${side}-color`, color: parse(style.getPropertyValue(`border-${side}-color`)) })) };
		});
		const backgrounds = new Map<Element, { original: Color; dark: Color }>();
		for (const entry of entries) {
			const { element } = entry;
			const parent = element.parentElement ? backgrounds.get(element.parentElement) : undefined;
			const originalBackground = blend(entry.background, parent?.original ?? paper);
			const darkBackground = blend(surface(entry.background), parent?.dark ?? [32, 33, 36, 1]);
			backgrounds.set(element, { original: originalBackground, dark: darkBackground });
			saved.set(element, entry.originalStyle);
			const set = (name: string, value: string) => {
				element.style.setProperty(name, value, "important");
			};
			if (!element.parentElement) set("color-scheme", "dark");
			if (element.tagName === "IMG") {
				// Keep transparent logos readable on their original canvas; do not invert photos.
				set("background-color", cssColor(originalBackground)); set("color", cssColor(entry.color));
			} else {
				set("background-color", cssColor(surface(entry.background)));
				set("color", cssColor(readable(entry.color, darkBackground)));
				for (const border of entry.borders) set(border.name, cssColor(readable(border.color, darkBackground, 1.5)));
				if (entry.image !== "none" && !/url\(|image-set\(/i.test(entry.image)) set("background-image", "none");
				if (entry.textShadow !== "none") set("text-shadow", "none");
			}
		}
		applied = true;
	}
	return { setDark, restore };
}
