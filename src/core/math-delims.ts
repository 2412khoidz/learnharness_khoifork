/** Shared Markdown/TeX boundaries for legacy delimiter compatibility and
 * display-only tool-content recovery. Source arguments are never rewritten. */
import {
	canParseTex, knownTexCommand, mapMathContent, numericPercentEscape, outsideTexComments,
	readContentSpans, recoverDocumentLayout, texRanges,
} from "./content-reader.ts";
import { wrapBareMathForDisplay } from "./bare-math.ts";

export { wrapBareMathForDisplay };

const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};

/** Preserve the legacy list-continuation policy: indented display math
 * degrades to inline rather than disrupting list structure. Literal code
 * indentation is already protected by the shared reader. */
function indented(text: string, i: number): boolean {
	const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	return prefix.length > 0 && /^[ \t]+$/.test(prefix);
}
function blockPosition(text: string, i: number): boolean {
	return /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
}

/** micromark closes native single-dollar spans at escaped dollars too.
 * Replace an intended literal dollar with equivalent dollar-free TeX before
 * tokenization. Code, prose, unbalanced spans and display dollars stay raw. */
function replaceEscapedDollars(content: string): string {
	let out = "";
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\\" && content[i + 1] === "$" && !escaped(content, i)) {
			out += "\\text{\\textdollar}"; i++;
		} else out += content[i];
	}
	return out;
}

/** Read old \(...\)/\[...\] syntax without touching literal content or
 * reparsing native math as Markdown. Dollar authoring remains native. */
export function transformMathDelimiters(markdown: string): string {
	let offset = 0;
	return readContentSpans(markdown).map(span => {
		const start = offset; offset += span.raw.length;
		if (span.kind !== "math") return span.raw;
		if (span.open === "$") return "$" + replaceEscapedDollars(span.body) + span.close;
		if (span.open !== "\\(" && span.open !== "\\[") return span.raw;
		const body = span.body.trim();
		if (!body) return span.raw;
		if (span.open === "\\(") return `$$${body}$$`;
		if (indented(markdown, start)) return `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
		const before = blockPosition(markdown, start) ? "" : "\n\n";
		const end = start + span.raw.length;
		const after = end === markdown.length || markdown[end] === "\n" ? "" : "\n\n";
		return `${before}$$\n${body}\n$$${after}`;
	}).join("");
}

const DEBRIS: Record<string, string> = {
	"\b": "\\b", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\r": "\\r",
};

/** Recover JSON-swallowed command prefixes only in recognized math, never
 * in code or genuine TeX comments. Restore all debris in one pass. Physical
 * display newlines and CRLF remain source whitespace. Inline LF recovery is
 * limited to complete known n-command names. Under the approved typical-
 * model-authoring policy this includes newline+u→nu in inline math only;
 * already-correct commands are never decoded into whitespace. */
export function restoreMathEscapes(text: string): string {
	if (!/[\b\t\n\v\f\r]/.test(text)) return text;
	return mapMathContent(text, (body, display) => outsideTexComments(body, part => {
		const restored = part.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
			if (char === "\r" && part[offset + 1] === "\n") return char;
			const suffix = /^[A-Za-z]+/.exec(part.slice(offset + 1))?.[0];
			return suffix && knownTexCommand(DEBRIS[char]!.slice(1) + suffix) ? DEBRIS[char]! : char;
		});
		if (display) return restored;
		return restored.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
			knownTexCommand("n" + suffix) ? "\\n" + suffix : whole);
	}));
}

const commandSymbol = /[,;:!|{}%]/;

/** Decode prefixes and row separators according to ORIGINAL TeX context.
 * A native pair is literal; an encoded pair supplies a factor, so an encoded
 * four-backslash row becomes TWO, never a command prefix. Unknown commands
 * without that structural evidence are left alone. */
function recoverCommandRuns(inner: string, display: boolean): string {
	const ranges = texRanges(inner);
	const recovered = inner.replace(/\\+/g, (run: string, offset: number) => {
		const contexts = ranges.filter(r => offset >= r.start && offset < r.end);
		if (contexts.some(r => r.kind === "row" || r.kind === "comment") || run.length % 2 !== 0) return run;
		const next = inner[offset + run.length] ?? "";
		const encoded = contexts.filter(r => r.kind === "encoded").at(-1);
		const word = /^[A-Za-z]+/.exec(inner.slice(offset + run.length))?.[0];
		if (encoded) {
			const factor = encoded.factor!;
			const rows = run.length % (2 * factor) === 0;
			const command = word ? knownTexCommand(word) : commandSymbol.test(next);
			if (run.length % factor === 0 && (rows || command)) return "\\".repeat(run.length / factor);
			return run;
		}
		if (next === "%") return numericPercentEscape(inner, offset + run.length) ? "\\" : run;
		if (word) return word.length > 1 && knownTexCommand(word) ? "\\" : run;
		return next && commandSymbol.test(next) ? "\\" : run;
	});
	// Structural evidence is primary (parse success cannot prove row
	// preservation). As an additional guard, never turn parseable source into
	// a parse failure through partial command recovery.
	if (recovered !== inner && !canParseTex(recovered, display) && canParseTex(inner, display)) return inner;
	return recovered;
}

export function healOverescapedCommands(text: string): string {
	return text.includes("\\\\") ? mapMathContent(text, recoverCommandRuns) : text;
}

/** Presentation-only, language-independent recovery. Shape parsing, saved
 * identities, grading and model history must use the unprojected source. */
export function repairMathForDisplay(text: string): string {
	return healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)));
}

const SUPERSCRIPT_MAP: Record<string, string> = {
	"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
	"5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
	"+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
	a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ",
	i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ",
	r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
	A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ",
	K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ",
	U: "ᵁ", V: "ⱽ", W: "ᵂ",
	"′": "′", "−": "⁻", "α": "ᵅ", "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "ε": "ᵋ", "θ": "ᶿ", "φ": "ᵠ", "χ": "ᵡ",
};

const SUBSCRIPT_MAP: Record<string, string> = {
	"0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
	"5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
	"+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
	a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ",
	n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
	"−": "₋", "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "φ": "ᵩ", "χ": "ᵪ",
};

const BLACKBOARD_MAP: Record<string, string> = {
	R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", E: "𝔼", F: "𝔽", H: "ℍ",
};

const INFIX_TEX_COMMANDS: Record<string, string> = {
	in: "∈", notin: "∉", ni: "∋",
	subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", subsetneq: "⊊",
	cup: "∪", cap: "∩", setminus: "∖",
	le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
	approx: "≈", equiv: "≡", cong: "≅", sim: "∼", simeq: "≃", propto: "∝",
	ll: "≪", gg: "≫",
	to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", mapsto: "↦",
	implies: "⟹", Rightarrow: "⇒", impliedby: "⟸", Leftarrow: "⇐", iff: "⟺", Leftrightarrow: "⇔",
	land: "∧", wedge: "∧", lor: "∨", vee: "∨",
	oplus: "⊕", otimes: "⊗", pm: "±", mp: "∓", times: "×", div: "÷",
	parallel: "∥", perp: "⊥", mid: "∣", vdash: "⊢", models: "⊨",
};

const SYMBOL_TEX_COMMANDS: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
	zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ",
	lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "π",
	rho: "ρ", varrho: "ρ", sigma: "σ", varsigma: "σ", tau: "τ", upsilon: "υ",
	phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
	Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
	Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
	forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
	emptyset: "∅", varnothing: "∅", top: "⊤", bot: "⊥",
	infty: "∞", partial: "∂", nabla: "∇",
	sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
	cdot: "·", ast: "∗", star: "★", circ: "∘", bullet: "•",
	angle: "∠", triangle: "△", square: "□",
	dots: "…", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
	therefore: "∴", because: "∵", prime: "′",
	ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
	R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ",
	langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
	lvert: "|", rvert: "|", lVert: "‖", rVert: "‖",
};

const ACCENT_TEX_COMMANDS: Record<string, string> = {
	bar: "\u0304", overline: "\u0304", hat: "\u0302", widehat: "\u0302",
	tilde: "\u0303", widetilde: "\u0303", vec: "\u20d7", dot: "\u0307", ddot: "\u0308",
};

const FUNCTION_TEX_COMMANDS = new Set([
	"lim", "limsup", "liminf", "sup", "inf", "max", "min", "argmax", "argmin",
	"log", "ln", "exp", "sin", "cos", "tan", "cot", "sec", "csc",
	"arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
	"arg", "det", "dim", "ker", "gcd", "lcm", "deg", "mod", "bmod", "pmod", "Pr",
]);

const SKIP_TEX_COMMANDS = new Set([
	"left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "biggl", "biggr",
	"Bigl", "Bigr", "Biggl", "Biggr", "middle",
	"displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
	"limits", "nolimits",
]);

const TEXT_UNWRAP_COMMANDS = new Set(["text", "textbf", "textit", "textrm", "textsf", "texttt"]);
const MATH_UNWRAP_COMMANDS = new Set(["mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "mathfrak", "operatorname"]);

function skipSpaces(src: string, idx: number): number {
	while (idx < src.length && /\s/.test(src[idx]!)) idx++;
	return idx;
}

function readBracedGroup(src: string, start: number): { raw: string; end: number } | null {
	const i = skipSpaces(src, start);
	if (src[i] !== "{") return null;
	let depth = 1;
	let j = i + 1;
	while (j < src.length && depth > 0) {
		if (src[j] === "\\") {
			j += 2;
			continue;
		}
		if (src[j] === "{") depth++;
		else if (src[j] === "}") depth--;
		j++;
	}
	return depth === 0 ? { raw: src.slice(i + 1, j - 1), end: j } : null;
}

function readTexAtom(src: string, start: number): { raw: string; end: number } {
	const braced = readBracedGroup(src, start);
	if (braced) return braced;
	const i = skipSpaces(src, start);
	if (i >= src.length) return { raw: "", end: i };
	if (src[i] === "\\") {
		const cmd = /^\\([A-Za-z]+\*?|\S)/.exec(src.slice(i));
		if (cmd) return { raw: cmd[0], end: i + cmd[0].length };
	}
	return { raw: src[i]!, end: i + 1 };
}

function mapScript(rendered: string, map: Record<string, string>, marker: "^" | "_"): string {
	const compact = rendered.replace(/\s+/g, "");
	if (!compact) return "";
	let out = "";
	for (const ch of compact) {
		const mapped = map[ch];
		if (!mapped) {
			return compact.length === 1 ? `${marker}${compact}` : `${marker}(${rendered.trim()})`;
		}
		out += mapped;
	}
	return out;
}

function wrapFractionPart(part: string): string {
	const trimmed = part.trim();
	if (!trimmed) return "?";
	if (/^\([^()]*\)$/.test(trimmed)) return trimmed;
	return /[+\-−*/=\s]/.test(trimmed) ? `(${trimmed})` : trimmed;
}

function texToPlainText(expr: string): string {
	let out = "";
	let i = 0;
	const appendSpacedWord = (word: string) => {
		if (out && /[A-Za-z0-9α-ωΑ-Ωℝℕℤℚℂℙ𝔼𝔽]$/.test(out)) out += " ";
		out += word;
	};
	while (i < expr.length) {
		const ch = expr[i]!;
		if (/\s/.test(ch)) {
			if (out && !out.endsWith(" ")) out += " ";
			i++;
			continue;
		}
		if (ch === "~") {
			if (out && !out.endsWith(" ")) out += " ";
			i++;
			continue;
		}
		if (ch === "{" || ch === "}") {
			if (ch === "{") {
				const group = readBracedGroup(expr, i);
				if (group) {
					out += texToPlainText(group.raw);
					i = group.end;
					continue;
				}
			}
			i++;
			continue;
		}
		if (ch === "^" || ch === "_") {
			const atom = readTexAtom(expr, i + 1);
			const rendered = texToPlainText(atom.raw);
			out += mapScript(rendered, ch === "^" ? SUPERSCRIPT_MAP : SUBSCRIPT_MAP, ch);
			i = atom.end;
			continue;
		}
		if (ch === "'") {
			out += "′";
			i++;
			continue;
		}
		if (ch === "\\") {
			const next = expr[i + 1] ?? "";
			if (!next) break;
			if (",:;!".includes(next) || /\s/.test(next)) {
				if (next !== "!" && out && !out.endsWith(" ")) out += " ";
				i += 2;
				continue;
			}
			if (next === "\\") {
				if (out && !out.endsWith(" ")) out += "; ";
				i += 2;
				continue;
			}
			if ("{}$%&#_".includes(next)) {
				out += next;
				i += 2;
				continue;
			}
			if (next === "|") {
				out += "‖";
				i += 2;
				continue;
			}
			const cmdMatch = /^\\([A-Za-z]+)\*?/.exec(expr.slice(i));
			if (!cmdMatch) {
				out += next;
				i += 2;
				continue;
			}
			const fullCmd = cmdMatch[0];
			const name = cmdMatch[1]!;
			i += fullCmd.length;
			if (name === "quad" || name === "qquad") {
				if (out && !out.endsWith(" ")) out += " ";
				continue;
			}
			if (SKIP_TEX_COMMANDS.has(name)) {
				if ((name === "left" || name === "right" || name === "middle") && expr[i] === ".") i++;
				continue;
			}
			if (name === "mathbb") {
				const atom = readTexAtom(expr, i);
				const inner = texToPlainText(atom.raw).trim();
				out += BLACKBOARD_MAP[inner] ?? inner;
				i = atom.end;
				continue;
			}
			if (TEXT_UNWRAP_COMMANDS.has(name)) {
				const group = readBracedGroup(expr, i);
				if (group) {
					out += group.raw;
					i = group.end;
				}
				continue;
			}
			if (MATH_UNWRAP_COMMANDS.has(name)) {
				const atom = readTexAtom(expr, i);
				appendSpacedWord(texToPlainText(atom.raw));
				i = atom.end;
				continue;
			}
			if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
				const num = readTexAtom(expr, i);
				const den = readTexAtom(expr, num.end);
				out += `${wrapFractionPart(texToPlainText(num.raw))}/${wrapFractionPart(texToPlainText(den.raw))}`;
				i = den.end;
				continue;
			}
			if (name === "binom" || name === "dbinom" || name === "tbinom") {
				const top = readTexAtom(expr, i);
				const bot = readTexAtom(expr, top.end);
				out += `C(${texToPlainText(top.raw).trim()}, ${texToPlainText(bot.raw).trim()})`;
				i = bot.end;
				continue;
			}
			if (name === "sqrt") {
				let pos = skipSpaces(expr, i);
				let deg = "";
				if (expr[pos] === "[") {
					const closeIdx = expr.indexOf("]", pos + 1);
					if (closeIdx > pos) {
						deg = mapScript(texToPlainText(expr.slice(pos + 1, closeIdx)), SUPERSCRIPT_MAP, "^");
						pos = closeIdx + 1;
					}
				}
				const body = readTexAtom(expr, pos);
				const inner = texToPlainText(body.raw).trim();
				const wrapped = inner.length <= 1 || /^\(.*\)$/.test(inner) ? inner : `(${inner})`;
				out += `${deg}√${wrapped}`;
				i = body.end;
				continue;
			}
			if (ACCENT_TEX_COMMANDS[name]) {
				const atom = readTexAtom(expr, i);
				const inner = texToPlainText(atom.raw).trim();
				out += inner ? `${inner}${ACCENT_TEX_COMMANDS[name]}` : "";
				i = atom.end;
				continue;
			}
			if (INFIX_TEX_COMMANDS[name]) {
				const trimmed = out.replace(/ +$/, "");
				out = trimmed ? `${trimmed} ${INFIX_TEX_COMMANDS[name]} ` : `${INFIX_TEX_COMMANDS[name]} `;
				continue;
			}
			if (SYMBOL_TEX_COMMANDS[name]) {
				out += SYMBOL_TEX_COMMANDS[name];
				continue;
			}
			if (FUNCTION_TEX_COMMANDS.has(name)) {
				appendSpacedWord(name);
				if (expr[i] && /[A-Za-z0-9\\]/.test(expr[i]!)) out += " ";
				continue;
			}
			appendSpacedWord(name);
			continue;
		}
		out += ch;
		i++;
	}
	return out
		.replace(/\s+/g, " ")
		.replace(/([A-Za-z0-9)\]₀-₉⁰-⁹′])([∀∃])/g, "$1 $2")
		.trim();
}

/** Plain-text math rendering for non-DOM surfaces (canvas labels, tooltips,
 *  accessibility summaries): repairs escaped TeX first, then turns delimited
 *  math spans into clean readable Unicode while leaving prose, currency, and
 *  code spans untouched. */
export function formatMathForPlainText(text: string): string {
	if (!text) return text;
	const repaired = repairMathForDisplay(wrapBareMathForDisplay(text));
	return readContentSpans(repaired)
		.map((span) => (span.kind === "math" ? texToPlainText(span.body) : span.raw))
		.join("");
}
