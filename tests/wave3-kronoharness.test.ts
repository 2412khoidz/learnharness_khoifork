import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import zlib from "node:zlib";
import {
	appendMobileCompanionSessionNoteOrReply,
	buildOutlineDigestIfNeeded,
	closePhoneUploadSession,
	createPhoneUploadSession,
	extractEpubText,
	getMobileCompanionSessionDetail,
	stopPhoneUploadTunnel,
} from "../src/server/index.ts";
import { newUserMessage } from "../src/core/index.ts";
import { chatStore } from "../src/store/chats.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "lh-wave3-"): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await closePhoneUploadSession();
	await stopPhoneUploadTunnel();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

/** Build a valid minimal ZIP buffer in memory (store method = 0 or deflate method = 8) for EPUB tests. */
function buildTestZip(entries: Array<{ name: string; content: string; compress?: boolean }>): Uint8Array {
	const localChunks: Buffer[] = [];
	const centralChunks: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const rawBuf = Buffer.from(entry.content, "utf8");
		const method = entry.compress ? 8 : 0;
		const payload = entry.compress ? zlib.deflateRawSync(rawBuf) : rawBuf;

		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4); // version needed
		localHeader.writeUInt16LE(0, 6); // flags
		localHeader.writeUInt16LE(method, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(0, 12);
		localHeader.writeUInt32LE(0, 14); // crc32 unused by reader
		localHeader.writeUInt32LE(payload.length, 18);
		localHeader.writeUInt32LE(rawBuf.length, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28);

		localChunks.push(localHeader, nameBuf, payload);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0, 8);
		centralHeader.writeUInt16LE(method, 10);
		centralHeader.writeUInt16LE(0, 12);
		centralHeader.writeUInt16LE(0, 14);
		centralHeader.writeUInt32LE(0, 16);
		centralHeader.writeUInt32LE(payload.length, 20);
		centralHeader.writeUInt32LE(rawBuf.length, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);

		centralChunks.push(centralHeader, nameBuf);
		offset += localHeader.length + nameBuf.length + payload.length;
	}

	const centralDir = Buffer.concat(centralChunks);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localChunks, centralDir, eocd]);
}

describe("Wave 3: Pin, Archive, Lesson Notes & Rewind Last Turn", () => {
	it("updates pinned, archived, notes metadata without bloating listChats summaries and sorts pinned first", () => {
		const a = chatStore.createChat("Wave3 Unpinned");
		const b = chatStore.createChat("Wave3 Pinned");
		try {
			chatStore.updateChatMeta?.(b.id, {
				pinned: true,
				notes: "## Key Formula\nBayes Rule: $P(A|B) = P(B|A)P(A)/P(B)$",
			});
			chatStore.updateChatMeta?.(a.id, { archived: true });

			const list = chatStore.listChats();
			const idxA = list.findIndex((c) => c.id === a.id);
			const idxB = list.findIndex((c) => c.id === b.id);
			assert.ok(idxB >= 0 && idxA >= 0);
			assert.ok(idxB < idxA, "Pinned session should sort before unpinned sessions");

			const sumB = list[idxB]!;
			assert.equal(sumB.pinned, true);
			assert.equal(sumB.hasNotes, true);
			assert.equal("notes" in sumB, false, "Full notes must stay out of sidebar summary payload");
			assert.equal(list[idxA]!.archived, true);
			assert.ok(chatStore.getChat(b.id)?.notes?.includes("Bayes Rule"));
		} finally {
			chatStore.deleteChat(a.id);
			chatStore.deleteChat(b.id);
		}
	});

	it("rewinds the transcript back to just before the last learner user turn and restores text", () => {
		const chat = chatStore.createChat("Wave3 Rewind Test");
		try {
			const m1 = newUserMessage("First question");
			const m2 = {
				id: "msg_a1",
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "First answer" }],
				api: "openai-responses" as const,
				provider: "test",
				model: "test-model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const m3 = newUserMessage("Typo in my second question");
			const m4 = { ...m2, id: "msg_a2", content: [{ type: "text" as const, text: "Reply to typo" }] };
			chatStore.saveMessages(chat.id, [m1, m2, m3, m4]);

			const rewound = chatStore.rewindLastUserTurn?.(chat.id);
			assert.ok(rewound);
			assert.equal(rewound.restoredText, "Typo in my second question");
			assert.equal(rewound.record.messages.length, 2);
			assert.equal(rewound.record.messages[0]?.id, m1.id);
			assert.equal(rewound.record.messages[1]?.id, m2.id);

			const rewound2 = chatStore.rewindLastUserTurn?.(chat.id);
			assert.ok(rewound2);
			assert.equal(rewound2.restoredText, "First question");
			assert.equal(rewound2.record.messages.length, 0);

			const rewoundEmpty = chatStore.rewindLastUserTurn?.(chat.id);
			assert.equal(rewoundEmpty, null);
		} finally {
			chatStore.deleteChat(chat.id);
		}
	});
});

describe("Wave 3: EPUB Extraction & Outline Digest", () => {
	it("extracts ordered XHTML chapters from an EPUB ZIP container and decodes entities", () => {
		const containerXml = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
		const opfXml = `<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;
		const ch1 = `<html><body><h1>Chapter 1: Limits</h1><p>Epsilon &amp; Delta &mdash; core definition.</p></body></html>`;
		const ch2 = `<html><body><h2>Chapter 2: Continuity</h2><p>Every differentiable function is continuous.</p></body></html>`;

		const zip = buildTestZip([
			{ name: "META-INF/container.xml", content: containerXml, compress: false },
			{ name: "OEBPS/content.opf", content: opfXml, compress: true },
			{ name: "OEBPS/ch2.xhtml", content: ch2, compress: true },
			{ name: "OEBPS/ch1.xhtml", content: ch1, compress: true },
		]);

		const res = extractEpubText(zip);
		assert.equal(res.kind, "ok");
		if (res.kind === "ok") {
			assert.equal(res.chapterCount, 2);
			const idx1 = res.text.indexOf("# Chapter 1: Limits");
			const idx2 = res.text.indexOf("## Chapter 2: Continuity");
			assert.ok(idx1 >= 0 && idx2 > idx1, "Spine order must put Chapter 1 before Chapter 2");
			assert.ok(res.text.includes("Epsilon & "));
		}
	});

	it("returns unreadable for non-ZIP bytes and prepends Outline Digest for long documents", () => {
		const bad = extractEpubText(new TextEncoder().encode("not a zip archive"));
		assert.equal(bad.kind, "unreadable");

		const shortDigest = buildOutlineDigestIfNeeded("# Short\n\nHello world.");
		assert.equal(shortDigest.outlined, false);

		const longBody = [
			"# Chapter 1: Probability",
			"A ".repeat(3500),
			"## 1.2 Conditional Expectation",
			"B ".repeat(3500),
		].join("\n\n");
		const longDigest = buildOutlineDigestIfNeeded(longBody);
		assert.equal(longDigest.outlined, true);
		assert.equal(longDigest.sectionCount, 2);
		assert.ok(longDigest.text.startsWith("[DOCUMENT OUTLINE DIGEST]"));
		assert.ok(longDigest.text.includes("- Chapter 1: Probability"));
		assert.ok(longDigest.text.includes("- 1.2 Conditional Expectation"));
	});
});

describe("Wave 3: Interactive Mobile Companion Session Reader & Reply", () => {
	it("serves GET and POST /p/:token/companion/session to read messages, save notes, and append mobile replies", async () => {
		const dir = await makeTempDir();
		const chatsDir = path.join(dir, "chats");
		const flashcardsFile = path.join(dir, "flashcards.json");
		const examPrepFile = path.join(dir, "exam-prep.json");
		await fs.mkdir(chatsDir, { recursive: true });

		const chatId = "chat_mobile_demo";
		await fs.writeFile(
			path.join(chatsDir, `${chatId}.json`),
			JSON.stringify({
				id: chatId,
				title: "Linear Algebra Practice",
				createdAt: "2026-11-15T00:00:00.000Z",
				updatedAt: "2026-11-15T00:10:00.000Z",
				kind: "practice",
				notes: "Existing note",
				messages: [
					newUserMessage("Give me an eigenvalue problem"),
					{
						id: "msg_asst_1",
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc_prob_1",
								name: "problem",
								arguments: { statement: "Find eigenvalues of [[2, 1], [1, 2]]" },
							},
						],
						timestamp: Date.now(),
					},
					{
						id: "msg_tr_1",
						role: "toolResult",
						toolCallId: "tc_prob_1",
						toolName: "problem",
						content: [{ type: "text", text: "Problem posed" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
			"utf8",
		);

		const detail = getMobileCompanionSessionDetail(chatId, { chatsDir });
		assert.equal(detail.mode, "practice");
		assert.equal(detail.notes, "Existing note");
		assert.equal(detail.pendingQuestionPrompt, "[Problem] Find eigenvalues of [[2, 1], [1, 2]]");
		assert.equal(detail.messages.length, 2);

		const info = await createPhoneUploadSession({
			host: "127.0.0.1",
			attachmentsDir: path.join(dir, "uploads"),
			flashcardsFile,
			examPrepFile,
			chatsDir,
			interfaces: {},
		});

		const base = `http://127.0.0.1:${info.port}/p/${encodeURIComponent(info.token)}`;
		const getRes = await fetch(`${base}/companion/session?chatId=${encodeURIComponent(chatId)}`);
		assert.equal(getRes.status, 200);
		const loaded = (await getRes.json()) as { title: string; messages: unknown[] };
		assert.equal(loaded.title, "Linear Algebra Practice");
		assert.equal(loaded.messages.length, 2);

		const postRes = await fetch(`${base}/companion/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chatId,
				note: "Eigenvalues are 3 and 1",
				replyText: "Lambda = 3 and 1",
			}),
		});
		assert.equal(postRes.status, 200);
		const updated = (await postRes.json()) as {
			ok: boolean;
			session: { notes: string; messages: Array<{ role: string; text: string }> };
		};
		assert.equal(updated.ok, true);
		assert.equal(updated.session.notes, "Eigenvalues are 3 and 1");
		assert.equal(updated.session.messages.at(-1)?.role, "user");
		assert.equal(updated.session.messages.at(-1)?.text, "Lambda = 3 and 1");

		// Sanity-check mobile HTML serves interactive reader & contains zero https:// strings
		const htmlRes = await fetch(base);
		assert.equal(htmlRes.status, 200);
		const html = await htmlRes.text();
		assert.ok(html.includes("session-reader"));
		assert.equal(html.includes("https://"), false);

		// Direct helper check
		const noteRes = await appendMobileCompanionSessionNoteOrReply(
			{ chatId, note: "Final note" },
			{ chatsDir },
		);
		assert.equal(noteRes.session.notes, "Final note");
	});
});
