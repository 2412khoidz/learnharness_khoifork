/** Search the whole graph without depending on accents or the current suggestions. */
export function normalizeConceptSearch(value: string): string {
	return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
}

export function isIncompleteProviderResponse(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /incomplete json segment at the end|unexpected end of json input/i.test(message);
}

/** Never retry authentication, quota, cancellation, or arbitrary network failures. */
export async function retryIncompleteOnce<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	try { return await run(); }
	catch (error) {
		if (signal?.aborted || !isIncompleteProviderResponse(error)) throw error;
		return run();
	}
}

export function mappingErrorMessage(error: unknown, signal?: AbortSignal): string {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "The request was cancelled. No FSRS reviews were saved.";
	if (isIncompleteProviderResponse(error)) return "The model's response ended before it could be read. Try a different model for this request; no FSRS reviews were saved.";
	const message = error instanceof Error ? error.message : "";
	if (/quota|rate.limit|429|resource.exhausted/i.test(message)) return "The model has reached its quota or rate limit. Check the provider or select another model.";
	if (/unauthori|forbidden|api.key|\b401\b|\b403\b/i.test(message)) return "The model could not authenticate. Check its connection in Settings or select another model.";
	return "The model could not complete this request. Check the connection or choose another model; no FSRS reviews were saved.";
}
