// Pure-JS stand-in for `Bun.ant.CellSegmenter`, a native class from Anthropic's internal Bun fork
// that Claude Code 2.1.300's Ink renderer (the interactive TUI) requires. Without it, the first
// frame throws "This runtime has no Bun.ant.CellSegmenter…". Headless (-p) never reaches it.
//
// API shape, reverse-engineered from the rebundled 2.1.300 sources (see notes/claude.md,
// "Interactive TUI"):
//   new CellSegmenter({ ambiguousIsNarrow, substitute, screen? })
//     substitute: [[lo, hi], ...] code point ranges replaced by U+FFFD (bidi controls; the JS
//                 fallback elsewhere in the bundle does `s.replace(dlt, "�")`)
//     screen:     { widthMask, narrow, wide, spacerTail, spacerHead, emptyCharIndex,
//                   spacerCharIndex, emptyWord, tabWidth }   (only needed for paint/setCell)
//   .graphemes / .sgrKeys / .sgrCloseKeys / .uris   append-only intern tables; callers cache the
//                 array objects, so they must grow in place. Index 0 of sgrKeys/uris = "none".
//   .segment(text, cells, runs, reorder) -> count, or -needed if cells/runs are too small.
//     cells[2i]   = grapheme index;  cells[2i+1] = width (bits 0-7) | 256 for a TAB | run << 10
//     runs[2r]    = sgrKeys index;    runs[2r+1]  = uris index (0 = no hyperlink)
//     sgrKeys[k] / sgrCloseKeys[k] = the active SGR open codes / their close codes, "\0"-joined.
//   .paint(screenCells, screenWidth, x, y, cells, count, _, charIndex, words) -> packed
//   .setCell(screenCells, screenWidth, x, y, charIndex, word)                  -> packed
//     packed = endX + damageStartX * 2^20 + damageEndX * 2^36 (damage = written column range)
//     word   = the caller's (styleId, hyperlinkId) word; the width code goes in widthMask bits.
//
// Semantics follow the last pure-JS renderer (Claude Code 2.1.87: writeLineToScreen + setCellAt):
// SGR/OSC-8 are parsed, other escape sequences and C0 controls are dropped, TAB advances to the
// next tab stop with blank cells, zero-width graphemes are dropped, a wide grapheme that would
// straddle the right edge becomes a spacer-head blank, and overwriting half of a wide character
// blanks its other half. Bidi reordering (`reorder`, only used on Windows Terminal / VS Code) is
// not implemented: cells stay in logical order.

const ESC = 0x1b;
const CSI8 = 0x9b;
const TAB_FLAG = 256;
const RUN_SHIFT = 10;
const P20 = 1048576; // 2^20
const P36 = 68719476736; // 2^36

// ansi-styles open -> close codes (what @alcalzone/ansi-tokenize, bundled in 2.1.300, uses)
const PAIRS = [[0, 0], [1, 22], [2, 22], [3, 23], [4, 24], [53, 55], [7, 27], [8, 28], [9, 29]];
for (let c = 30; c <= 37; c++) PAIRS.push([c, 39]);
for (let c = 90; c <= 97; c++) PAIRS.push([c, 39]);
for (let c = 40; c <= 47; c++) PAIRS.push([c, 49]);
for (let c = 100; c <= 107; c++) PAIRS.push([c, 49]);
const sgr = (n) => `\x1b[${n}m`;
const CLOSE_BY_NUM = new Map(PAIRS);
const END_CODES = new Set(PAIRS.map(([, c]) => sgr(c)));
const RESET = sgr(0);
const BOLD = sgr(1);
const DIM = sgr(2);
const endCodeOf = (code) => {
	if (END_CODES.has(code)) return code;
	const p = code.slice(2, -1);
	if (p.startsWith("38")) return sgr(39);
	if (p.startsWith("48")) return sgr(49);
	const close = CLOSE_BY_NUM.get(parseInt(p, 10));
	return close === undefined ? RESET : sgr(close);
};
// "\x1b[1;38;5;9;4m" -> ["\x1b[1m", "\x1b[38;5;9m", "\x1b[4m"]; "\x1b[m" -> reset
const splitSgr = (params) => {
	if (params === "") return [RESET];
	const t = params.split(";");
	const out = [];
	for (let i = 0; i < t.length; i++) {
		const r = t[i] === "" ? "0" : t[i];
		if ((r === "38" || r === "48" || r === "58") && t[i + 1] === "5" && i + 2 < t.length) { out.push(sgr(t.slice(i, i + 3).join(";"))); i += 2; continue; }
		if ((r === "38" || r === "48" || r === "58") && t[i + 1] === "2" && i + 4 < t.length) { out.push(sgr(t.slice(i, i + 5).join(";"))); i += 4; continue; }
		out.push(sgr(r));
	}
	return out;
};
// reduceAnsiCodes semantics from ansi-tokenize
const applySgr = (state, code) => {
	if (code === RESET) return [];
	if (END_CODES.has(code)) return state.filter((s) => s.endCode !== code);
	const endCode = endCodeOf(code);
	if (code === BOLD || code === DIM) return state.some((s) => s.code === code) ? state : [...state, { code, endCode }];
	return [...state.filter((s) => s.endCode !== endCode), { code, endCode }];
};

export function createBunAnt({ stringWidth }) {
	const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	class CellSegmenter {
		constructor(opts = {}) {
			this.ambiguousIsNarrow = opts.ambiguousIsNarrow ?? true;
			const ranges = opts.substitute ?? [];
			this.substituteRe = ranges.length ? new RegExp(`[${ranges.map(([a, b]) => `\\u{${a.toString(16)}}` + (b > a ? `-\\u{${b.toString(16)}}` : "")).join("")}]`, "gu") : null;
			this.screen = opts.screen;
			this.graphemes = [];
			this.graphemeIds = new Map();
			this.graphemeWidths = [];
			this.sgrKeys = [""];
			this.sgrCloseKeys = [""];
			this.sgrIds = new Map([["", 0]]);
			this.uris = [""];
			this.uriIds = new Map([["", 0]]);
			this.outCells = [];
			this.outRuns = [];
		}
		internGrapheme(g) {
			let id = this.graphemeIds.get(g);
			if (id === undefined) {
				id = this.graphemes.length;
				this.graphemes.push(g);
				this.graphemeIds.set(g, id);
				this.graphemeWidths.push(stringWidth(g, { ambiguousIsNarrow: this.ambiguousIsNarrow }));
			}
			return id;
		}
		internStyle(state) {
			const key = state.map((s) => s.code).join("\0");
			let id = this.sgrIds.get(key);
			if (id === undefined) {
				id = this.sgrKeys.length;
				this.sgrKeys.push(key);
				this.sgrCloseKeys.push(state.map((s) => s.endCode).join("\0"));
				this.sgrIds.set(key, id);
			}
			return id;
		}
		internUri(uri) {
			let id = this.uriIds.get(uri);
			if (id === undefined) { id = this.uris.length; this.uris.push(uri); this.uriIds.set(uri, id); }
			return id;
		}
		segment(text, cells, runs, _reorder) {
			const oc = this.outCells, or = this.outRuns;
			oc.length = 0; or.length = 0;
			let state = [], styleId = 0, uriId = 0, run = -1, runStyle = -1, runUri = -1;
			const emit = (gid, info) => {
				if (styleId !== runStyle || uriId !== runUri) { run++; runStyle = styleId; runUri = uriId; or.push(styleId, uriId); }
				oc.push(gid, info | (run << RUN_SHIFT));
			};
			const flushText = (s) => {
				if (!s) return;
				if (this.substituteRe) s = s.replace(this.substituteRe, "�");
				for (const { segment: g } of graphemeSegmenter.segment(s)) {
					const id = this.internGrapheme(g);
					const w = this.graphemeWidths[id];
					if (w > 0) emit(id, w > 255 ? 255 : w);
				}
			};
			const n = text.length;
			let i = 0, start = 0;
			while (i < n) {
				const c = text.charCodeAt(i);
				if (c >= 0x20 && c !== 0x7f && c !== CSI8) { i++; continue; }
				flushText(text.slice(start, i));
				if (c === 0x09) { emit(this.internGrapheme("\t"), TAB_FLAG); i++; }
				else if (c === ESC || c === CSI8) {
					const csi = c === CSI8 || text[i + 1] === "[";
					if (csi) {
						let j = i + (c === CSI8 ? 1 : 2);
						while (j < n && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j++;
						if (j < n && text[j] === "m") {
							for (const code of splitSgr(text.slice(i + (c === CSI8 ? 1 : 2), j))) state = applySgr(state, code);
							styleId = this.internStyle(state);
						}
						i = Math.min(j + 1, n);
					} else {
						const k = text[i + 1];
						if (k === "]" || k === "P" || k === "_" || k === "^" || k === "X") {
							// string sequence, terminated by BEL or ST (ESC \)
							let j = i + 2, end = -1, after = n;
							while (j < n) {
								if (text.charCodeAt(j) === 0x07) { end = j; after = j + 1; break; }
								if (text.charCodeAt(j) === ESC && text[j + 1] === "\\") { end = j; after = j + 2; break; }
								j++;
							}
							const body = text.slice(i + 2, end === -1 ? n : end);
							if (k === "]" && body.startsWith("8;")) {
								const semi = body.indexOf(";", 2);
								uriId = this.internUri(semi === -1 ? "" : body.slice(semi + 1));
							}
							i = after;
						} else if (k === "(" || k === ")" || k === "*" || k === "+") i += 3;
						else i += k === undefined ? 1 : 2;
					}
				} else i++; // other C0 controls / DEL: dropped
				start = i;
			}
			flushText(text.slice(start, n));
			const count = oc.length >> 1;
			if (!cells || !runs || cells.length < oc.length || runs.length < or.length) return -Math.max(count, or.length >> 1, 1);
			for (let k = 0; k < oc.length; k++) cells[k] = oc[k];
			for (let k = 0; k < or.length; k++) runs[k] = or[k];
			return count;
		}
		// setCellAt from the 2.1.87 JS renderer, on (charIndex, word) pairs. Returns [lo, hi) damage.
		put(A, W, x, y, ch, word, dmg) {
			if (x < 0 || y < 0 || x >= W) return;
			const s = this.screen, M = s.widthMask, z = (y * W + x) << 1;
			const blank = s.emptyWord & ~M;
			const newW = word & M;
			const old = A[z + 1] & M;
			let lo = x, hi = x + 1;
			if (old === s.wide && newW !== s.wide && x + 1 < W && (A[z + 3] & M) === s.spacerTail) { A[z + 2] = s.emptyCharIndex; A[z + 3] = blank | s.narrow; hi = x + 2; }
			if (old === s.spacerTail && newW !== s.spacerTail && x > 0 && (A[z - 1] & M) === s.wide) { A[z - 2] = s.emptyCharIndex; A[z - 1] = blank | s.narrow; lo = x - 1; }
			A[z] = ch; A[z + 1] = word;
			if (newW === s.wide && x + 1 < W) {
				const J = z + 2;
				if ((A[J + 1] & M) === s.wide && x + 2 < W && (A[J + 3] & M) === s.spacerTail) { A[J + 2] = s.emptyCharIndex; A[J + 3] = blank | s.narrow; }
				A[J] = s.spacerCharIndex; A[J + 1] = blank | s.spacerTail;
				hi = Math.max(hi, x + 2);
			}
			if (lo < dmg[0]) dmg[0] = lo;
			if (hi > dmg[1]) dmg[1] = hi;
		}
		paint(A, W, x, y, cells, count, _unused, charIndex, words) {
			const s = this.screen;
			if (!s) throw new Error("CellSegmenter.paint: constructed without a screen config");
			const blank = s.emptyWord & ~s.widthMask;
			const dmg = [Infinity, -1];
			let w = x;
			for (let i = 0; i < count; i++) {
				const info = cells[2 * i + 1];
				if (info & TAB_FLAG) {
					const stop = s.tabWidth - (((w % s.tabWidth) + s.tabWidth) % s.tabWidth);
					for (let k = 0; k < stop && w < W; k++, w++) this.put(A, W, w, y, s.emptyCharIndex, blank | s.narrow, dmg);
					continue;
				}
				const width = info & 255;
				if (width === 0) continue;
				const wide = width >= 2;
				if (wide && w + 2 > W) { this.put(A, W, w, y, s.emptyCharIndex, blank | s.spacerHead, dmg); w++; continue; }
				const word = (words[info >>> RUN_SHIFT] & ~s.widthMask) | (wide ? s.wide : s.narrow);
				this.put(A, W, w, y, charIndex[cells[2 * i]], word, dmg);
				w += wide ? 2 : 1;
			}
			return pack(w, dmg);
		}
		setCell(A, W, x, y, ch, word) {
			const dmg = [Infinity, -1];
			this.put(A, W, x, y, ch, word, dmg);
			const s = this.screen;
			return pack(x + ((word & s.widthMask) === s.wide ? 2 : 1), dmg);
		}
	}
	const pack = (endX, [lo, hi]) => {
		const e = Math.max(0, Math.min(endX, P20 - 1));
		if (hi <= lo) return e;
		return e + Math.max(0, lo) * P20 + Math.min(hi, 65535) * P36;
	};
	return {
		CellSegmenter,
		// The other Bun.ant members (getPeerPid/Uid, memoryPressureLevel, setDumpable,
		// windowsSandboxDeniesArg) are left out on purpose: every call site either feature-tests
		// them or wraps them in try/catch, and none is on the TUI path in agentOS.
	};
}
