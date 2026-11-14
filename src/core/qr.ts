/**
 * Minimal pure-TypeScript QR Code generator (ISO/IEC 18004 Byte mode,
 * Error Correction Level M, Versions 1–10). Zero dependencies, browser-safe.
 */

export interface QrMatrix {
	version: number;
	size: number;
	modules: boolean[];
}

interface EcBlockGroup {
	count: number;
	dataCodewords: number;
}

interface VersionSpec {
	ecPerBlock: number;
	groups: readonly EcBlockGroup[];
	alignment: readonly number[];
}

// ISO/IEC 18004 Table 7 & Table 9 for Error Correction Level M, Versions 1..10.
const VERSION_SPECS: Record<number, VersionSpec> = {
	1: { ecPerBlock: 10, groups: [{ count: 1, dataCodewords: 16 }], alignment: [] },
	2: { ecPerBlock: 16, groups: [{ count: 1, dataCodewords: 28 }], alignment: [6, 18] },
	3: { ecPerBlock: 26, groups: [{ count: 1, dataCodewords: 44 }], alignment: [6, 22] },
	4: { ecPerBlock: 18, groups: [{ count: 2, dataCodewords: 32 }], alignment: [6, 26] },
	5: { ecPerBlock: 24, groups: [{ count: 2, dataCodewords: 43 }], alignment: [6, 30] },
	6: { ecPerBlock: 16, groups: [{ count: 4, dataCodewords: 27 }], alignment: [6, 34] },
	7: { ecPerBlock: 18, groups: [{ count: 4, dataCodewords: 31 }], alignment: [6, 22, 38] },
	8: { ecPerBlock: 22, groups: [{ count: 2, dataCodewords: 38 }, { count: 2, dataCodewords: 39 }], alignment: [6, 24, 42] },
	9: { ecPerBlock: 22, groups: [{ count: 3, dataCodewords: 36 }, { count: 2, dataCodewords: 37 }], alignment: [6, 26, 46] },
	10: { ecPerBlock: 26, groups: [{ count: 4, dataCodewords: 43 }, { count: 1, dataCodewords: 44 }], alignment: [6, 28, 50] },
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_EXP[i + 255] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
})();

function gfMul(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): Uint8Array {
	let poly: Uint8Array = new Uint8Array([1]);
	for (let i = 0; i < degree; i++) {
		const root = GF_EXP[i]!;
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] = (next[j]! ^ poly[j]!) & 0xff;
			next[j + 1] = (next[j + 1]! ^ gfMul(poly[j]!, root)) & 0xff;
		}
		poly = next;
	}
	return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
	const gen = rsGenerator(ecCount);
	const buf = new Uint8Array(data.length + ecCount);
	buf.set(data);
	for (let i = 0; i < data.length; i++) {
		const factor = buf[i]!;
		if (factor === 0) continue;
		for (let j = 0; j < gen.length; j++) {
			buf[i + j] = (buf[i + j]! ^ gfMul(gen[j]!, factor)) & 0xff;
		}
	}
	return buf.slice(data.length);
}

function bchRemainder(value: number, poly: number, dataShift: number, polyDegree: number): number {
	let rem = value << dataShift;
	for (let bit = dataShift + polyDegree - 1; bit >= dataShift; bit--) {
		// Polynomial bits sit at positions >= dataShift; find highest set bit in rem
		if ((rem >>> bit) & 1) rem ^= poly << (bit - dataShift);
	}
	return rem;
}

function formatBits(mask: number): number {
	// EC level M = 0b00; format polynomial x^10 + x^8 + x^5 + x^4 + x^2 + x + 1 = 0x537.
	const data = mask & 0b111;
	const rem = bchRemainder(data, 0x537, 10, 5);
	return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
	// Version polynomial 0x1f25 (degree 12); valid for versions 7..40.
	const rem = bchRemainder(version, 0x1f25, 12, 6);
	return (version << 12) | rem;
}

function pickVersion(byteLength: number): number {
	for (let v = 1; v <= 10; v++) {
		const spec = VERSION_SPECS[v]!;
		const totalData = spec.groups.reduce((sum, g) => sum + g.count * g.dataCodewords, 0);
		const countBits = v >= 10 ? 16 : 8;
		const capacityBytes = Math.floor((totalData * 8 - 4 - countBits) / 8);
		if (byteLength <= capacityBytes) return v;
	}
	throw new RangeError(`QR payload too long (${byteLength} bytes; max 213 at level M v10)`);
}

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
	const spec = VERSION_SPECS[version]!;
	const totalData = spec.groups.reduce((sum, g) => sum + g.count * g.dataCodewords, 0);
	const bits: number[] = [];
	const pushBits = (val: number, len: number) => {
		for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
	};
	pushBits(0b0100, 4); // Byte mode
	pushBits(bytes.length, version >= 10 ? 16 : 8);
	for (const b of bytes) pushBits(b, 8);
	const maxBits = totalData * 8;
	for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0); // Terminator
	while (bits.length % 8 !== 0) bits.push(0);
	const data = new Uint8Array(totalData);
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]!;
		data[i >>> 3] = b;
	}
	for (let pos = bits.length >>> 3, pad = 0; pos < totalData; pos++, pad++) {
		data[pos] = pad % 2 === 0 ? 0xec : 0x11;
	}

	// Split into blocks and interleave data + RS error-correction codewords.
	const blocks: Uint8Array[] = [];
	const ecs: Uint8Array[] = [];
	let offset = 0;
	for (const group of spec.groups) {
		for (let c = 0; c < group.count; c++) {
			const block = data.slice(offset, offset + group.dataCodewords);
			offset += group.dataCodewords;
			blocks.push(block);
			ecs.push(rsRemainder(block, spec.ecPerBlock));
		}
	}

	const maxDataLen = Math.max(...blocks.map((b) => b.length));
	const result: number[] = [];
	for (let i = 0; i < maxDataLen; i++) {
		for (const block of blocks) if (i < block.length) result.push(block[i]!);
	}
	for (let i = 0; i < spec.ecPerBlock; i++) {
		for (const ec of ecs) result.push(ec[i]!);
	}
	return new Uint8Array(result);
}

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
	(r, c) => (r + c) % 2 === 0,
	(r) => r % 2 === 0,
	(_r, c) => c % 3 === 0,
	(r, c) => (r + c) % 3 === 0,
	(r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
	(r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
	(r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
	(r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function createTemplate(version: number): { size: number; modules: boolean[]; reserved: boolean[] } {
	const size = version * 4 + 17;
	const modules = new Array<boolean>(size * size).fill(false);
	const reserved = new Array<boolean>(size * size).fill(false);
	const setFn = (r: number, c: number, dark: boolean) => {
		if (r < 0 || c < 0 || r >= size || c >= size) return;
		const idx = r * size + c;
		modules[idx] = dark;
		reserved[idx] = true;
	};

	const drawFinder = (top: number, left: number) => {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const r = top + dr;
				const c = left + dc;
				if (r < 0 || c < 0 || r >= size || c >= size) continue;
				const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
				setFn(r, c, dist !== 2 && dist !== 4);
			}
		}
	};
	drawFinder(0, 0);
	drawFinder(0, size - 7);
	drawFinder(size - 7, 0);

	// Alignment patterns (skip corners overlapping finder patterns).
	const centers = VERSION_SPECS[version]!.alignment;
	for (let i = 0; i < centers.length; i++) {
		for (let j = 0; j < centers.length; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) continue;
			const cr = centers[i]!;
			const cc = centers[j]!;
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					setFn(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
				}
			}
		}
	}

	// Timing strips
	for (let i = 8; i < size - 8; i++) {
		if (!reserved[6 * size + i]) setFn(6, i, i % 2 === 0);
		if (!reserved[i * size + 6]) setFn(i, 6, i % 2 === 0);
	}

	// Dark module + format reservation
	setFn(size - 8, 8, true);
	for (let i = 0; i <= 8; i++) {
		if (!reserved[8 * size + i]) setFn(8, i, false);
		if (!reserved[i * size + 8]) setFn(i, 8, false);
	}
	for (let i = 0; i < 8; i++) {
		setFn(8, size - 1 - i, false);
		if (i < 7) setFn(size - 1 - i, 8, false);
	}

	// Version information (v >= 7)
	if (version >= 7) {
		const vBits = versionBits(version);
		for (let i = 0; i < 18; i++) {
			const dark = ((vBits >>> i) & 1) === 1;
			const a = Math.floor(i / 3);
			const b = size - 11 + (i % 3);
			setFn(a, b, dark);
			setFn(b, a, dark);
		}
	}

	return { size, modules, reserved };
}

function drawFormat(modules: boolean[], size: number, mask: number): void {
	const bits = formatBits(mask);
	const topLeft: readonly [number, number][] = [
		[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
		[7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
	];
	for (let i = 0; i < 15; i++) {
		const dark = ((bits >>> (14 - i)) & 1) === 1;
		const [r1, c1] = topLeft[i]!;
		modules[r1 * size + c1] = dark;
		if (i < 7) modules[(size - 1 - i) * size + 8] = dark;
		else modules[8 * size + (size - 15 + i)] = dark;
	}
}

function penaltyScore(modules: boolean[], size: number): number {
	let penalty = 0;
	// Rule 1: 5+ consecutive same-color modules in row/col.
	for (let r = 0; r < size; r++) {
		let rowRun = 1;
		let colRun = 1;
		for (let c = 1; c < size; c++) {
			if (modules[r * size + c] === modules[r * size + c - 1]) rowRun++;
			else {
				if (rowRun >= 5) penalty += 3 + (rowRun - 5);
				rowRun = 1;
			}
			if (modules[c * size + r] === modules[(c - 1) * size + r]) colRun++;
			else {
				if (colRun >= 5) penalty += 3 + (colRun - 5);
				colRun = 1;
			}
		}
		if (rowRun >= 5) penalty += 3 + (rowRun - 5);
		if (colRun >= 5) penalty += 3 + (colRun - 5);
	}
	// Rule 2: 2x2 blocks of same color.
	for (let r = 0; r < size - 1; r++) {
		for (let c = 0; c < size - 1; c++) {
			const v = modules[r * size + c];
			if (v === modules[r * size + c + 1] && v === modules[(r + 1) * size + c] && v === modules[(r + 1) * size + c + 1]) {
				penalty += 3;
			}
		}
	}
	// Rule 3: finder-like 1:1:3:1:1 patterns (with 4-light quiet side).
	const matchFinderPattern = (slice: (i: number) => boolean): number => {
		let hits = 0;
		for (let i = 0; i <= size - 7; i++) {
			if (!slice(i) || slice(i + 1) || !slice(i + 2) || !slice(i + 3) || !slice(i + 4) || slice(i + 5) || !slice(i + 6)) continue;
			const leftLight = i >= 4 && !slice(i - 1) && !slice(i - 2) && !slice(i - 3) && !slice(i - 4);
			const rightLight = i + 10 < size && !slice(i + 7) && !slice(i + 8) && !slice(i + 9) && !slice(i + 10);
			if (leftLight || rightLight) hits += 40;
		}
		return hits;
	};
	for (let i = 0; i < size; i++) {
		penalty += matchFinderPattern((j) => modules[i * size + j]!);
		penalty += matchFinderPattern((j) => modules[j * size + i]!);
	}
	// Rule 4: balance of dark modules around 50%.
	let darkCount = 0;
	for (const m of modules) if (m) darkCount++;
	const k = Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size));
	return penalty + k * 10;
}

/** Encode UTF-8 text into a ready-to-render QR module matrix (EC Level M). */
export function encodeQrMatrix(text: string): QrMatrix {
	const bytes = new TextEncoder().encode(text);
	const version = pickVersion(bytes.length);
	const codewords = buildCodewords(bytes, version);
	const base = createTemplate(version);
	const { size, reserved } = base;

	// Place codeword bits along upward/downward 2-column zig-zag, skipping col 6.
	let bitIdx = 0;
	const totalBits = codewords.length * 8;
	const dataPattern = base.modules.slice();
	let upward = true;
	for (let right = size - 1; right > 0; right -= 2) {
		if (right === 6) right = 5;
		for (let step = 0; step < size; step++) {
			const r = upward ? size - 1 - step : step;
			for (let dx = 0; dx < 2; dx++) {
				const c = right - dx;
				if (reserved[r * size + c]) continue;
				const bit = bitIdx < totalBits ? ((codewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1) === 1 : false;
				dataPattern[r * size + c] = bit;
				bitIdx++;
			}
		}
		upward = !upward;
	}

	let bestMask = 0;
	let bestPenalty = Infinity;
	let bestModules = dataPattern;
	for (let m = 0; m < MASKS.length; m++) {
		const candidate = dataPattern.slice();
		const maskFn = MASKS[m]!;
		for (let r = 0; r < size; r++) {
			for (let c = 0; c < size; c++) {
				if (!reserved[r * size + c] && maskFn(r, c)) candidate[r * size + c] = !candidate[r * size + c];
			}
		}
		drawFormat(candidate, size, m);
		const score = penaltyScore(candidate, size);
		if (score < bestPenalty) {
			bestPenalty = score;
			bestMask = m;
			bestModules = candidate;
		}
	}
	void bestMask;
	return { version, size, modules: bestModules };
}

/** Render a crisp single-path SVG data payload for a QR matrix. */
export function qrSvgPath(matrix: QrMatrix): string {
	const parts: string[] = [];
	const { size, modules } = matrix;
	for (let r = 0; r < size; r++) {
		let c = 0;
		while (c < size) {
			if (!modules[r * size + c]) { c++; continue; }
			const start = c;
			while (c < size && modules[r * size + c]) c++;
			parts.push(`M${start},${r}h${c - start}v1h-${c - start}z`);
		}
	}
	return parts.join("");
}
