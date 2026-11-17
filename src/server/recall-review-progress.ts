import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

type Entry = { sequence: number; value: unknown };
type Progress = { version: 1; entries: Record<string, Entry> };
const file = () => path.join(PATHS.data, "recall-review-progress.json");
function read(): Progress {
 try {
  const value: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
  if (!value || typeof value !== "object" || (value as Progress).version !== 1 || !(value as Progress).entries || typeof (value as Progress).entries !== "object") throw new Error("Invalid review progress data.");
  return value as Progress;
 } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} }; throw error; }
}
function validKey(key: string) { return key.length <= 500 && (key.startsWith("group:") || key.startsWith("audit:") || key === "meta:group"); }
export function readReviewProgress(key: string): Entry | null { if (!validKey(key)) throw new Error("Invalid review key."); return read().entries[key] ?? null; }
export function saveReviewProgress(key: string, sequence: number, value: unknown): void {
 if (!validKey(key) || !Number.isSafeInteger(sequence) || sequence < 0 || !value || typeof value !== "object" || JSON.stringify(value).length > 2_000_000) throw new Error("Invalid review progress.");
 const data = read();
 if ((data.entries[key]?.sequence ?? -1) >= sequence) return;
 data.entries[key] = { sequence, value };
 fs.mkdirSync(PATHS.data, { recursive: true });
 writeFileAtomicSync(file(), JSON.stringify(data), { allowInPlaceFallback: true });
}
