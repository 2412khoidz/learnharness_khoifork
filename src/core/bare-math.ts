/** Display-only bare-math recovery for legacy graph propositions/statements
 * that omitted `$...$` delimiters (e.g. `Q_1 - 1.5 \times IQR` or `(a - tb)^2 ≥ 0`).
 * Never mutates stored data and leaves code, URLs, paths, snake_case, and
 * existing delimited math spans untouched. */
import { canParseTex, knownTexCommand, readContentSpans } from "./content-reader.ts";

interface Span { start: number; end: number }

const ARG_TEX_COMMANDS = new Set([
	"frac", "dfrac", "tfrac", "cfrac", "binom", "dbinom", "tbinom",
	"sqrt", "mathbb", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "mathfrak",
	"operatorname", "text", "textbf", "textit", "textrm", "textsf", "texttt",
	"hat", "widehat", "bar", "overline", "underline", "tilde", "widetilde", "vec", "dot", "ddot",
	"overset", "underset", "stackrel",
]);

const INFIX_TEX_COMMANDS = new Set([
	"in", "notin", "ni",
	"subset", "subseteq", "supset", "supseteq", "subsetneq",
	"cup", "cap", "setminus",
	"le", "leq", "ge", "geq", "ne", "neq",
	"approx", "equiv", "cong", "sim", "simeq", "propto",
	"ll", "gg",
	"to", "rightarrow", "leftarrow", "gets", "leftrightarrow", "mapsto",
	"implies", "Rightarrow", "impliedby", "Leftarrow", "iff", "Leftrightarrow",
	"land", "wedge", "lor", "vee",
	"oplus", "otimes", "pm", "mp", "times", "div", "cdot",
	"parallel", "perp", "mid", "vdash", "models",
]);

const PREFIX_TEX_COMMANDS = new Set([
	"forall", "exists", "nexists", "neg", "lnot",
	"sum", "prod", "coprod", "int", "iint", "iiint", "oint",
	"lim", "limsup", "liminf", "sup", "inf", "max", "min", "argmax", "argmin",
	"sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
	"sinh", "cosh", "tanh", "log", "ln", "exp", "det", "dim", "ker", "gcd", "lcm", "Pr",
]);

const CONTINUATION_TEX_COMMANDS = new Set(["dots", "ldots", "cdots"]);

const MATH_WORD_ALLOWLIST = new Set([
	"lim", "limsup", "liminf", "sup", "inf", "max", "min", "argmax", "argmin",
	"log", "ln", "exp", "sin", "cos", "tan", "cot", "sec", "csc",
	"arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
	"arg", "det", "dim", "ker", "gcd", "lcm", "deg", "mod", "bmod", "pmod",
	"Pr", "Var", "Cov", "Corr", "Bias", "MSE", "RMSE", "MAE", "SSE", "SSR", "SST",
	"IQR", "SD", "SE", "PDF", "CDF", "PMF", "CLT", "df",
]);

const PROSE_ALL_CAPS_BLOCKLIST = new Set(["AND", "OR", "IF", "IS", "IN", "AS", "TO", "OF", "BY", "ON", "AT", "NO", "NOT", "THE", "FOR"]);

const UNICODE_BINARY_OPS = new Set([
	"≤", "≥", "≠", "≈", "≡", "∼", "±", "∓", "×", "÷", "·",
	"∈", "∉", "⊂", "⊆", "⊃", "⊇", "∪", "∩", "→", "←", "↔", "⇒", "⇔", "⟹", "⟺", "∧", "∨", "∣",
]);

const isWordChar = (ch: string | undefined): boolean => Boolean(ch && /[\p{L}\p{N}_]/u.test(ch));
const isLetterChar = (ch: string | undefined): boolean => Boolean(ch && /\p{L}/u.test(ch));

function isEscaped(text: string, idx: number): boolean {
	let slashes = 0;
	for (let i = idx - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
	return slashes % 2 === 1;
}

function hasUnescapedDollar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "$" && !isEscaped(text, i)) return true;
	}
	return false;
}

function mergeSpans(spans: Span[]): Span[] {
	if (spans.length <= 1) return spans;
	const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Span[] = [sorted[0]!];
	for (let i = 1; i < sorted.length; i++) {
		const prev = merged.at(-1)!;
		const cur = sorted[i]!;
		if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end);
		else merged.push({ ...cur });
	}
	return merged;
}

function collectProtectedRanges(line: string): Span[] {
	const ranges: Span[] = [];
	const prefix = /^[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)/.exec(line);
	if (prefix?.[0]) ranges.push({ start: 0, end: prefix[0].length });

	const patterns = [
		/!?\[[^\]\r\n]*\]\([^)\r\n]*\)/g,
		/https?:\/\/[^\s)<>\]"']+/g,
		/(?:[A-Za-z]:\\|\\\\)[^\s,;()[\]{}"']*/g,
		/(?:^|(?<=[\s(]))\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g,
	];
	for (const re of patterns) {
		for (const m of line.matchAll(re)) {
			if (m.index !== undefined && m[0]) ranges.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	return mergeSpans(ranges);
}

function findProtectedAt(pos: number, protectedRanges: Span[]): Span | undefined {
	return protectedRanges.find((r) => pos >= r.start && pos < r.end);
}

function overlapsProtected(start: number, end: number, protectedRanges: Span[]): boolean {
	return protectedRanges.some((r) => r.start < end && start < r.end);
}

function readBracedGroup(line: string, start: number): number {
	if (line[start] !== "{") return -1;
	let depth = 1;
	let i = start + 1;
	while (i < line.length && depth > 0) {
		if (line[i] === "\\") {
			i += 2;
			continue;
		}
		if (line[i] === "{") depth++;
		else if (line[i] === "}") depth--;
		i++;
	}
	return depth === 0 ? i : -1;
}

function readForwardBalanced(line: string, openIdx: number): number {
	const open = line[openIdx];
	const close = open === "(" ? ")" : open === "[" ? "]" : "}";
	let depth = 1;
	let brace = 0;
	let i = openIdx + 1;
	while (i < line.length && depth > 0) {
		const ch = line[i]!;
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (open !== "{") {
			if (ch === "{") brace++;
			else if (ch === "}" && brace > 0) brace--;
		}
		if (brace === 0) {
			if (ch === open) depth++;
			else if (ch === close) depth--;
		}
		i++;
	}
	return depth === 0 ? i : -1;
}

function readBackwardBalanced(line: string, closeIdx: number, minStart: number): number {
	const close = line[closeIdx];
	const open = close === ")" ? "(" : "[";
	let parenDepth = close === ")" ? 1 : 0;
	let bracketDepth = close === "]" ? 1 : 0;
	let braceDepth = 0;
	let i = closeIdx - 1;
	while (i >= minStart && (parenDepth > 0 || bracketDepth > 0)) {
		const ch = line[i]!;
		if (isEscaped(line, i)) {
			i -= 2;
			continue;
		}
		if (ch === "}") braceDepth++;
		else if (ch === "{" && braceDepth > 0) braceDepth--;
		else if (braceDepth === 0) {
			if (ch === ")") parenDepth++;
			else if (ch === "(") parenDepth--;
			else if (ch === "]") bracketDepth++;
			else if (ch === "[") bracketDepth--;
		}
		if (parenDepth < 0 || bracketDepth < 0) return -1;
		i--;
	}
	return parenDepth === 0 && bracketDepth === 0 ? i + 1 : -1;
}

function isMathBracketContent(inner: string, hasPrefixToken: boolean): boolean {
	const trimmed = inner.trim();
	if (!trimmed) return false;
	// Explicit math signals inside brackets: digits, scripts, TeX commands, binary/relation ops, primes, or single-letter calls `f'(x)`.
	const hasStrongSignal = /[0-9^_=<>+\-*/×÷·±≤≥≠≈≡∈∉⊂∪∩→←⇒⇔⟹⟺|']|\\[A-Za-z]{2,}/.test(trimmed)
		|| /^[A-Za-z\u0391-\u03c9]['′]*\([^()\s]{1,16}\)$/.test(trimmed);
	if (!/\s/.test(trimmed)) {
		if (hasStrongSignal || trimmed.length <= 2) return true;
		return hasPrefixToken && (MATH_WORD_ALLOWLIST.has(trimmed) || /^[A-Z]{2,4}$/.test(trimmed));
	}
	const parts = trimmed.split(/\s+/).map((p) => p.replace(/^[,;:]+|[,;:]+$/g, "")).filter(Boolean);
	let proseWordCount = 0;
	for (const part of parts) {
		if (/^\\[A-Za-z]+/.test(part) || MATH_WORD_ALLOWLIST.has(part) || /^[A-Z]{2,4}$/.test(part)) continue;
		if (/[0-9^_=<>+\-*/×÷·±≤≥≠≈≡∈∉⊂∪∩→←⇒⇔⟹⟺|{}]/.test(part)) continue;
		if (/^\p{L}{2,}$/u.test(part)) {
			if (part.length >= 3) return false;
			proseWordCount++;
			if (proseWordCount >= 2) return false;
		}
	}
	return hasStrongSignal || parts.every((p) => p.length <= 2 || MATH_WORD_ALLOWLIST.has(p));
}

function readScriptRhsAt(line: string, rhsStart: number, marker: string): number {
	const first = line[rhsStart];
	if (!first) return -1;
	if (first === "{") return readBracedGroup(line, rhsStart);
	if (first === "\\") return readTexAtomAt(line, rhsStart);
	if (marker === "^") {
		const num = /^-?\d+/.exec(line.slice(rhsStart));
		if (num?.[0]) return rhsStart + num[0].length;
		if (first === "*" || first === "′" || first === "'") return rhsStart + 1;
		if (/[A-Za-z\u0391-\u03c9]/.test(first) && !isWordChar(line[rhsStart + 1])) return rhsStart + 1;
		return -1;
	}
	// Subscript RHS: digits (not immediately followed by word letter/underscore) or single letter.
	const digits = /^\d+/.exec(line.slice(rhsStart));
	if (digits?.[0] && !isWordChar(line[rhsStart + digits[0].length])) return rhsStart + digits[0].length;
	if (/[A-Za-z\u0391-\u03c9]/.test(first) && !isWordChar(line[rhsStart + 1])) return rhsStart + 1;
	return -1;
}

function consumeAttachedScripts(line: string, pos: number): number {
	let cur = pos;
	while (cur < line.length) {
		const ch = line[cur];
		if (ch === "'" || ch === "′") {
			cur++;
			continue;
		}
		if (ch !== "_" && ch !== "^") break;
		const next = readScriptRhsAt(line, cur + 1, ch);
		if (next <= cur + 1) break;
		cur = next;
	}
	return cur;
}

function readTexAtomAt(line: string, idx: number, protectedRanges: Span[] = []): number {
	if (line[idx] !== "\\" || isEscaped(line, idx)) return -1;
	if (idx > 0 && line[idx - 1] === "\\") return -1;
	if (findProtectedAt(idx, protectedRanges)) return -1;
	if (idx >= 2 && /[a-z]{2}$/.test(line.slice(0, idx))) return -1;

	const cmdMatch = /^\\([A-Za-z]+)/.exec(line.slice(idx));
	if (!cmdMatch) {
		// Escaped math delimiter like \{ or \} or \| when adjacent to non-escaped math text.
		if (line[idx + 1] === "{" && !overlapsProtected(idx, idx + 2, protectedRanges)) {
			// Match escaped \{ ... \} set notation only when closed on the same line.
			const closeIdx = line.indexOf("\\}", idx + 2);
			if (closeIdx > idx + 2 && !overlapsProtected(idx, closeIdx + 2, protectedRanges)) {
				return closeIdx + 2;
			}
		}
		return -1;
	}
	const name = cmdMatch[1]!;
	if (name === "begin") {
		const envMatch = /^\\begin\{([^{}]+)\}/.exec(line.slice(idx));
		if (envMatch) {
			const endToken = `\\end{${envMatch[1]}}`;
			const endIdx = line.indexOf(endToken, idx + envMatch[0].length);
			if (endIdx >= 0) return endIdx + endToken.length;
		}
		return -1;
	}
	if (name === "left") {
		// Match \left ... \right<delim> on the same line.
		let depth = 1;
		let scan = idx + cmdMatch[0].length;
		while (scan < line.length && depth > 0) {
			if (line.startsWith("\\left", scan) && !isEscaped(line, scan)) depth++;
			else if (line.startsWith("\\right", scan) && !isEscaped(line, scan)) {
				depth--;
				if (depth === 0) {
					scan += 6;
					while (scan < line.length && line[scan] === " ") scan++;
					if (line[scan] === "\\") scan += /^\\[A-Za-z]+|^\\./.exec(line.slice(scan))?.[0]?.length ?? 1;
					else if (scan < line.length) scan++;
					return consumeAttachedScripts(line, scan);
				}
			}
			scan++;
		}
		return -1;
	}
	if (name.length < 2 || !knownTexCommand(name)) return -1;

	let cur = idx + cmdMatch[0].length;
	if (name === "sqrt" && line[cur] === "[") {
		const closeBracket = line.indexOf("]", cur + 1);
		if (closeBracket > cur) cur = closeBracket + 1;
	}
	const maxArgs = name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac" || name === "binom" || name === "dbinom" || name === "tbinom" || name === "overset" || name === "underset" || name === "stackrel" ? 2 : 1;
	const allowSpaceBeforeArg = ARG_TEX_COMMANDS.has(name);
	for (let a = 0; a < maxArgs; a++) {
		let argPos = cur;
		if (allowSpaceBeforeArg) {
			while (argPos < line.length && (line[argPos] === " " || line[argPos] === "\t")) argPos++;
		}
		if (line[argPos] !== "{") break;
		const groupEnd = readBracedGroup(line, argPos);
		if (groupEnd < 0) break;
		cur = groupEnd;
	}
	return consumeAttachedScripts(line, cur);
}

function readShortFunctionPrefixBeforeOpen(line: string, openIdx: number, minStart: number): number {
	let p = openIdx;
	while (p > minStart && (line[p - 1] === "'" || line[p - 1] === "′")) p--;
	let wordStart = p;
	while (wordStart > minStart && /[A-Za-z\u0391-\u03c9]/.test(line[wordStart - 1]!)) wordStart--;
	const word = line.slice(wordStart, p);
	if (!word) return openIdx;
	if (wordStart > minStart && line[wordStart - 1] === "\\" && !isEscaped(line, wordStart - 1)) {
		return knownTexCommand(word) ? wordStart - 1 : openIdx;
	}
	if (wordStart > minStart && isWordChar(line[wordStart - 1])) return openIdx;
	if (word.length === 1 || MATH_WORD_ALLOWLIST.has(word)) return wordStart;
	return openIdx;
}

function findStrongAnchors(line: string, protectedRanges: Span[]): Span[] {
	const anchors: Span[] = [];
	let i = 0;
	while (i < line.length) {
		const prot = findProtectedAt(i, protectedRanges);
		if (prot) {
			i = prot.end;
			continue;
		}
		if (line[i] === "\\") {
			const texEnd = readTexAtomAt(line, i, protectedRanges);
			if (texEnd > i) {
				anchors.push({ start: i, end: texEnd });
				i = texEnd;
				continue;
			}
			i++;
			continue;
		}
		if ((line[i] === "^" || line[i] === "_") && !isEscaped(line, i)) {
			const marker = line[i]!;
			if (marker === "_" && line[i + 1] === "_") {
				i += 2;
				continue;
			}
			if (marker === "^" && i > 0 && line[i - 1] === "[") {
				i++;
				continue;
			}
			const rhsEnd = readScriptRhsAt(line, i + 1, marker);
			if (rhsEnd <= i + 1) {
				i++;
				continue;
			}
			const prev = line[i - 1];
			let baseStart = -1;
			if (prev === ")" || prev === "]") {
				const openIdx = readBackwardBalanced(line, i - 1, 0);
				if (openIdx >= 0 && !overlapsProtected(openIdx, i, protectedRanges)) {
					const prefixStart = readShortFunctionPrefixBeforeOpen(line, openIdx, 0);
					if (isMathBracketContent(line.slice(openIdx + 1, i - 1), prefixStart < openIdx)) {
						baseStart = prefixStart;
					}
				}
			} else if (marker === "^") {
				let p = i;
				while (p > 0 && (line[p - 1] === "'" || line[p - 1] === "′")) p--;
				let numStart = p;
				while (numStart > 0 && /[0-9]/.test(line[numStart - 1]!)) numStart--;
				if (numStart < p && (numStart === 0 || !isWordChar(line[numStart - 1]))) {
					baseStart = numStart;
				} else {
					let wordStart = p;
					while (wordStart > 0 && /[A-Za-z\u0391-\u03c9]/.test(line[wordStart - 1]!)) wordStart--;
					const baseWord = line.slice(wordStart, p);
					const boundaryOk = wordStart === 0 || !isWordChar(line[wordStart - 1]);
					if (baseWord && boundaryOk) {
						const bracedOrDigitRhs = line[i + 1] === "{" || /^-?\d/.test(line.slice(i + 1));
						if (baseWord.length === 1 || bracedOrDigitRhs) baseStart = wordStart;
					}
				}
			} else {
				// Subscript `_`: require 1-letter base (e.g. `Q_1`, `x_n`, `H_0`),
				// or short math base ONLY with braced `{...}` RHS (`IQR_{upper}`).
				let wordStart = i;
				while (wordStart > 0 && /[A-Za-z\u0391-\u03c9]/.test(line[wordStart - 1]!)) wordStart--;
				const baseWord = line.slice(wordStart, i);
				const boundaryOk = wordStart === 0 || !isWordChar(line[wordStart - 1]);
				if (baseWord && boundaryOk && (baseWord.length === 1 || (baseWord.length <= 4 && line[i + 1] === "{"))) {
					baseStart = wordStart;
				}
			}
			if (baseStart >= 0 && !overlapsProtected(baseStart, rhsEnd, protectedRanges)) {
				const finalEnd = consumeAttachedScripts(line, rhsEnd);
				anchors.push({ start: baseStart, end: finalEnd });
				i = finalEnd;
				continue;
			}
		}
		i++;
	}
	return mergeSpans(anchors);
}

function endsWithCommand(slice: string, set: Set<string>): boolean {
	const m = /\\([A-Za-z]+)$/.exec(slice);
	return Boolean(m && set.has(m[1]!));
}

function endsWithPrefixMathToken(slice: string): boolean {
	const m = /\\([A-Za-z]+)(?:_\{[^{}]+\}|_[A-Za-z0-9]|\^\{[^{}]+\}|\^[A-Za-z0-9])*$/.exec(slice);
	if (m && PREFIX_TEX_COMMANDS.has(m[1]!)) return true;
	return /\\(?:frac|dfrac|tfrac|cfrac|binom|sqrt)\b[^=<>]*\}$/.test(slice);
}

function startsWithInfixCommand(slice: string): boolean {
	const m = /^\\([A-Za-z]+)/.exec(slice);
	return Boolean(m && INFIX_TEX_COMMANDS.has(m[1]!));
}

function startsWithContinuationCommand(slice: string): boolean {
	const m = /^\\([A-Za-z]+)/.exec(slice);
	return Boolean(m && CONTINUATION_TEX_COMMANDS.has(m[1]!));
}

function readBinaryOpForward(line: string, opPos: number, prevSlice: string): { opEnd: number; op: string } | null {
	const two = line.slice(opPos, opPos + 2);
	if (two === "<=" || two === ">=" || two === "!=") return { opEnd: opPos + 2, op: two };
	const ch = line[opPos];
	if (!ch) return null;
	if (UNICODE_BINARY_OPS.has(ch) || ch === "=" || ch === "<" || ch === ">" || ch === "+" || ch === "/") {
		return { opEnd: opPos + 1, op: ch };
	}
	if (ch === "*" && line[opPos + 1] !== "*" && line[opPos - 1] !== "*") {
		return { opEnd: opPos + 1, op: ch };
	}
	if (ch === "-") {
		const spaceBefore = opPos > 0 && (line[opPos - 1] === " " || line[opPos - 1] === "\t");
		const spaceAfter = line[opPos + 1] === " " || line[opPos + 1] === "\t";
		// Reject `-word` hyphenated compounds unless space-flanked or followed by digit/single-letter/paren/TeX.
		if (spaceBefore && spaceAfter) return { opEnd: opPos + 1, op: "-" };
		if (!spaceBefore && !spaceAfter) {
			const nextWord = /^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]{2,}/.exec(line.slice(opPos + 1));
			if (nextWord) return null;
			return { opEnd: opPos + 1, op: "-" };
		}
		return null;
	}
	if (ch === ":") {
		// Allow `f: ...` or `H_0: ...` only when preceded by a single letter or scripted symbol.
		const trimmed = prevSlice.trimEnd();
		if (/(?:^|[\s(])[A-Za-z](?:_[0-9A-Za-z]|_\{[^{}]+\})?$/.test(trimmed)) {
			return { opEnd: opPos + 1, op: ":" };
		}
		return null;
	}
	return null;
}

function readOperandForward(line: string, pos: number, op: string, protectedRanges: Span[]): number {
	let cur = pos;
	if (cur >= line.length || findProtectedAt(cur, protectedRanges)) return -1;
	// Optional unary +/- right after binary/relation operator (e.g. `x = -1`).
	if ((line[cur] === "-" || line[cur] === "+") && line[cur + 1] && /[0-9A-Za-z(\\[{]/.test(line[cur + 1]!)) {
		cur++;
	}
	if (line[cur] === "\\") {
		const texEnd = readTexAtomAt(line, cur, protectedRanges);
		if (texEnd > cur) return texEnd;
	}
	if (line[cur] === "(" || line[cur] === "[") {
		const end = readForwardBalanced(line, cur);
		if (end > cur && !overlapsProtected(cur, end, protectedRanges) && isMathBracketContent(line.slice(cur + 1, end - 1), false)) {
			return consumeAttachedScripts(line, end);
		}
		return -1;
	}
	if (line[cur] === "|") {
		const close = line.indexOf("|", cur + 1);
		if (close > cur + 1 && !overlapsProtected(cur, close + 1, protectedRanges) && isMathBracketContent(line.slice(cur + 1, close), false)) {
			return consumeAttachedScripts(line, close + 1);
		}
		return -1;
	}
	const numMatch = /^[0-9]+(?:\.[0-9]+)?/.exec(line.slice(cur));
	if (numMatch && !isLetterChar(line[cur + numMatch[0].length])) {
		return consumeAttachedScripts(line, cur + numMatch[0].length);
	}
	const identMatch = /^[A-Za-z\u0391-\u03c9]+/.exec(line.slice(cur));
	if (identMatch) {
		const ident = identMatch[0]!;
		let end = cur + ident.length;
		if (isWordChar(line[end]) || isLetterChar(line[end])) return -1;
		while (end < line.length && (line[end] === "'" || line[end] === "′")) end++;
		const attachedOpen = line[end] === "(" || line[end] === "[";
		if (ident.length === 1 || MATH_WORD_ALLOWLIST.has(ident) || (/^[A-Z]{2,4}$/.test(ident) && op !== "" && !PROSE_ALL_CAPS_BLOCKLIST.has(ident))) {
			if (attachedOpen) {
				const closeEnd = readForwardBalanced(line, end);
				if (closeEnd > end && !overlapsProtected(end, closeEnd, protectedRanges) && isMathBracketContent(line.slice(end + 1, closeEnd - 1), true)) {
					end = closeEnd;
				}
			}
			return consumeAttachedScripts(line, end);
		}
	}
	return -1;
}

function readBinaryOpBackward(line: string, opEnd: number): { opStart: number; op: string } | null {
	const two = line.slice(Math.max(0, opEnd - 2), opEnd);
	if (two === "<=" || two === ">=" || two === "!=") return { opStart: opEnd - 2, op: two };
	const ch = line[opEnd - 1];
	if (!ch) return null;
	if (UNICODE_BINARY_OPS.has(ch) || ch === "=" || ch === "<" || ch === ">" || ch === "+" || ch === "/") {
		return { opStart: opEnd - 1, op: ch };
	}
	if (ch === "*" && line[opEnd - 2] !== "*" && line[opEnd] !== "*") {
		return { opStart: opEnd - 1, op: "*" };
	}
	if (ch === "-") {
		const spaceBefore = opEnd - 2 >= 0 && (line[opEnd - 2] === " " || line[opEnd - 2] === "\t");
		const spaceAfter = line[opEnd] === " " || line[opEnd] === "\t";
		if (spaceBefore && spaceAfter) return { opStart: opEnd - 1, op: "-" };
		if (!spaceBefore && !spaceAfter && opEnd - 2 >= 0) {
			const prevWord = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]{2,}$/.exec(line.slice(0, opEnd - 1));
			if (prevWord) return null;
			return { opStart: opEnd - 1, op: "-" };
		}
		return null;
	}
	if (ch === ":") {
		// Look past optional spaces backwards to single letter (e.g. `f:`)
		return { opStart: opEnd - 1, op: ":" };
	}
	return null;
}

function readOperandBackward(line: string, end: number, op: string, protectedRanges: Span[]): number {
	if (end <= 0 || findProtectedAt(end - 1, protectedRanges)) return -1;
	let cur = end;
	while (cur > 0 && (line[cur - 1] === "'" || line[cur - 1] === "′")) cur--;
	if (cur <= 0) return -1;

	const last = line[cur - 1]!;
	if (last === ")" || last === "]") {
		const openIdx = readBackwardBalanced(line, cur - 1, 0);
		if (openIdx >= 0 && !overlapsProtected(openIdx, end, protectedRanges)) {
			const prefixStart = readShortFunctionPrefixBeforeOpen(line, openIdx, 0);
			if (isMathBracketContent(line.slice(openIdx + 1, cur - 1), prefixStart < openIdx)) {
				return prefixStart;
			}
		}
		return -1;
	}
	if (last === "|") {
		const open = line.lastIndexOf("|", cur - 2);
		if (open >= 0 && !overlapsProtected(open, end, protectedRanges) && isMathBracketContent(line.slice(open + 1, cur - 1), false)) {
			return open;
		}
		return -1;
	}
	const numMatch = /[0-9]+(?:\.[0-9]+)?$/.exec(line.slice(0, cur));
	if (numMatch) {
		const start = cur - numMatch[0].length;
		if (start === 0 || !isWordChar(line[start - 1])) return start;
	}
	const identMatch = /[A-Za-z\u0391-\u03c9]+$/.exec(line.slice(0, cur));
	if (identMatch) {
		const ident = identMatch[0]!;
		const start = cur - ident.length;
		if (start > 0 && (isWordChar(line[start - 1]) || isLetterChar(line[start - 1]))) return -1;
		if (op === ":") {
			return ident.length === 1 ? start : -1;
		}
		if (ident.length === 1 || MATH_WORD_ALLOWLIST.has(ident) || (/^[A-Z]{2,4}$/.test(ident) && !PROSE_ALL_CAPS_BLOCKLIST.has(ident))) {
			return start;
		}
	}
	return -1;
}

function expandAroundEnclosingCall(line: string, span: Span, protectedRanges: Span[]): Span {
	let { start, end } = span;
	while (start > 0 && (line[start - 1] === "(" || line[start - 1] === "[") && line[end] === (line[start - 1] === "(" ? ")" : "]")) {
		const openIdx = start - 1;
		const closeIdx = end;
		const prefixStart = readShortFunctionPrefixBeforeOpen(line, openIdx, 0);
		if (!overlapsProtected(prefixStart, closeIdx + 1, protectedRanges) && isMathBracketContent(line.slice(openIdx + 1, closeIdx), prefixStart < openIdx)) {
			start = prefixStart;
			end = consumeAttachedScripts(line, closeIdx + 1);
		} else break;
	}
	return { start, end };
}

function expandSpan(line: string, anchors: Span[], idx: number, protectedRanges: Span[]): { span: Span; nextIdx: number } {
	let span = { ...anchors[idx]! };
	let nextIdx = idx + 1;
	for (let pass = 0; pass < 4; pass++) {
		const beforeStart = span.start;
		const beforeEnd = span.end;
		span = expandAroundEnclosingCall(line, span, protectedRanges);

		// Expand LEFT
		while (span.start > 0) {
			let cur = span.start;
			while (cur > 0 && (line[cur - 1] === " " || line[cur - 1] === "\t")) cur--;
			if (startsWithInfixCommand(line.slice(span.start, span.end))) {
				const lhsAnchor = anchors.slice(0, idx).reverse().find((a) => a.end === cur);
				if (lhsAnchor && !overlapsProtected(lhsAnchor.start, span.end, protectedRanges)) {
					span.start = lhsAnchor.start;
					continue;
				}
				const lhsStart = readOperandBackward(line, cur, "\\cmd", protectedRanges);
				if (lhsStart >= 0) {
					span.start = lhsStart;
					continue;
				}
			}
			const binary = readBinaryOpBackward(line, cur);
			if (binary) {
				let lhsEnd = binary.opStart;
				while (lhsEnd > 0 && (line[lhsEnd - 1] === " " || line[lhsEnd - 1] === "\t")) lhsEnd--;
				const lhsAnchor = anchors.slice(0, idx).reverse().find((a) => a.end === lhsEnd);
				if (lhsAnchor && !overlapsProtected(lhsAnchor.start, span.end, protectedRanges)) {
					span.start = lhsAnchor.start;
					continue;
				}
				const lhsStart = readOperandBackward(line, lhsEnd, binary.op, protectedRanges);
				if (lhsStart >= 0) {
					span.start = lhsStart;
					continue;
				}
			}
			// Numeric coefficient immediately left of TeX/script atom (e.g. `2 \pi` or `-x^2`).
			if (cur === span.start && line[cur - 1] === "-" && (cur - 1 === 0 || /[\s(]/.test(line[cur - 2]!))) {
				span.start = cur - 1;
				continue;
			}
			const coef = /[0-9]+(?:\.[0-9]+)?$/.exec(line.slice(0, cur));
			if (coef && (cur - coef[0].length === 0 || !isWordChar(line[cur - coef[0].length - 1]))) {
				const coefStart = cur - coef[0].length;
				if (!overlapsProtected(coefStart, span.end, protectedRanges)) {
					span.start = coefStart;
					continue;
				}
			}
			break;
		}

		// Expand RIGHT
		while (span.end < line.length) {
			const curEnd = span.end;
			while (nextIdx < anchors.length && anchors[nextIdx]!.end <= curEnd) nextIdx++;
			// Consume immediately attached primes or brackets on an active word/command span.
			const nextChar = line[curEnd];
			if ((nextChar === "(" || nextChar === "[") && curEnd > span.start && /[A-Za-z\u0391-\u03c9'}]$/.test(line.slice(span.start, curEnd))) {
				const balEnd = readForwardBalanced(line, curEnd);
				if (balEnd > curEnd && !overlapsProtected(curEnd, balEnd, protectedRanges) && isMathBracketContent(line.slice(curEnd + 1, balEnd - 1), true)) {
					span.end = consumeAttachedScripts(line, balEnd);
					continue;
				}
			}

			let afterSpace = curEnd;
			while (afterSpace < line.length && (line[afterSpace] === " " || line[afterSpace] === "\t")) afterSpace++;
			if (afterSpace < line.length && findProtectedAt(afterSpace, protectedRanges)) break;

			// Merge across spaces with a following anchor when semantically connected.
			const nextAnchor = anchors[nextIdx];
			if (nextAnchor && nextAnchor.start === afterSpace) {
				const curSlice = line.slice(span.start, curEnd);
				const anchorSlice = line.slice(nextAnchor.start, nextAnchor.end);
				if (startsWithInfixCommand(anchorSlice) || endsWithCommand(curSlice, INFIX_TEX_COMMANDS) || endsWithPrefixMathToken(curSlice)) {
					span.end = nextAnchor.end;
					nextIdx++;
					continue;
				}
			}

			// Comma continuation only when directly leading into/from `\dots`/`\ldots`/`\cdots`.
			if (line[afterSpace] === ",") {
				let afterComma = afterSpace + 1;
				while (afterComma < line.length && (line[afterComma] === " " || line[afterComma] === "\t")) afterComma++;
				if (nextAnchor && nextAnchor.start === afterComma && startsWithContinuationCommand(line.slice(nextAnchor.start, nextAnchor.end))) {
					span.end = nextAnchor.end;
					nextIdx++;
					continue;
				}
				if (endsWithCommand(line.slice(span.start, curEnd), CONTINUATION_TEX_COMMANDS)) {
					const rhsEnd = readOperandForward(line, afterComma, ",", protectedRanges);
					if (rhsEnd > afterComma) {
						span.end = rhsEnd;
						continue;
					}
				}
			}

			// Explicit binary/relation operator (`=`, `+`, `-`, `\times` already merged above, `≥`, etc.)
			const bin = readBinaryOpForward(line, afterSpace, line.slice(span.start, curEnd));
			if (bin) {
				let rhsStart = bin.opEnd;
				while (rhsStart < line.length && (line[rhsStart] === " " || line[rhsStart] === "\t")) rhsStart++;
				if (nextAnchor && nextAnchor.start === rhsStart) {
					span.end = nextAnchor.end;
					nextIdx++;
					continue;
				}
				const rhsEnd = readOperandForward(line, rhsStart, bin.op, protectedRanges);
				if (rhsEnd > rhsStart) {
					span.end = rhsEnd;
					continue;
				}
			}

			// Right operand immediately after an infix or prefix TeX command (e.g. `\times IQR`, `\forall x`, `\frac{1}{2} x`).
			const curSlice = line.slice(span.start, curEnd);
			if (endsWithCommand(curSlice, INFIX_TEX_COMMANDS) || endsWithPrefixMathToken(curSlice)) {
				if (nextAnchor && nextAnchor.start === afterSpace) {
					span.end = nextAnchor.end;
					nextIdx++;
					continue;
				}
				const rhsEnd = readOperandForward(line, afterSpace, "\\cmd", protectedRanges);
				if (rhsEnd > afterSpace) {
					// Avoid swallowing a bare English article `"a"`/`"I"` when only separated by whitespace from a prefix `\frac{1}{2} a cup` unless followed by an operator.
					const tok = line.slice(afterSpace, rhsEnd);
					const afterTok = line.slice(rhsEnd).trimStart()[0];
					const isolatedArticle = endsWithPrefixMathToken(curSlice) && !endsWithCommand(curSlice, new Set(["forall", "exists"]))
						&& (tok === "a" || tok === "A" || tok === "I")
						&& afterSpace > curEnd
						&& (!afterTok || !/[=<>+\-*/^_\\≤≥≠∈→⇒]/.test(afterTok));
					if (!isolatedArticle) {
						span.end = rhsEnd;
						continue;
					}
				}
			}
			break;
		}

		span = expandAroundEnclosingCall(line, span, protectedRanges);
		if (span.start === beforeStart && span.end === beforeEnd) break;
	}
	return { span, nextIdx };
}

function hasBalancedDelimiters(slice: string): boolean {
	let parens = 0;
	let brackets = 0;
	for (let i = 0; i < slice.length; i++) {
		if (slice[i] === "\\") {
			i++;
			continue;
		}
		if (slice[i] === "(") parens++;
		else if (slice[i] === ")") {
			if (--parens < 0) return false;
		} else if (slice[i] === "[") brackets++;
		else if (slice[i] === "]") {
			if (--brackets < 0) return false;
		}
	}
	return parens === 0 && brackets === 0;
}

function normalizeBareRelations(tex: string): string {
	return tex
		.replace(/<=/g, "\\le ")
		.replace(/>=/g, "\\ge ")
		.replace(/!=/g, "\\neq ")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function wrapBareMathInLine(line: string): string {
	if (!/[\\_^]/.test(line)) return line;
	const protectedRanges = collectProtectedRanges(line);
	const anchors = findStrongAnchors(line, protectedRanges);
	if (anchors.length === 0) return line;

	const expanded: Span[] = [];
	let idx = 0;
	while (idx < anchors.length) {
		const { span, nextIdx } = expandSpan(line, anchors, idx, protectedRanges);
		const prev = expanded.at(-1);
		if (prev && span.start <= prev.end) {
			prev.end = Math.max(prev.end, span.end);
		} else if (prev && /^[\t ]+$/.test(line.slice(prev.end, span.start)) && !overlapsProtected(prev.end, span.start, protectedRanges)) {
			const midSlice = line.slice(prev.start, span.end);
			if (hasBalancedDelimiters(midSlice) && canParseTex(normalizeBareRelations(midSlice), false)) {
				prev.end = span.end;
			} else expanded.push(span);
		} else {
			expanded.push(span);
		}
		idx = Math.max(idx + 1, nextIdx);
	}

	let out = "";
	let cursor = 0;
	for (const s of expanded) {
		if (s.start < cursor) continue;
		const raw = line.slice(s.start, s.end).trim();
		const leadTrim = line.slice(s.start, s.end).length - line.slice(s.start, s.end).trimStart().length;
		const start = s.start + leadTrim;
		const end = start + raw.length;
		if (!raw || overlapsProtected(start, end, protectedRanges) || !hasBalancedDelimiters(raw)) continue;
		const normalized = normalizeBareRelations(raw);
		if (!canParseTex(normalized, false)) continue;
		out += line.slice(cursor, start) + `$${normalized}$`;
		cursor = end;
	}
	return out + line.slice(cursor);
}

/** Wraps un-delimited LaTeX expressions in prose spans with `$...$` for
 * presentation only, leaving code, already-delimited math, URLs, paths,
 * snake_case identifiers, and paragraphs containing `$` currency untouched. */
export function wrapBareMathForDisplay(text: string): string {
	if (!text || !/[\\_^]/.test(text)) return text;
	return readContentSpans(text)
		.map((span) => {
			if (span.kind !== "prose" || !/[\\_^]/.test(span.raw)) return span.raw;
			return span.raw
				.split(/(\r?\n[ \t]*\r?\n)/)
				.map((part, idx) => {
					if (idx % 2 === 1 || !/[\\_^]/.test(part) || hasUnescapedDollar(part)) return part;
					return part
						.split(/(\r\n|\n|\r)/)
						.map((line, lineIdx) => (lineIdx % 2 === 1 ? line : wrapBareMathInLine(line)))
						.join("");
				})
				.join("");
		})
		.join("");
}
