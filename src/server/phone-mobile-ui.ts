import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { DEFAULT_THEME, effectiveColors, themeVars } from "../core/themes.ts";
import { readThemeBoot } from "./theme-boot.ts";

export interface ResolvedMobileAsset {
	filePath: string;
	contentType: string;
}

const KATEX_WOFF2_RE = /^KaTeX_[A-Za-z0-9_-]+\.woff2$/;

function resolveAssetFile(relativeSegments: string[]): string | null {
	const roots = [PATHS.root, process.cwd()];
	const seen = new Set<string>();
	for (const root of roots) {
		if (!root || seen.has(root)) continue;
		seen.add(root);
		const candidate = path.join(/* turbopackIgnore: true */ root, ...relativeSegments);
		if (fs.existsSync(/* turbopackIgnore: true */ candidate)) {
			return candidate;
		}
	}
	return null;
}

/** Resolve local font and KaTeX static assets bundled into both dev and packaged standalone builds. */
export function resolveMobileAsset(assetSegments: string[]): ResolvedMobileAsset | null {
	if (assetSegments.length === 1 && assetSegments[0] === "cmunbx.ttf") {
		const filePath = resolveAssetFile(["public", "fonts", "cmunbx.ttf"]);
		return filePath ? { filePath, contentType: "font/ttf" } : null;
	}
	if (assetSegments.length === 1 && assetSegments[0] === "katex.min.css") {
		const filePath = resolveAssetFile(["node_modules", "katex", "dist", "katex.min.css"]);
		return filePath ? { filePath, contentType: "text/css; charset=utf-8" } : null;
	}
	if (assetSegments.length === 1 && assetSegments[0] === "katex.min.js") {
		const filePath = resolveAssetFile(["node_modules", "katex", "dist", "katex.min.js"]);
		return filePath ? { filePath, contentType: "application/javascript; charset=utf-8" } : null;
	}
	if (assetSegments.length === 2 && assetSegments[0] === "fonts" && KATEX_WOFF2_RE.test(assetSegments[1]!)) {
		const filePath = resolveAssetFile(["node_modules", "katex", "dist", "fonts", assetSegments[1]!]);
		return filePath ? { filePath, contentType: "font/woff2" } : null;
	}
	return null;
}

function readDesktopThemeTokens(): { mode: "light" | "dark"; vars: Record<string, string> } {
	try {
		const boot = readThemeBoot();
		return {
			mode: boot.theme.mode === "dark" ? "dark" : "light",
			vars: boot.vars,
		};
	} catch {
		const fallbackTheme = DEFAULT_THEME;
		return {
			mode: fallbackTheme.mode === "dark" ? "dark" : "light",
			vars: themeVars(effectiveColors(fallbackTheme, undefined), fallbackTheme.mode),
		};
	}
}

export function buildMobileHtml(uploadEndpoint: string): string {
	const baseTokenPath = uploadEndpoint.replace(/\/upload$/, "");
	const uploadEndpointLiteral = JSON.stringify(uploadEndpoint);
	const companionEndpointLiteral = JSON.stringify(`${baseTokenPath}/companion`);
	const assetsBaseLiteral = `${baseTokenPath}/assets`;

	const theme = readDesktopThemeTokens();
	const v = theme.vars;
	const cssVars = [
		`--bg: ${v["--background"] ?? "#f6f3ec"};`,
		`--fg: ${v["--foreground"] ?? "#26231d"};`,
		`--card: ${v["--card"] ?? "#efeae0"};`,
		`--muted: ${v["--muted-foreground"] ?? "#736c60"};`,
		`--border: ${v["--border"] ?? "#ddd6c9"};`,
		`--accent: ${v["--lh-accent"] ?? "#4f7a59"};`,
		`--primary: ${v["--primary"] ?? "#26231d"};`,
		`--primary-fg: ${v["--primary-foreground"] ?? "#f6f3ec"};`,
		`--hover: ${v["--accent"] ?? "#e3ddd0"};`,
		`--success: ${v["--lh-success"] ?? "#3a7d52"};`,
		`--warning: ${v["--lh-warning"] ?? "#b46d1e"};`,
		`--error: ${v["--lh-error"] ?? "#b83c3c"};`,
		`--ink-strong: ${v["--lh-ink-strong"] ?? v["--foreground"] ?? "#1c1914"};`,
		`--ink-code: ${v["--lh-ink-code"] ?? "#6b543b"};`,
	].join("\n    ");

	return `<!doctype html>
<html lang="en" data-mode="${theme.mode}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>ChronoHarness · Mobile Study</title>
<link rel="stylesheet" href="${assetsBaseLiteral}/katex.min.css" />
<script defer src="${assetsBaseLiteral}/katex.min.js"></script>
<style>
  @font-face {
    font-family: "CMU Serif";
    src: url("${assetsBaseLiteral}/cmunbx.ttf") format("truetype");
    font-weight: 400 800;
    font-style: normal;
    font-display: swap;
  }
  :root {
    color-scheme: ${theme.mode};
    ${cssVars}
    --font-serif: "CMU Serif", Georgia, "Times New Roman", serif;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font-sans); min-height: 100dvh; }
  body { padding: 12px 12px calc(20px + env(safe-area-inset-bottom)); display: flex; justify-content: center; align-items: flex-start; }
  .shell { width: 100%; max-width: 520px; border: 1px solid var(--border); border-radius: 16px; background: var(--bg); overflow: hidden; box-shadow: 0 6px 28px rgba(0, 0, 0, 0.08); }
  .topbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--border); background: var(--card); }
  .brand-wrap { min-width: 0; }
  .brand { font-family: var(--font-serif); font-size: 20px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.15; margin: 0; color: var(--fg); }
  .brand-sub { font-family: var(--font-mono); font-size: 10px; color: var(--muted); margin-top: 2px; letter-spacing: 0.03em; text-transform: uppercase; }
  .status-pill { font-family: var(--font-mono); font-size: 11px; font-weight: 600; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); white-space: nowrap; }
  .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 10px 12px; background: var(--card); border-bottom: 1px solid var(--border); }
  .tab-btn { border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: 9px; padding: 8px 6px; font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; transition: background 0.15s, color 0.15s, border-color 0.15s; }
  .tab-btn.active { background: var(--bg); color: var(--fg); border-color: var(--border); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
  .panel { display: none; padding: 14px 14px 16px; min-width: 0; overflow-x: hidden; }
  .panel.active { display: block; }
  p { margin: 0 0 12px; font-size: 13px; line-height: 1.5; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--font-mono); }
  .serif { font-family: var(--font-serif); }
  .subcard { padding: 13px; border-radius: 12px; border: 1px solid var(--border); background: var(--card); margin-bottom: 12px; min-width: 0; }
  .row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; border-radius: 10px; padding: 8px 12px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--bg); color: var(--fg); transition: background 0.12s, opacity 0.12s; text-decoration: none; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-block { display: flex; width: 100%; min-height: 44px; }
  .btn-primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
  .btn-ghost { background: transparent; border-color: var(--border); color: var(--fg); }
  .btn-sm { min-height: 30px; padding: 4px 10px; font-size: 11px; border-radius: 8px; }
  .seg-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; padding: 3px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); margin-bottom: 8px; }
  .seg-grid-3 { grid-template-columns: repeat(3, 1fr); }
  .pill-btn { border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: 7px; padding: 6px 8px; font-size: 11px; font-weight: 600; cursor: pointer; text-align: center; }
  .pill-btn.active { background: var(--card); color: var(--fg); border-color: var(--border); }
  .scope-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .scope-chip { border: 1px solid var(--border); background: var(--bg); color: var(--muted); border-radius: 999px; padding: 4px 9px; font-size: 11px; cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; gap: 5px; max-width: 100%; }
  .scope-chip.active { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
  .scope-chip span.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meter { height: 7px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; margin: 8px 0; }
  .meter-fill { height: 100%; background: var(--success); border-radius: 999px; transition: width 0.25s; }
  .meter-fill.warn { background: var(--warning); }
  .meter-fill.danger { background: var(--error); }
  input[type="file"] { display: none; }
  .list { margin-top: 10px; display: grid; gap: 8px; }
  .item { padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--card); font-size: 13px; }
  .status-line { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
  .ok { color: var(--success); }
  .err { color: var(--error); }
  .warn { color: var(--warning); }
  .flashcard { border: 1px solid var(--border); background: var(--card); border-radius: 14px; padding: 16px; min-height: 170px; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; }
  .fc-title { font-family: var(--font-serif); font-size: 17px; font-weight: 700; line-height: 1.3; margin-bottom: 6px; }
  .fc-q { font-size: 15px; font-weight: 500; line-height: 1.5; }
  .fc-a { font-size: 14px; line-height: 1.55; padding-top: 12px; border-top: 1px dashed var(--border); }
  .rate-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 12px; }
  .rate-btn { border: 1px solid var(--border); border-radius: 10px; padding: 9px 4px; background: var(--bg); color: var(--fg); font-size: 12px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .rate-btn small { font-family: var(--font-mono); font-size: 10px; color: var(--muted); font-weight: 500; }
  .rate-1 { border-color: color-mix(in srgb, var(--error) 45%, var(--border)); }
  .rate-2 { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }
  .rate-3 { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
  .rate-4 { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
  .session-item { padding: 11px 12px; border-radius: 11px; border: 1px solid var(--border); background: var(--card); cursor: pointer; text-align: left; width: 100%; color: inherit; transition: background 0.12s; }
  .session-item:hover { background: var(--hover); }
  .session-title { font-family: var(--font-serif); font-size: 15px; font-weight: 700; line-height: 1.3; }
  .session-meta { font-family: var(--font-mono); font-size: 10px; color: var(--muted); display: flex; gap: 6px; align-items: center; margin-top: 3px; }
  .session-snippet { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .msg-list { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 10px; margin: 12px 0; max-height: 46dvh; overflow-y: auto; overflow-x: hidden; padding-right: 2px; }
  .msg { min-width: 0; max-width: 100%; padding: 10px 12px; border-radius: 11px; font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; word-break: break-word; border: 1px solid var(--border); }
  .msg.user { background: var(--hover); margin-left: 20px; border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .msg.assistant { background: var(--card); }
  .msg-role { font-family: var(--font-mono); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px; }
  .msg.user .msg-role { color: var(--accent); }
  .rich { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .rich p { margin: 0 0 8px; font-size: inherit; }
  .rich p:last-child { margin-bottom: 0; }
  .rich strong { color: var(--ink-strong); font-weight: 700; }
  .rich code { font-family: var(--font-mono); font-size: 0.88em; color: var(--ink-code); background: var(--bg); padding: 1px 4px; border-radius: 4px; border: 1px solid var(--border); }
  .rich pre { font-family: var(--font-mono); font-size: 12px; background: var(--bg); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); max-width: 100%; overflow-x: auto; margin: 6px 0; }
  .rich ul { margin: 4px 0 8px 18px; padding: 0; }
  .rich li { margin-bottom: 3px; }
  .rich .katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 4px 0; margin: 6px 0; }
  .field, textarea.field, input.field { width: 100%; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); padding: 9px 11px; font-size: 13px; font-family: inherit; outline: none; }
  textarea.field { min-height: 68px; resize: vertical; }
  .q-card { min-width: 0; max-width: 100%; overflow-x: hidden; padding: 11px 12px; border-radius: 11px; border: 1px solid var(--warning); background: var(--card); margin-bottom: 10px; }
  .q-opt { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; border: 1px solid var(--border); background: var(--bg); color: var(--fg); border-radius: 9px; padding: 8px 10px; font-size: 12.5px; margin-top: 6px; cursor: pointer; }
  .q-opt.selected { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
  .pulse { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--accent); padding: 6px 10px; border-radius: 8px; border: 1px dashed var(--border); background: var(--card); margin-bottom: 8px; }
  .attach-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .attach-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .attach-strip.hidden { display: none !important; }
  .attach-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--card); font-size: 11px; max-width: 100%; }
  .attach-chip.uploading { border-color: var(--accent); color: var(--accent); }
  .attach-chip.error { border-color: var(--error); color: var(--error); }
  .attach-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 175px; }
  .attach-chip-x { border: none; background: transparent; color: var(--muted); font-size: 13px; line-height: 1; padding: 0 2px; cursor: pointer; }
  .hidden { display: none !important; }
  .error-box { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--error); background: var(--card); font-size: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }
</style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand-wrap">
        <h1 class="brand">ChronoHarness</h1>
        <div class="brand-sub" id="topbar-sub">Mobile Study Companion</div>
      </div>
      <span class="status-pill" id="header-badge">Syncing...</span>
    </header>

    <nav class="tabs" role="tablist">
      <button type="button" class="tab-btn active" id="tab-photo">Photo</button>
      <button type="button" class="tab-btn" id="tab-cards">Cards <span id="tab-cards-count"></span></button>
      <button type="button" class="tab-btn" id="tab-exam">Exam &amp; Chat</button>
    </nav>

    <section class="panel active" id="panel-photo">
      <p class="muted">Snap handwritten math proofs, notes, or problem sheets. Photos land directly in your desktop composer.</p>
      <div class="list" style="margin-top:0">
        <label class="btn btn-primary btn-block" for="cam">Take Photo with Camera</label>
        <input id="cam" type="file" accept="image/*" capture="environment" />
        <label class="btn btn-block" for="lib">Choose from Photo Library</label>
        <input id="lib" type="file" accept="image/*" multiple />
      </div>
      <label class="muted" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;cursor:pointer">
        <input id="hd" type="checkbox" />
        <span>High detail (2400px · slower over 4G/5G)</span>
      </label>
      <div class="list" id="upload-list" aria-live="polite"></div>
    </section>

    <section class="panel" id="panel-cards">
      <div class="row-between" style="margin-bottom:10px">
        <span class="muted mono" id="cards-stats" style="font-size:11px">Loading flashcards...</span>
        <button type="button" class="btn btn-sm btn-ghost" id="cards-refresh">Refresh</button>
      </div>
      <div id="cards-error" class="hidden"></div>
      <div id="cards-empty" class="subcard hidden">
        <div class="serif" style="font-size:16px;font-weight:700;margin-bottom:4px">All caught up!</div>
        <div class="muted" style="font-size:12px">No due flashcards right now. Check back later or start an interactive session in Exam &amp; Chat.</div>
      </div>
      <div id="card-box" class="hidden">
        <div class="flashcard">
          <div>
            <div class="row-between" style="margin-bottom:6px">
              <span class="muted mono" id="fc-progress" style="font-size:11px">1 / 1</span>
              <span class="status-pill" id="fc-due-tag" style="font-size:10px;padding:2px 7px">DUE</span>
            </div>
            <div class="fc-title" id="fc-name"></div>
            <div class="fc-q rich" id="fc-question"></div>
          </div>
          <div id="fc-answer-wrap" class="fc-a hidden">
            <div class="muted mono" style="font-size:10px;text-transform:uppercase;margin-bottom:4px">Answer</div>
            <div id="fc-answer" class="rich"></div>
            <div id="fc-statement" class="muted rich" style="margin-top:8px;font-size:12px"></div>
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-block" id="fc-reveal" style="margin-top:10px">Show Answer</button>
        <div class="rate-grid hidden" id="fc-rates">
          <button type="button" class="rate-btn rate-1" data-rating="1">Again<small id="int-1">1m</small></button>
          <button type="button" class="rate-btn rate-2" data-rating="2">Hard<small id="int-2">6m</small></button>
          <button type="button" class="rate-btn rate-3" data-rating="3">Good<small id="int-3">10m</small></button>
          <button type="button" class="rate-btn rate-4" data-rating="4">Easy<small id="int-4">4d</small></button>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-exam">
      <div id="companion-error" class="hidden"></div>

      <div id="exam-home">
        <div class="subcard" id="planner-mobile-card">
          <div class="row-between">
            <span class="serif" style="font-size:16px;font-weight:700">Today&apos;s Study Plan</span>
            <span class="status-pill" id="planner-target-pill">--h min</span>
          </div>
          <div id="planner-sleep-line" class="muted mono" style="font-size:11px;margin:5px 0 8px"></div>
          <div id="planner-milestones" class="scope-strip" style="margin-top:0;margin-bottom:8px"></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
            <button type="button" class="pill-btn" id="mob-meals-ok" style="border:1px solid var(--border)">Meals OK</button>
            <button type="button" class="pill-btn" id="mob-hobby-ok" style="border:1px solid var(--border)">Hobby Done</button>
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)">
              <span>Slept</span>
              <input type="time" id="mob-bedtime" style="border:1px solid var(--border);background:var(--bg);color:var(--ink);border-radius:8px;padding:3px 6px;font-size:11px">
            </label>
          </div>
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-bottom:8px" id="mob-energy-strip">
            <span class="muted mono" style="font-size:11px;margin-right:2px">Energy:</span>
            <button type="button" class="pill-btn" data-energy="1" style="border:1px solid var(--border);padding:3px 8px">1</button>
            <button type="button" class="pill-btn" data-energy="2" style="border:1px solid var(--border);padding:3px 8px">2</button>
            <button type="button" class="pill-btn" data-energy="3" style="border:1px solid var(--border);padding:3px 8px">3</button>
            <button type="button" class="pill-btn" data-energy="4" style="border:1px solid var(--border);padding:3px 8px">4</button>
            <button type="button" class="pill-btn" data-energy="5" style="border:1px solid var(--border);padding:3px 8px">5</button>
          </div>
          <div id="planner-blocks" class="list" style="margin-top:4px"></div>
        </div>

        <div class="subcard">
          <div class="row-between">
            <span class="serif" style="font-size:16px;font-weight:700" id="exam-title-heading">Study Focus</span>
            <span class="status-pill" id="exam-readiness">Readiness --%</span>
          </div>
          <div class="meter"><div class="meter-fill" id="exam-meter" style="width:0%"></div></div>
          <div id="exam-countdown-line" class="muted mono" style="font-size:11px;margin-bottom:8px"></div>

          <div class="muted mono" style="font-size:10px;text-transform:uppercase;margin-bottom:4px">Subject Scope</div>
          <div class="scope-strip" id="exam-scopes"></div>

          <div class="muted mono" style="font-size:10px;text-transform:uppercase;margin:10px 0 4px">Study Mode</div>
          <div class="seg-grid">
            <button type="button" class="pill-btn" data-mode="long-term">Long-Term</button>
            <button type="button" class="pill-btn" data-mode="exam">Exam Prep</button>
          </div>
          <div class="muted mono" style="font-size:10px;text-transform:uppercase;margin:6px 0 4px">Teaching Pace</div>
          <div class="seg-grid seg-grid-3">
            <button type="button" class="pill-btn" data-pace="thorough">Thorough</button>
            <button type="button" class="pill-btn" data-pace="efficient">Efficient</button>
            <button type="button" class="pill-btn" data-pace="crash-course">Crash</button>
          </div>

          <div id="exam-profiles-wrap" class="hidden" style="margin-top:8px">
            <div class="muted mono" style="font-size:10px;text-transform:uppercase;margin-bottom:4px">Saved Exams</div>
            <div class="scope-strip" id="exam-profiles"></div>
          </div>

          <div id="exam-weak-summary" class="muted" style="font-size:12px;margin-top:8px;margin-bottom:0"></div>
        </div>

        <div class="subcard">
          <div class="row-between" style="margin-bottom:8px">
            <span class="serif" style="font-size:15px;font-weight:700">New Interactive Lesson</span>
            <button type="button" class="btn btn-sm" id="btn-drill-weak">Drill Weak Roots</button>
          </div>
          <div class="seg-grid" style="margin-bottom:8px">
            <button type="button" class="pill-btn active" id="new-mode-teach" data-new-mode="teach">Teach Me</button>
            <button type="button" class="pill-btn" id="new-mode-practice" data-new-mode="practice">Practice Problems</button>
          </div>
          <div style="display:flex;gap:6px">
            <input type="text" class="field" id="new-session-prompt" placeholder="Topic, question, or attach photo/file..." />
            <button type="button" class="btn btn-primary" id="btn-start-session" style="flex-shrink:0">Start</button>
          </div>
          <div class="attach-row" style="margin-top:8px">
            <input id="new-cam" type="file" accept="image/*" capture="environment" />
            <label class="btn btn-sm" for="new-cam">&#128247; Camera</label>
            <input id="new-file" type="file" multiple />
            <label class="btn btn-sm" for="new-file">&#128206; Attach File</label>
          </div>
          <div id="new-attachments" class="attach-strip hidden" aria-live="polite"></div>
        </div>

        <div class="row-between" style="margin:12px 0 8px">
          <span class="serif" style="font-size:15px;font-weight:700">Recent Sessions</span>
          <button type="button" class="btn btn-sm btn-ghost" id="exam-refresh">Refresh</button>
        </div>
        <div id="recent-sessions" class="list" style="margin-top:0">
          <div class="item muted">Loading sessions...</div>
        </div>
      </div>

      <div id="session-reader" class="hidden">
        <div class="row-between" style="margin-bottom:10px">
          <button type="button" class="btn btn-sm" id="reader-back">&#8592; Sessions</button>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="status-pill" id="reader-mode-badge" style="font-size:10px">TEACH</span>
            <button type="button" class="btn btn-sm btn-ghost" id="reader-toggle-notes">Notes</button>
          </div>
        </div>
        <div class="serif" id="reader-title" style="font-size:18px;font-weight:700;line-height:1.25;margin-bottom:8px"></div>

        <div id="reader-notes-box" class="subcard hidden">
          <div class="row-between" style="margin-bottom:6px">
            <label for="reader-notes" class="muted mono" style="font-size:10px;text-transform:uppercase">Per-Lesson Notes</label>
            <button type="button" class="btn btn-sm" id="reader-save-note">Save Note</button>
          </div>
          <textarea id="reader-notes" class="field" placeholder="Write personal study notes for this lesson..."></textarea>
        </div>

        <div id="reader-busy" class="pulse hidden">Tutor is thinking and composing a response...</div>
        <div id="reader-messages" class="msg-list"></div>

        <div id="reader-pending-wrap" class="q-card hidden">
          <div class="mono" style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--warning);margin-bottom:4px" id="reader-pending-kind">Tutor Check</div>
          <div id="reader-pending-text" class="rich" style="font-size:13px"></div>
          <div id="reader-pending-options"></div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm btn-primary hidden" id="reader-submit-opts">Submit Selected</button>
            <button type="button" class="btn btn-sm btn-ghost hidden" id="reader-dont-know">I don't know</button>
          </div>
        </div>

        <div style="display:grid;gap:6px;margin-top:8px">
          <div class="attach-row">
            <input id="reader-cam" type="file" accept="image/*" capture="environment" />
            <label class="btn btn-sm" for="reader-cam">&#128247; Camera</label>
            <input id="reader-file" type="file" multiple />
            <label class="btn btn-sm" for="reader-file">&#128206; Attach File</label>
          </div>
          <div id="reader-attachments" class="attach-strip hidden" aria-live="polite"></div>
          <textarea id="reader-reply" class="field" placeholder="Write your answer, question, or reasoning..." style="min-height:58px"></textarea>
          <button type="button" class="btn btn-primary btn-block" id="reader-send-reply">Send to Tutor</button>
        </div>
        <p id="reader-status" class="muted mono" style="font-size:11px;margin-top:8px;margin-bottom:0"></p>
      </div>
    </section>
  </main>

<script>
(function () {
  var UPLOAD_URL = ${uploadEndpointLiteral};
  var COMPANION_URL = ${companionEndpointLiteral};
  var CONCURRENCY = 2;

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMathSnippet(tex, displayMode) {
    if (window.katex && typeof window.katex.renderToString === "function") {
      try {
        return window.katex.renderToString(tex, { displayMode: !!displayMode, throwOnError: false, strict: false });
      } catch (e) {}
    }
    return "<code>" + escapeHtml((displayMode ? "$$" : "$") + tex + (displayMode ? "$$" : "$")) + "</code>";
  }

  function formatInlineMarkdown(escaped) {
    var html = escaped;
    html = html.replace(/\`([^\`\\n]+)\`/g, function (_, code) {
      var parts = code.split(String.fromCharCode(92)).join("/").split("/");
      if (parts.indexOf("attachments") >= 0) {
        var base = parts[parts.length - 1] || code;
        return "<code>&#128206; " + base + "</code>";
      }
      return "<code>" + code + "</code>";
    });
    html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
    html = html.replace(/\\*([^*\\n]+)\\*/g, "<em>$1</em>");
    return html;
  }

  function renderRichMath(raw) {
    var src = String(raw || "");
    if (!src.trim()) return "";
    var placeholders = [];
    function hold(html) {
      var token = "@@M_" + placeholders.length + "_M@@";
      placeholders.push(html);
      return token;
    }

    // 1. Protect fenced code blocks
    src = src.replace(/\`\`\`[a-zA-Z0-9_-]*\\n([\\s\\S]*?)\`\`\`/g, function (_, code) {
      return hold("<pre>" + escapeHtml(code.trim()) + "</pre>");
    });
    // 2. Display math $$...$$ and \\[...\\]
    src = src.replace(/\\$\\$([\\s\\S]+?)\\$\\$/g, function (_, tex) {
      return hold(renderMathSnippet(tex.trim(), true));
    });
    src = src.replace(/\\\\\\[([\\s\\S]+?)\\\\\\]/g, function (_, tex) {
      return hold(renderMathSnippet(tex.trim(), true));
    });
    // 3. Inline math $...$ and \\(...\\)
    src = src.replace(/\\\\\\(([\\s\\S]+?)\\\\\\)/g, function (_, tex) {
      return hold(renderMathSnippet(tex.trim(), false));
    });
    src = src.replace(/(^|[^\\\\])\\$([^\\n$]+?)\\$/g, function (_, lead, tex) {
      return lead + hold(renderMathSnippet(tex.trim(), false));
    });

    var lines = src.replace(/\\r\\n/g, "\\n").split("\\n");
    var out = [];
    var inList = false;
    var para = [];
    function flushPara() {
      if (!para.length) return;
      out.push("<p>" + formatInlineMarkdown(escapeHtml(para.join(" "))) + "</p>");
      para = [];
    }
    function closeList() {
      if (inList) { out.push("</ul>"); inList = false; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (!trimmed) {
        flushPara();
        closeList();
        continue;
      }
      if (/^@@M_\\d+_M@@$/.test(trimmed)) {
        flushPara();
        closeList();
        out.push("<div>" + trimmed + "</div>");
        continue;
      }
      var listMatch = /^[-*]\\s+(.*)$/.exec(trimmed);
      if (listMatch) {
        flushPara();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + formatInlineMarkdown(escapeHtml(listMatch[1])) + "</li>");
        continue;
      }
      closeList();
      var hMatch = /^#{1,3}\\s+(.*)$/.exec(trimmed);
      if (hMatch) {
        flushPara();
        out.push("<p><strong>" + formatInlineMarkdown(escapeHtml(hMatch[1])) + "</strong></p>");
        continue;
      }
      var bqMatch = /^>\\s?(.*)$/.exec(trimmed);
      if (bqMatch) {
        flushPara();
        if (bqMatch[1].trim()) {
          out.push("<blockquote style='margin:6px 0;padding:4px 10px;border-left:3px solid var(--border);color:var(--muted)'>" + formatInlineMarkdown(escapeHtml(bqMatch[1].trim())) + "</blockquote>");
        }
        continue;
      }
      para.push(trimmed);
    }
    flushPara();
    closeList();

    var joined = out.join("");
    for (var k = 0; k < placeholders.length; k++) {
      joined = joined.split("@@M_" + k + "_M@@").join(placeholders[k]);
    }
    return joined;
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    var ms = timeoutMs || 14000;
    if (typeof AbortController === "undefined") {
      return fetch(url, options);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    var opts = Object.assign({}, options || {}, { signal: ctrl.signal, cache: "no-store" });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  function fetchJson(url, options, timeoutMs) {
    return fetchWithTimeout(url, options, timeoutMs).then(function (r) {
      return r.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) {}
        if (!r.ok) {
          throw new Error((data && data.error) ? data.error : ("HTTP " + r.status));
        }
        return data;
      });
    });
  }

  var state = {
    dueCards: [],
    totalDue: 0,
    totalTracked: 0,
    cardIndex: 0,
    revealed: false,
    examPrep: null,
    planner: null,
    recentSessions: [],
    activeSession: null,
    selectedOptions: [],
    newSessionMode: "teach",
    newAttachments: [],
    readerAttachments: [],
    attachmentSeq: 0,
    pollTimer: null
  };

  function showErrorBox(containerId, message, onRetry) {
    var box = byId(containerId);
    if (!box) return;
    if (!message) {
      box.className = "hidden";
      box.innerHTML = "";
      return;
    }
    box.className = "error-box";
    box.innerHTML = "<span class='err'>" + escapeHtml(message) + "</span><button type='button' class='btn btn-sm'>Retry</button>";
    box.querySelector("button").addEventListener("click", onRetry);
  }

  function activateTab(name) {
    ["photo", "cards", "exam"].forEach(function (t) {
      byId("tab-" + t).classList.toggle("active", t === name);
      byId("panel-" + t).classList.toggle("active", t === name);
    });
    if (name !== "exam") stopPolling();
    if (name !== "photo" && !state.examPrep) loadCompanionState();
  }

  byId("tab-photo").addEventListener("click", function () { activateTab("photo"); });
  byId("tab-cards").addEventListener("click", function () { activateTab("cards"); });
  byId("tab-exam").addEventListener("click", function () { activateTab("exam"); });

  function renderHeaderBadge() {
    var ex = state.examPrep;
    var badge = byId("header-badge");
    if (!ex) {
      badge.textContent = "Online";
      return;
    }
    var parts = [];
    if (ex.config && ex.config.mode === "exam") {
      parts.push(typeof ex.daysRemaining === "number" ? (ex.daysRemaining >= 0 ? "D-" + ex.daysRemaining : "+" + Math.abs(ex.daysRemaining) + "d") : "Exam");
    }
    parts.push("Due " + state.totalDue);
    parts.push(ex.examReadinessPct + "%");
    badge.textContent = parts.join(" · ");
    byId("tab-cards-count").textContent = state.totalDue > 0 ? "(" + state.totalDue + ")" : "";
  }

  function renderCards() {
    renderHeaderBadge();
    byId("cards-stats").textContent = "Due now: " + state.totalDue + " · Tracked cards: " + state.totalTracked;
    if (!state.dueCards.length) {
      byId("cards-empty").classList.remove("hidden");
      byId("card-box").classList.add("hidden");
      return;
    }
    byId("cards-empty").classList.add("hidden");
    byId("card-box").classList.remove("hidden");
    if (state.cardIndex >= state.dueCards.length) state.cardIndex = 0;
    var card = state.dueCards[state.cardIndex];
    byId("fc-progress").textContent = (state.cardIndex + 1) + " / " + state.dueCards.length;
    byId("fc-due-tag").textContent = card.isDue ? "DUE" : "NEW";
    byId("fc-name").textContent = card.propositionName;
    byId("fc-question").innerHTML = renderRichMath(card.question);
    byId("fc-answer").innerHTML = renderRichMath(card.answer);
    byId("fc-statement").innerHTML = card.statement && card.statement !== card.answer ? renderRichMath(card.statement) : "";

    state.revealed = false;
    byId("fc-answer-wrap").classList.add("hidden");
    byId("fc-rates").classList.add("hidden");
    byId("fc-reveal").classList.remove("hidden");
    for (var r = 1; r <= 4; r++) {
      byId("int-" + r).textContent = (card.intervals && card.intervals[String(r)]) || "";
    }
  }

  function renderExamAndSessions() {
    renderHeaderBadge();
    var ex = state.examPrep;
    if (ex) {
      var cfg = ex.config || {};
      var pct = ex.examReadinessPct || 0;
      byId("exam-title-heading").textContent = (cfg.examTitle && cfg.mode === "exam") ? cfg.examTitle : (ex.activeScopeLabels && ex.activeScopeLabels.length ? ex.activeScopeLabels[0] : "Study Focus");
      byId("exam-readiness").textContent = "Readiness " + pct + "%";
      var meter = byId("exam-meter");
      meter.style.width = Math.max(4, Math.min(100, pct)) + "%";
      meter.className = "meter-fill " + (pct >= 80 ? "" : pct >= 55 ? "warn" : "danger");

      var cdText = "";
      if (typeof ex.daysRemaining === "number") {
        cdText = ex.daysRemaining > 0 ? ex.daysRemaining + " day(s) until exam" : (ex.daysRemaining === 0 ? "Exam day today!" : Math.abs(ex.daysRemaining) + " day(s) past target");
      } else if (ex.scopedNodeCount !== ex.totalNodeCount) {
        cdText = "Scoped to " + ex.scopedNodeCount + " of " + ex.totalNodeCount + " propositions";
      } else {
        cdText = ex.totalNodeCount ? "Tracking all " + ex.totalNodeCount + " graph propositions" : "No graph propositions yet";
      }
      byId("exam-countdown-line").textContent = cdText;

      // Render subject scope filter chips
      var scopesEl = byId("exam-scopes");
      var scopes = ex.availableScopes || [];
      var selectedIds = cfg.clusterIds || [];
      scopesEl.innerHTML = "";
      var allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "scope-chip" + (selectedIds.length === 0 ? " active" : "");
      allBtn.textContent = "All (" + (ex.totalNodeCount || 0) + ")";
      allBtn.addEventListener("click", function () { updateExamPrep({ clusterIds: [] }); });
      scopesEl.appendChild(allBtn);

      scopes.forEach(function (sc) {
        var active = selectedIds.indexOf(sc.id) >= 0;
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "scope-chip" + (active ? " active" : "");
        chip.innerHTML = "<span class='title'>" + escapeHtml(sc.label) + "</span><span class='mono' style='font-size:10px;opacity:.8'>" + sc.readinessPct + "%</span>";
        chip.addEventListener("click", function () {
          var next = selectedIds.slice();
          var idx = next.indexOf(sc.id);
          if (idx >= 0) next.splice(idx, 1);
          else next.push(sc.id);
          updateExamPrep({ clusterIds: next });
        });
        scopesEl.appendChild(chip);
      });

      document.querySelectorAll("[data-mode]").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-mode") === cfg.mode);
      });
      document.querySelectorAll("[data-pace]").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-pace") === cfg.pace);
      });

      // Saved exams switcher
      var profWrap = byId("exam-profiles-wrap");
      var profEl = byId("exam-profiles");
      var examsList = cfg.exams || [];
      if (examsList.length > 0) {
        profWrap.classList.remove("hidden");
        profEl.innerHTML = "";
        examsList.forEach(function (p) {
          var c = document.createElement("button");
          c.type = "button";
          c.className = "scope-chip" + (cfg.activeExamId === p.id ? " active" : "");
          c.textContent = p.title + (p.date ? " (" + p.date + ")" : "");
          c.addEventListener("click", function () { updateExamPrep({ selectExamId: p.id, mode: "exam" }); });
          profEl.appendChild(c);
        });
      } else {
        profWrap.classList.add("hidden");
      }

      var weakParts = [];
      if (ex.weakFoundationNames && ex.weakFoundationNames.length) weakParts.push("Weak roots: " + ex.weakFoundationNames.slice(0, 3).join(", "));
      if (ex.duePropositionNames && ex.duePropositionNames.length) weakParts.push("Due (" + ex.dueCount + "): " + ex.duePropositionNames.slice(0, 3).join(", "));
      byId("exam-weak-summary").textContent = weakParts.join(" · ");
    }

    renderMobilePlanner();

    var list = byId("recent-sessions");
    if (!state.recentSessions.length) {
      list.innerHTML = "<div class='item muted'>No active desktop sessions found yet. Start one above!</div>";
      return;
    }
    list.innerHTML = "";
    state.recentSessions.forEach(function (s) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "session-item";
      var pinMark = s.pinned ? "<span>PINNED · </span>" : "";
      var snippet = s.lastAssistantSnippet ? "<div class='session-snippet'>" + escapeHtml(s.lastAssistantSnippet) + "</div>" : "";
      btn.innerHTML =
        "<div class='session-title'>" + escapeHtml(s.title) + "</div>" +
        "<div class='session-meta'>" + pinMark + "<span>" + escapeHtml((s.mode || "teach").toUpperCase()) + "</span><span>·</span><span>" + (s.messageCount || 0) + " msgs</span></div>" +
        snippet;
      btn.addEventListener("click", function () { openSessionReader(s.id); });
      list.appendChild(btn);
    });
  }

  function loadCompanionState() {
    showErrorBox("companion-error", "", loadCompanionState);
    showErrorBox("cards-error", "", loadCompanionState);
    return fetchJson(COMPANION_URL, {}, 12000)
      .then(function (data) {
        state.dueCards = data.dueCards || [];
        state.totalDue = data.totalDue || 0;
        state.totalTracked = data.totalTracked || 0;
        state.examPrep = data.examPrep || null;
        state.planner = data.planner || null;
        state.recentSessions = data.recentSessions || [];
        renderCards();
        renderExamAndSessions();
      })
      .catch(function (err) {
        var msg = (err && err.name === "AbortError") ? "Timed out connecting to desktop" : ("Sync failed: " + (err && err.message ? err.message : "offline"));
        byId("header-badge").textContent = "Offline";
        byId("cards-stats").textContent = msg;
        byId("exam-readiness").textContent = "Readiness --%";
        byId("recent-sessions").innerHTML = "<div class='item err'>" + escapeHtml(msg) + "</div>";
        showErrorBox("companion-error", msg, loadCompanionState);
        showErrorBox("cards-error", msg, loadCompanionState);
      });
  }

  function renderMobilePlanner() {
    var pl = state.planner;
    var card = byId("planner-mobile-card");
    if (!card) return;
    if (!pl) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    byId("planner-target-pill").textContent = (pl.minDailyStudyHours || 0) + "h min · " + (pl.plannedStudyHours || 0) + "h";
    byId("planner-sleep-line").textContent = "Sleep target: " + (pl.recommendedBedtime || "--:--") + (pl.sleepShiftAdvice ? " · " + pl.sleepShiftAdvice : "");

    var msEl = byId("planner-milestones");
    msEl.innerHTML = "";
    (pl.upcomingMilestones || []).slice(0, 4).forEach(function (m) {
      var chip = document.createElement("span");
      chip.className = "scope-chip";
      chip.textContent = m.title + " (" + (m.daysLeft >= 0 ? "D-" + m.daysLeft : "+" + Math.abs(m.daysLeft) + "d") + ")";
      msEl.appendChild(chip);
    });

    var log = pl.todayLog || {};
    var doneIds = log.completedBlockIds || [];
    var mealsBtn = byId("mob-meals-ok");
    var hobbyBtn = byId("mob-hobby-ok");
    mealsBtn.classList.toggle("active", Boolean(log.mealsOk));
    mealsBtn.textContent = log.mealsOk ? "Meals OK ✓" : "Meals OK";
    hobbyBtn.classList.toggle("active", Boolean(log.hobbyDone));
    hobbyBtn.textContent = log.hobbyDone ? "Hobby ✓" : "Hobby Done";
    var bedInput = byId("mob-bedtime");
    if (bedInput) {
      bedInput.value = log.actualBedtime || pl.recommendedBedtime || "";
    }
    Array.prototype.slice.call(document.querySelectorAll("#mob-energy-strip [data-energy]")).forEach(function (btn) {
      var val = Number(btn.getAttribute("data-energy"));
      btn.classList.toggle("active", Number(log.energyScore) === val);
    });

    var blocksEl = byId("planner-blocks");
    blocksEl.innerHTML = "";
    var shown = (pl.blocks || []).filter(function (b) {
      return b.type === "study" || b.type === "hobby" || b.type === "sleep";
    }).slice(0, 8);
    if (!shown.length) {
      blocksEl.innerHTML = "<div class='item muted'>No scheduled study blocks yet.</div>";
      return;
    }
    shown.forEach(function (b) {
      var isDone = doneIds.indexOf(b.id) >= 0;
      var row = document.createElement("button");
      row.type = "button";
      row.className = "session-item";
      row.style.opacity = isDone ? "0.55" : "1";
      row.innerHTML =
        "<div class='row-between'><strong style='font-size:12px'>" + escapeHtml(b.startTime + "–" + b.endTime + " · " + b.title) + "</strong>" +
        "<span class='mono' style='font-size:11px'>" + (isDone ? "✓ Done" : "Tap ✓") + "</span></div>" +
        (b.reason ? "<div class='muted' style='font-size:11px;margin-top:2px'>" + escapeHtml(b.reason) + "</div>" : "");
      row.addEventListener("click", function () {
        checkInMobilePlanner({ date: pl.date, toggleBlockId: b.id });
      });
      blocksEl.appendChild(row);
    });
  }

  function checkInMobilePlanner(patch) {
    return fetchJson(COMPANION_URL + "/planner-checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }, 12000)
      .then(function (res) {
        if (res && res.planner) {
          state.planner = res.planner;
          renderMobilePlanner();
        }
      })
      .catch(function (err) {
        showErrorBox("companion-error", "Habit check-in failed: " + err.message, function () { checkInMobilePlanner(patch); });
      });
  }

  function updateExamPrep(patch) {
    byId("exam-readiness").textContent = "Updating...";
    return fetchJson(COMPANION_URL + "/exam-prep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }, 12000)
      .then(function (res) {
        if (res && res.examPrep) {
          state.examPrep = res.examPrep;
          renderExamAndSessions();
        }
        return loadCompanionState();
      })
      .catch(function (err) {
        showErrorBox("companion-error", "Failed to save study setting: " + err.message, function () { updateExamPrep(patch); });
      });
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function schedulePoll(chatId, attemptsLeft) {
    stopPolling();
    if (!state.activeSession || state.activeSession.id !== chatId || attemptsLeft <= 0) return;
    state.pollTimer = setTimeout(function () {
      fetchJson(COMPANION_URL + "/session?chatId=" + encodeURIComponent(chatId), {}, 10000)
        .then(function (detail) {
          if (!state.activeSession || state.activeSession.id !== chatId) return;
          renderSessionDetail(detail);
          if (detail.busy) {
            schedulePoll(chatId, attemptsLeft - 1);
          } else {
            byId("reader-status").textContent = "Up to date.";
            loadCompanionState();
          }
        })
        .catch(function () {
          if (attemptsLeft > 1) schedulePoll(chatId, attemptsLeft - 1);
        });
    }, 1200);
  }

  function renderSessionDetail(detail) {
    state.activeSession = detail;
    state.selectedOptions = [];
    byId("exam-home").classList.add("hidden");
    byId("session-reader").classList.remove("hidden");
    byId("reader-title").textContent = detail.title || "Lesson";
    byId("reader-mode-badge").textContent = (detail.mode || "teach").toUpperCase();
    byId("reader-notes").value = detail.notes || "";
    byId("reader-busy").classList.toggle("hidden", !detail.busy);

    var msgBox = byId("reader-messages");
    var msgs = detail.messages || [];
    var sig = (detail.id || "") + "::" + msgs.map(function (m) {
      return (m.id || "") + ":" + (m.role || "") + ":" + (m.text || "").length;
    }).join("|");
    if (msgBox.dataset.sig !== sig || !msgBox.children.length) {
      msgBox.dataset.sig = sig;
      msgBox.innerHTML = "";
      if (!msgs.length) {
        msgBox.innerHTML = "<div class='muted' style='font-size:12px'>Starting lesson...</div>";
      } else {
        msgs.forEach(function (m) {
          var el = document.createElement("div");
          el.className = "msg " + (m.role === "user" ? "user" : "assistant");
          el.innerHTML = "<div class='msg-role'>" + (m.role === "user" ? "You" : "Tutor") + "</div><div class='rich'>" + renderRichMath(m.text) + "</div>";
          msgBox.appendChild(el);
        });
        msgBox.scrollTop = msgBox.scrollHeight;
      }
    }

    var pendingWrap = byId("reader-pending-wrap");
    var pq = detail.pendingQuestion;
    var promptFallback = detail.pendingQuestionPrompt;
    var submitOptsBtn = byId("reader-submit-opts");
    var dontKnowBtn = byId("reader-dont-know");
    var optsContainer = byId("reader-pending-options");
    optsContainer.innerHTML = "";

    if (pq) {
      pendingWrap.classList.remove("hidden");
      byId("reader-pending-kind").textContent = pq.tool === "quiz" || pq.kind === "quiz" ? "Check Question" : (pq.kind === "explain" ? "Explain in Your Words" : "Question");
      byId("reader-pending-text").innerHTML = renderRichMath(pq.question || promptFallback || "");
      if (pq.options && pq.options.length > 0) {
        submitOptsBtn.classList.remove("hidden");
        dontKnowBtn.classList.toggle("hidden", pq.kind !== "quiz");
        pq.options.forEach(function (opt, idx) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "q-opt";
          b.innerHTML = "<span class='mono' style='font-weight:700'>" + (idx + 1) + ".</span><span>" + renderRichMath(opt.label) + "</span>";
          b.addEventListener("click", function () {
            if (pq.multiSelect) {
              var pos = state.selectedOptions.indexOf(opt.value);
              if (pos >= 0) state.selectedOptions.splice(pos, 1);
              else state.selectedOptions.push(opt.value);
            } else {
              state.selectedOptions = [opt.value];
            }
            optsContainer.querySelectorAll(".q-opt").forEach(function (node, j) {
              node.classList.toggle("selected", state.selectedOptions.indexOf(pq.options[j].value) >= 0);
            });
          });
          optsContainer.appendChild(b);
        });
      } else {
        submitOptsBtn.classList.add("hidden");
        dontKnowBtn.classList.add("hidden");
      }
    } else if (promptFallback) {
      pendingWrap.classList.remove("hidden");
      byId("reader-pending-kind").textContent = "Active Prompt";
      byId("reader-pending-text").innerHTML = renderRichMath(promptFallback);
      submitOptsBtn.classList.add("hidden");
      dontKnowBtn.classList.add("hidden");
    } else {
      pendingWrap.classList.add("hidden");
    }
  }

  function openSessionReader(chatId) {
    activateTab("exam");
    if (!state.activeSession || state.activeSession.id !== chatId) {
      state.readerAttachments = [];
      renderAttachmentChips("reader");
    }
    byId("reader-status").textContent = "Loading lesson...";
    return fetchJson(COMPANION_URL + "/session?chatId=" + encodeURIComponent(chatId), {}, 12000)
      .then(function (detail) {
        renderSessionDetail(detail);
        byId("reader-status").textContent = detail.busy ? "Tutor is responding..." : "Ready";
        if (detail.busy) schedulePoll(chatId, 60);
      })
      .catch(function (err) {
        byId("reader-status").textContent = "Failed to load: " + err.message;
        showErrorBox("companion-error", "Failed to load lesson: " + err.message, function () { openSessionReader(chatId); });
      });
  }

  function sendMobileSessionAction(payload, btn) {
    if (!state.activeSession) return;
    if (btn) btn.disabled = true;
    byId("reader-status").textContent = "Sending to desktop tutor...";
    fetchJson(COMPANION_URL + "/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ chatId: state.activeSession.id }, payload))
    }, 15000)
      .then(function (res) {
        if (res && res.session) renderSessionDetail(res.session);
        if (payload.replyText !== undefined) byId("reader-reply").value = "";
        if (payload.attachmentPaths && payload.attachmentPaths.length) {
          state.readerAttachments = [];
          renderAttachmentChips("reader");
        }
        if (res && (res.triggeredAiTurn || (res.session && res.session.busy))) {
          byId("reader-status").textContent = "Tutor is responding (live polling)...";
          schedulePoll(state.activeSession.id, 70);
        } else if (payload.note !== undefined && !payload.replyText && !payload.selectedValues && !payload.dontKnow && !(payload.attachmentPaths && payload.attachmentPaths.length)) {
          byId("reader-status").textContent = "Notes saved to desktop.";
        } else {
          byId("reader-status").textContent = "Delivered to session.";
          loadCompanionState();
        }
      })
      .catch(function (err) {
        byId("reader-status").textContent = "Failed: " + err.message;
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function startNewSession(opts) {
    var btn = opts.btn;
    if (btn) btn.disabled = true;
    byId("exam-readiness").textContent = "Starting...";
    fetchJson(COMPANION_URL + "/new-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: opts.mode || state.newSessionMode,
        prompt: opts.prompt || "",
        attachmentPaths: (opts.attachmentPaths && opts.attachmentPaths.length) ? opts.attachmentPaths : undefined,
        drill: !!opts.drill
      })
    }, 15000)
      .then(function (res) {
        byId("new-session-prompt").value = "";
        if (opts.attachmentPaths && opts.attachmentPaths.length) {
          state.newAttachments = [];
          renderAttachmentChips("new");
        }
        if (res && res.session) {
          renderSessionDetail(res.session);
          if (res.triggeredAiTurn || res.session.busy) {
            byId("reader-status").textContent = "Tutor is composing opening lesson...";
            schedulePoll(res.session.id, 70);
          }
          loadCompanionState();
        }
      })
      .catch(function (err) {
        showErrorBox("companion-error", "Could not start lesson: " + err.message, loadCompanionState);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  byId("fc-reveal").addEventListener("click", function () {
    byId("fc-answer-wrap").classList.remove("hidden");
    byId("fc-rates").classList.remove("hidden");
    byId("fc-reveal").classList.add("hidden");
  });

  document.querySelectorAll("[data-rating]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var card = state.dueCards[state.cardIndex];
      if (!card) return;
      var rating = Number(btn.getAttribute("data-rating"));
      document.querySelectorAll("[data-rating]").forEach(function (b) { b.disabled = true; });
      fetchJson(COMPANION_URL + "/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propositionId: card.propositionId, cueId: card.cueId, rating: rating })
      }, 12000)
        .then(function (res) {
          if (res && res.state) {
            state.dueCards = res.state.dueCards || [];
            state.totalDue = res.state.totalDue || 0;
            state.totalTracked = res.state.totalTracked || 0;
            state.examPrep = res.state.examPrep || state.examPrep;
            state.recentSessions = res.state.recentSessions || state.recentSessions;
            if (rating === 1) state.cardIndex = (state.cardIndex + 1) % Math.max(1, state.dueCards.length);
            else state.cardIndex = 0;
            renderCards();
            renderExamAndSessions();
          }
        })
        .catch(function (err) {
          showErrorBox("cards-error", "Rating failed: " + err.message, loadCompanionState);
        })
        .finally(function () {
          document.querySelectorAll("[data-rating]").forEach(function (b) { b.disabled = false; });
        });
    });
  });

  document.querySelectorAll("[data-mode]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      updateExamPrep({ mode: btn.getAttribute("data-mode") });
    });
  });

  document.querySelectorAll("[data-pace]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      updateExamPrep({ pace: btn.getAttribute("data-pace") });
    });
  });

  document.querySelectorAll("[data-new-mode]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.newSessionMode = btn.getAttribute("data-new-mode") || "teach";
      document.querySelectorAll("[data-new-mode]").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  byId("btn-start-session").addEventListener("click", function () {
    if (hasUploadingAttachments("new")) {
      showErrorBox("companion-error", "Please wait for attachments to finish uploading.", function () { showErrorBox("companion-error", ""); });
      return;
    }
    var prompt = byId("new-session-prompt").value.trim();
    var paths = readyAttachmentPaths("new");
    if (!prompt && !paths.length) {
      byId("new-session-prompt").focus();
      return;
    }
    startNewSession({
      mode: state.newSessionMode,
      prompt: prompt,
      attachmentPaths: paths,
      drill: false,
      btn: byId("btn-start-session")
    });
  });

  byId("btn-drill-weak").addEventListener("click", function () {
    startNewSession({ mode: "practice", drill: true, btn: byId("btn-drill-weak") });
  });

  byId("reader-back").addEventListener("click", function () {
    stopPolling();
    state.activeSession = null;
    state.readerAttachments = [];
    renderAttachmentChips("reader");
    byId("session-reader").classList.add("hidden");
    byId("exam-home").classList.remove("hidden");
    loadCompanionState();
  });

  byId("reader-toggle-notes").addEventListener("click", function () {
    byId("reader-notes-box").classList.toggle("hidden");
  });

  byId("reader-save-note").addEventListener("click", function () {
    sendMobileSessionAction({ note: byId("reader-notes").value }, byId("reader-save-note"));
  });

  byId("reader-send-reply").addEventListener("click", function () {
    if (hasUploadingAttachments("reader")) {
      byId("reader-status").textContent = "Waiting for attachment upload to finish...";
      return;
    }
    var txt = byId("reader-reply").value.trim();
    var paths = readyAttachmentPaths("reader");
    if (!txt && !state.selectedOptions.length && !paths.length) return;
    sendMobileSessionAction({
      replyText: txt || undefined,
      attachmentPaths: paths.length ? paths : undefined,
      selectedValues: state.selectedOptions.length ? state.selectedOptions : undefined
    }, byId("reader-send-reply"));
  });

  byId("reader-submit-opts").addEventListener("click", function () {
    if (!state.selectedOptions.length || hasUploadingAttachments("reader")) return;
    var paths = readyAttachmentPaths("reader");
    sendMobileSessionAction({
      selectedValues: state.selectedOptions,
      replyText: byId("reader-reply").value.trim() || undefined,
      attachmentPaths: paths.length ? paths : undefined
    }, byId("reader-submit-opts"));
  });

  byId("reader-dont-know").addEventListener("click", function () {
    if (hasUploadingAttachments("reader")) return;
    var paths = readyAttachmentPaths("reader");
    sendMobileSessionAction({
      dontKnow: true,
      replyText: byId("reader-reply").value.trim() || undefined,
      attachmentPaths: paths.length ? paths : undefined
    }, byId("reader-dont-know"));
  });

  byId("cards-refresh").addEventListener("click", loadCompanionState);
  byId("exam-refresh").addEventListener("click", loadCompanionState);
  byId("mob-meals-ok").addEventListener("click", function () {
    var pl = state.planner;
    if (!pl) return;
    checkInMobilePlanner({ date: pl.date, mealsOk: !(pl.todayLog && pl.todayLog.mealsOk) });
  });
  byId("mob-hobby-ok").addEventListener("click", function () {
    var pl = state.planner;
    if (!pl) return;
    checkInMobilePlanner({ date: pl.date, hobbyDone: !(pl.todayLog && pl.todayLog.hobbyDone) });
  });
  var mobBedtime = byId("mob-bedtime");
  if (mobBedtime) {
    mobBedtime.addEventListener("change", function () {
      var pl = state.planner;
      if (!pl || !mobBedtime.value) return;
      checkInMobilePlanner({ date: pl.date, actualBedtime: mobBedtime.value });
    });
  }
  Array.prototype.slice.call(document.querySelectorAll("#mob-energy-strip [data-energy]")).forEach(function (btn) {
    btn.addEventListener("click", function () {
      var pl = state.planner;
      var score = Number(btn.getAttribute("data-energy"));
      if (!pl || !score) return;
      checkInMobilePlanner({ date: pl.date, energyScore: score });
    });
  });

  var cam = byId("cam");
  var lib = byId("lib");
  var hd = byId("hd");
  var list = byId("upload-list");
  var pending = [];
  var inFlight = 0;

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function addRow(name) {
    var row = document.createElement("div");
    row.className = "item";
    row.innerHTML = "<div class='status-line'><span class='name'></span><span class='state muted mono' style='font-size:11px'>Preparing...</span></div>";
    row.querySelector(".name").textContent = name || "Photo";
    list.prepend(row);
    return { row: row, stateEl: row.querySelector(".state") };
  }

  function normalizeImage(file) {
    var highDetail = Boolean(hd && hd.checked);
    var maxDim = highDetail ? 2400 : 1600;
    var quality = highDetail ? 0.88 : 0.78;
    var pBitmap = (typeof createImageBitmap === "function")
      ? createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () { return createImageBitmap(file); }).catch(function () { return null; })
      : Promise.resolve(null);

    return pBitmap.then(function (bitmap) {
      var width = bitmap ? bitmap.width : 0;
      var height = bitmap ? bitmap.height : 0;
      var pSource = bitmap
        ? Promise.resolve({ source: bitmap, closeBitmap: true })
        : new Promise(function (resolve) {
            var objUrl = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
              width = img.naturalWidth || 0;
              height = img.naturalHeight || 0;
              URL.revokeObjectURL(objUrl);
              resolve({ source: img, closeBitmap: false });
            };
            img.onerror = function () {
              URL.revokeObjectURL(objUrl);
              resolve(null);
            };
            img.src = objUrl;
          });

      return pSource.then(function (loaded) {
        if (!loaded || !width || !height) return file;
        var scale = Math.max(width, height) > maxDim ? maxDim / Math.max(width, height) : 1;
        var w = Math.max(1, Math.round(width * scale));
        var h = Math.max(1, Math.round(height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        if (!ctx) {
          if (loaded.closeBitmap && typeof loaded.source.close === "function") loaded.source.close();
          return file;
        }
        ctx.drawImage(loaded.source, 0, 0, w, h);
        if (loaded.closeBitmap && typeof loaded.source.close === "function") loaded.source.close();
        return new Promise(function (resolve) {
          canvas.toBlob(function (blob) { resolve(blob || file); }, "image/jpeg", quality);
        });
      });
    });
  }

  function sendBinaryUpload(url, payload, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.timeout = 60000;
      xhr.setRequestHeader("Content-Type", payload.type || "application/octet-stream");
      xhr.upload.onprogress = function (ev) {
        if (ev.lengthComputable && ev.total > 0) {
          onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
        }
      };
      xhr.onload = function () {
        var json = {};
        try { json = JSON.parse(xhr.responseText || "{}"); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(json);
        else reject(new Error(json.error || ("HTTP " + xhr.status)));
      };
      xhr.onerror = function () { reject(new Error("Network error")); };
      xhr.ontimeout = function () { reject(new Error("Upload timed out")); };
      xhr.send(payload);
    });
  }

  function attachmentBucket(scope) {
    return scope === "new" ? state.newAttachments : state.readerAttachments;
  }

  function readyAttachmentPaths(scope) {
    return attachmentBucket(scope).filter(function (a) { return !!a.path && !a.error; }).map(function (a) { return a.path; });
  }

  function hasUploadingAttachments(scope) {
    return attachmentBucket(scope).some(function (a) { return !!a.uploading; });
  }

  function isImageAttachment(file) {
    var mime = (file && file.type ? file.type : "").toLowerCase();
    var name = file && file.name ? file.name : "";
    return mime.indexOf("image/") === 0 || /\\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name);
  }

  function renderAttachmentChips(scope) {
    var strip = byId(scope === "new" ? "new-attachments" : "reader-attachments");
    if (!strip) return;
    var items = attachmentBucket(scope);
    strip.innerHTML = "";
    strip.classList.toggle("hidden", items.length === 0);
    items.forEach(function (item) {
      var chip = document.createElement("span");
      chip.className = "attach-chip" + (item.uploading ? " uploading" : item.error ? " error" : "");
      var label = item.name || "attachment";
      if (item.uploading && item.stateText) label += " · " + item.stateText;
      else if (item.error) label += " (" + item.error + ")";
      chip.innerHTML = "<span class='attach-chip-name'></span><button type='button' class='attach-chip-x' aria-label='Remove'>&times;</button>";
      chip.querySelector(".attach-chip-name").textContent = label;
      chip.querySelector(".attach-chip-x").addEventListener("click", function () {
        var bucket = attachmentBucket(scope);
        var idx = bucket.indexOf(item);
        if (idx >= 0) {
          bucket.splice(idx, 1);
          renderAttachmentChips(scope);
        }
      });
      strip.appendChild(chip);
    });
  }

  function uploadChatAttachment(scope, file) {
    var bucket = attachmentBucket(scope);
    var item = { id: ++state.attachmentSeq, name: file.name || "attachment", path: null, uploading: true, error: null, stateText: "Preparing..." };
    bucket.push(item);
    renderAttachmentChips(scope);

    var prep = isImageAttachment(file) ? normalizeImage(file) : Promise.resolve(file);
    prep.then(function (payload) {
      var sizeLabel = formatBytes(payload.size);
      item.stateText = sizeLabel;
      renderAttachmentChips(scope);
      var url = COMPANION_URL + "/upload?name=" + encodeURIComponent(file.name || "attachment") + "&mime=" + encodeURIComponent(payload.type || file.type || "application/octet-stream");
      return sendBinaryUpload(url, payload, function (pct) {
        item.stateText = pct + "%";
        renderAttachmentChips(scope);
      });
    }).then(function (json) {
      item.uploading = false;
      item.path = json && json.path ? json.path : null;
      if (!item.path) item.error = "Missing path";
      renderAttachmentChips(scope);
    }).catch(function (err) {
      item.uploading = false;
      item.error = err && err.message ? err.message : "Failed";
      renderAttachmentChips(scope);
    });
  }

  function handleChatAttachSelect(scope, input) {
    var files = Array.from(input.files || []);
    input.value = "";
    for (var i = 0; i < files.length; i++) {
      uploadChatAttachment(scope, files[i]);
    }
  }

  function uploadOne(file, entry) {
    return normalizeImage(file)
      .then(function (payload) {
        var sizeLabel = formatBytes(payload.size);
        var t0 = Date.now();
        entry.stateEl.textContent = "Uploading " + sizeLabel + "...";
        entry.stateEl.className = "state muted mono";
        return sendBinaryUpload(UPLOAD_URL, payload, function (pct) {
          entry.stateEl.textContent = pct >= 99
            ? ("Saving " + sizeLabel + "...")
            : ("Uploading " + sizeLabel + " · " + pct + "%");
        }).then(function () {
          var sec = Math.max(0.1, (Date.now() - t0) / 1000).toFixed(1);
          entry.stateEl.className = "state ok mono";
          entry.stateEl.textContent = "Sent (" + sizeLabel + " · " + sec + "s)";
        });
      })
      .catch(function (err) {
        entry.stateEl.className = "state err mono";
        entry.stateEl.textContent = err && err.message ? err.message : "Failed";
      });
  }

  function drainQueue() {
    while (inFlight < CONCURRENCY && pending.length > 0) {
      var job = pending.shift();
      inFlight++;
      uploadOne(job.file, job.entry).finally(function () {
        inFlight--;
        drainQueue();
      });
    }
  }

  function handleSelect(input) {
    var files = Array.from(input.files || []);
    input.value = "";
    for (var i = 0; i < files.length; i++) {
      pending.push({ file: files[i], entry: addRow(files[i].name) });
    }
    drainQueue();
  }

  cam.addEventListener("change", function () { handleSelect(cam); });
  lib.addEventListener("change", function () { handleSelect(lib); });
  byId("new-cam").addEventListener("change", function () { handleChatAttachSelect("new", byId("new-cam")); });
  byId("new-file").addEventListener("change", function () { handleChatAttachSelect("new", byId("new-file")); });
  byId("reader-cam").addEventListener("change", function () { handleChatAttachSelect("reader", byId("reader-cam")); });
  byId("reader-file").addEventListener("change", function () { handleChatAttachSelect("reader", byId("reader-file")); });

  loadCompanionState();
})();
</script>
</body>
</html>`;
}
