import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { MistakeDraft } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
export type MistakeDismissal = { id: string; fingerprint: string; dismissedAt: string };
const file = () => path.join(PATHS.data, "mistake-dismissals.json");
export const mistakeSourceFingerprint = (draft: Pick<MistakeDraft, "id" | "question" | "yourAnswer" | "correctAnswer" | "answeredAt">) => createHash("sha256").update(JSON.stringify([draft.id, draft.question, draft.yourAnswer, draft.correctAnswer, draft.answeredAt])).digest("hex");
export function readMistakeDismissals(): MistakeDismissal[] { try { const data: unknown = JSON.parse(fs.readFileSync(file(), "utf8")); if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1 || !Array.isArray((data as { entries?: unknown }).entries)) throw new Error("Invalid mistake dismissal data."); return (data as { entries: MistakeDismissal[] }).entries; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
export function writeMistakeDismissals(entries: MistakeDismissal[]) { fs.mkdirSync(PATHS.data, { recursive: true }); writeFileAtomicSync(file(), JSON.stringify({ version: 1, entries }), { allowInPlaceFallback: true }); }
export function isDismissedMistake(draft: MistakeDraft, dismissals = readMistakeDismissals()): boolean { return dismissals.some((entry) => entry.id === draft.id && entry.fingerprint === mistakeSourceFingerprint(draft)); }
