/**
 * Shared output-language catalog for knowledge extraction (Graph) and
 * flashcard generation. `"auto"` keeps the primary language of the teaching
 * session / source notes instead of defaulting to English.
 */

export const EXTRACTION_LANGUAGES = [
	{ value: "auto", label: "Auto (match session/notes)", promptName: null },
	{ value: "vi", label: "Tiếng Việt (Vietnamese)", promptName: "Vietnamese" },
	{ value: "en", label: "English", promptName: "English" },
	{ value: "ja", label: "日本語 (Japanese)", promptName: "Japanese" },
	{ value: "zh", label: "中文 (Chinese)", promptName: "Chinese" },
	{ value: "ko", label: "한국어 (Korean)", promptName: "Korean" },
	{ value: "fr", label: "Français (French)", promptName: "French" },
	{ value: "de", label: "Deutsch (German)", promptName: "German" },
	{ value: "es", label: "Español (Spanish)", promptName: "Spanish" },
] as const;

export type ExtractionLanguage = (typeof EXTRACTION_LANGUAGES)[number]["value"];

const EXTRACTION_LANGUAGE_SET = new Set<string>(EXTRACTION_LANGUAGES.map((l) => l.value));

export function isExtractionLanguage(value: unknown): value is ExtractionLanguage {
	return typeof value === "string" && EXTRACTION_LANGUAGE_SET.has(value);
}

/** English instruction name for non-auto languages (`null` for `"auto"`). */
export function extractionLanguagePromptName(lang: ExtractionLanguage | undefined): string | null {
	if (!lang || lang === "auto") return null;
	return EXTRACTION_LANGUAGES.find((entry) => entry.value === lang)?.promptName ?? null;
}
