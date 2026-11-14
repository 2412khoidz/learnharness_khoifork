import * as path from "node:path";
import * as zlib from "node:zlib";

export type EpubExtractResult =
	| { kind: "ok"; text: string; chapterCount: number }
	| { kind: "unreadable"; error: string };

const MAX_EPUB_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

interface ZipCentralEntry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

function readZipCentralDirectory(view: DataView, len: number): ZipCentralEntry[] | null {
	const minOffset = Math.max(0, len - 65558);
	let eocdOffset = -1;
	for (let i = len - 22; i >= minOffset; i--) {
		if (view.getUint32(i, true) === ZIP_EOCD_SIG) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset < 0) return null;

	const entryCount = view.getUint16(eocdOffset + 10, true);
	const cdSize = view.getUint32(eocdOffset + 12, true);
	const cdOffset = view.getUint32(eocdOffset + 16, true);
	if (cdOffset + cdSize > len) return null;

	const entries: ZipCentralEntry[] = [];
	let pos = cdOffset;
	for (let i = 0; i < entryCount && pos + 46 <= cdOffset + cdSize; i++) {
		if (view.getUint32(pos, true) !== ZIP_CD_SIG) break;
		const method = view.getUint16(pos + 10, true);
		const compressedSize = view.getUint32(pos + 20, true);
		const uncompressedSize = view.getUint32(pos + 24, true);
		const nameLen = view.getUint16(pos + 28, true);
		const extraLen = view.getUint16(pos + 30, true);
		const commentLen = view.getUint16(pos + 32, true);
		const localHeaderOffset = view.getUint32(pos + 42, true);
		const nameStart = pos + 46;
		const nameEnd = nameStart + nameLen;
		if (nameEnd > len) break;
		const nameBytes = new Uint8Array(view.buffer, view.byteOffset + nameStart, nameLen);
		const name = new TextDecoder().decode(nameBytes).replace(/\\/g, "/");
		entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
		pos = nameEnd + extraLen + commentLen;
	}
	return entries;
}

function readZipEntryData(bytes: Uint8Array, view: DataView, entry: ZipCentralEntry): Uint8Array | null {
	const off = entry.localHeaderOffset;
	if (off + 30 > bytes.length || view.getUint32(off, true) !== ZIP_LOCAL_SIG) return null;
	const nameLen = view.getUint16(off + 26, true);
	const extraLen = view.getUint16(off + 28, true);
	const dataStart = off + 30 + nameLen + extraLen;
	const dataEnd = dataStart + entry.compressedSize;
	if (dataEnd > bytes.length || entry.uncompressedSize > MAX_EPUB_UNCOMPRESSED_BYTES) return null;
	const slice = bytes.subarray(dataStart, dataEnd);
	if (entry.method === 0) return slice;
	if (entry.method === 8) {
		try {
			return zlib.inflateRawSync(slice, { maxOutputLength: MAX_EPUB_UNCOMPRESSED_BYTES });
		} catch {
			return null;
		}
	}
	return null;
}

function extractZipTextEntries(bytes: Uint8Array): Map<string, string> | null {
	if (bytes.length < 22) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const central = readZipCentralDirectory(view, bytes.length);
	if (!central || central.length === 0) return null;

	const files = new Map<string, string>();
	let totalBytes = 0;
	const decoder = new TextDecoder("utf-8", { fatal: false });
	for (const entry of central) {
		if (entry.name.endsWith("/")) continue;
		if (!/\.(?:xhtml|html|htm|opf|xml|ncx)$/i.test(entry.name)) continue;
		const data = readZipEntryData(bytes, view, entry);
		if (!data) continue;
		totalBytes += data.length;
		if (totalBytes > MAX_EPUB_UNCOMPRESSED_BYTES) break;
		files.set(entry.name, decoder.decode(data));
	}
	return files;
}

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&(apos|#39);/gi, "'")
		.replace(/&#(\d+);/g, (_, dec) => {
			const code = Number.parseInt(dec, 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
		})
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			const code = Number.parseInt(hex, 16);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
		});
}

function xhtmlToMarkdown(html: string): string {
	let text = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
		.replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

	text = text
		.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
		.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
		.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(?:br|hr)\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|section|article|blockquote|tr|h[4-6]|li|ul|ol)>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ");

	text = decodeHtmlEntities(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return text;
}

function parseOpfSpineOrder(files: Map<string, string>): string[] {
	let opfPath: string | undefined;
	const container = files.get("META-INF/container.xml");
	if (container) {
		const m = /full-path\s*=\s*["']([^"']+)["']/i.exec(container);
		if (m?.[1] && files.has(m[1])) opfPath = m[1];
	}
	if (!opfPath) {
		for (const key of files.keys()) {
			if (key.toLowerCase().endsWith(".opf")) {
				opfPath = key;
				break;
			}
		}
	}
	if (!opfPath) return [];
	const opfContent = files.get(opfPath) ?? "";
	const baseDir = path.posix.dirname(opfPath);

	const manifest = new Map<string, string>();
	const itemRe = /<item\b([^>]+?)\/?\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = itemRe.exec(opfContent)) !== null) {
		const attrs = match[1] ?? "";
		const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
		const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
		const mediaType = /\bmedia-type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
		if (!id || !href) continue;
		if (mediaType && !/html|xhtml/i.test(mediaType)) continue;
		const cleanHref = href.split("#")[0] ?? href;
		const decoded = (() => {
			try {
				return decodeURIComponent(cleanHref);
			} catch {
				return cleanHref;
			}
		})();
		const resolved = baseDir === "." ? decoded : path.posix.normalize(`${baseDir}/${decoded}`);
		manifest.set(id, resolved);
	}

	const ordered: string[] = [];
	const seen = new Set<string>();
	const itemRefRe = /<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
	while ((match = itemRefRe.exec(opfContent)) !== null) {
		const idref = match[1];
		if (!idref) continue;
		const resolved = manifest.get(idref);
		if (resolved && files.has(resolved) && !seen.has(resolved)) {
			seen.add(resolved);
			ordered.push(resolved);
		}
	}
	return ordered;
}

/** Extract ordered plain-text / Markdown chapters from an EPUB archive without native dependencies. */
export function extractEpubText(bytes: Uint8Array): EpubExtractResult {
	if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
		return { kind: "unreadable", error: "Could not open this EPUB (invalid ZIP archive)." };
	}
	const files = extractZipTextEntries(bytes);
	if (!files || files.size === 0) {
		return { kind: "unreadable", error: "Could not extract chapters from this EPUB." };
	}

	let docPaths = parseOpfSpineOrder(files);
	if (docPaths.length === 0) {
		docPaths = Array.from(files.keys())
			.filter((name) => /\.(?:xhtml|html|htm)$/i.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	}

	const sections: string[] = [];
	for (const docPath of docPaths) {
		const rawHtml = files.get(docPath);
		if (!rawHtml) continue;
		const md = xhtmlToMarkdown(rawHtml);
		if (!md) continue;
		const hasHeading = /^#{1,3}\s+\S/m.test(md);
		if (hasHeading) {
			sections.push(md);
		} else {
			const fallbackName = path.posix.basename(docPath).replace(/\.(?:xhtml|html|htm)$/i, "");
			sections.push(`## ${fallbackName}\n\n${md}`);
		}
	}

	if (sections.length === 0) {
		return { kind: "unreadable", error: "This EPUB contains no readable text chapters." };
	}

	return {
		kind: "ok",
		text: sections.join("\n\n"),
		chapterCount: sections.length,
	};
}

/** Prepend a concise structural Outline Digest header for long books or documents
 * so downstream extraction chunks retain global chapter context. */
export function buildOutlineDigestIfNeeded(
	text: string,
	minChars = 12_000,
): { text: string; outlined: boolean; sectionCount: number } {
	if (text.length < minChars) {
		return { text, outlined: false, sectionCount: 0 };
	}

	const headings: string[] = [];
	const seen = new Set<string>();
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const mdMatch = /^(#{1,3})\s+(.+)$/.exec(line);
		const chMatch = !mdMatch ? /^((?:Chapter|CHAPTER|Part|PART|Section|SECTION)\s+[^\n]{1,70})$/.exec(line) : null;
		const label = (mdMatch?.[2] ?? chMatch?.[1])?.trim();
		if (!label || label.length > 90) continue;
		const normalized = label.replace(/\s+/g, " ");
		if (!seen.has(normalized)) {
			seen.add(normalized);
			headings.push(normalized);
			if (headings.length >= 25) break;
		}
	}

	if (headings.length < 2) {
		return { text, outlined: false, sectionCount: headings.length };
	}

	const wordEstimate = text.trim().split(/\s+/).filter(Boolean).length;
	const headerLines = [
		"[DOCUMENT OUTLINE DIGEST]",
		`Length: ~${wordEstimate.toLocaleString("en-US")} words (${text.length.toLocaleString("en-US")} chars)`,
		"Detected sections:",
		...headings.map((h) => `- ${h}`),
		"[END OUTLINE DIGEST]",
	];

	return {
		text: `${headerLines.join("\n")}\n\n${text}`,
		outlined: true,
		sectionCount: headings.length,
	};
}
