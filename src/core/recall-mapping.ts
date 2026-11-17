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


/** Classify only actionable failures; never retry credentials, quota or cancellation. */
export function recallFailureKind(error: unknown): "cancelled" | "auth" | "quota" | "transient" | "split" | "unknown" {
 const msg = error instanceof Error ? error.message : String(error);
 if ((error instanceof Error && error.name === "AbortError") || /cancelled|canceled|aborted/i.test(msg)) return "cancelled";
 if (/quota|rate.limit|429|resource.exhausted/i.test(msg)) return "quota";
 if (/unauthori|forbidden|api.key|\b401\b|\b403\b/i.test(msg)) return "auth";
 if (isIncompleteProviderResponse(error) || /did not submit|never submitted|invalid.*(json|schema|argument)|context.{0,20}(length|limit|window)|too (large|long|many tokens)|max(imum)?[_ -]?(output|context|token)|output.{0,20}(truncat|limit)|finish.reason.{0,8}length/i.test(msg)) return "split";
 if (/timeout|timed out|network|connection|socket|\b5\d\d\b/i.test(msg)) return "transient";
 return "unknown";
}

/** Batch by size as well as count; never trim a single source answer. */
export function batchRecallBySize<T>(items: readonly T[], weight: (item: T) => number, maxItems = 8, maxChars = 14000): T[][] {
 const batches: T[][] = []; let batch: T[] = [], chars = 0;
 for (const item of items) { const size = Math.max(0, weight(item)); if (batch.length && (batch.length >= maxItems || chars + size > maxChars)) { batches.push(batch); batch = []; chars = 0; } batch.push(item); chars += size; }
 if (batch.length) batches.push(batch);
 return batches;
}
