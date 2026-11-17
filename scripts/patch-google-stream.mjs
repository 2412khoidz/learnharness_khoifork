// Work around @google/genai 2.21.0 rejecting a complete final SSE event
// without an extra blank line. Fail closed unless the tail is valid JSON and
// contains an explicit successful terminal candidate. Never repair JSON.
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "node_modules", "@google", "genai");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (metadata.version !== "2.21.0") throw new Error("Re-evaluate the Google SSE workaround for the installed SDK version.");
const before = `                    if (done) {
                        if (buffer.trim().length > 0) {
                            throw new Error('Incomplete JSON segment at the end');
                        }
                        break;
                    }
                    const chunkString = decoder.decode(value, { stream: true });`;
const after = `                    // LearnHarness: only accept an undelimited, complete terminal SSE event.
                    if (done) {
                        if (buffer.trim().length === 0) break;
                        let terminal = false;
                        const match = /^data:\\s*(\\{[^\\r\\n]*\\})\\s*$/.exec(buffer.trim());
                        if (match) {
                            try {
                                const payload = JSON.parse(match[1]);
                                terminal = Array.isArray(payload.candidates) && payload.candidates.some((candidate) => candidate && candidate.finishReason === 'STOP');
                            } catch { /* not a complete JSON event */ }
                        }
                        if (!terminal) throw new Error('Incomplete JSON segment at the end');
                        buffer += '\\n\\n';
                    }
                    const chunkString = done ? '' : decoder.decode(value, { stream: true });`;
for (const name of ["dist/node/index.mjs", "dist/node/index.cjs", "dist/index.mjs", "dist/index.cjs"]) {
	const file = path.join(root, name);
	const text = fs.readFileSync(file, "utf8");
	if (text.includes("LearnHarness: only accept an undelimited")) continue;
	if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Google SSE patch does not match ${name}; refusing to guess.`);
	fs.writeFileSync(file, text.replace(before, after));
}
console.log("Google SDK terminal SSE workaround verified (2.21.0).");
