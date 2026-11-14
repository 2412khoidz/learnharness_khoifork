"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSettings, ModelCatalogEntry, ModelCatalogResponse, ModelsSettings, UserSettings } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";
import { composeSlotModel } from "@/components/settings/agent-section";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import { isInputShortcutScopeEligible } from "@/components/plugin-input-focus";
import { ModelPickerPill } from "@/components/model-picker-pill";
import { Hint } from "@/components/ui/hint";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { useModelCatalog } from "@/components/model-catalog";
export { useModelCatalog } from "@/components/model-catalog";
import { defaultOrderLevel, populateLevel, THINKING_LABEL } from "@/components/thinking-default";

/** provider:id → known contextWindow over the cached catalog, mirroring
 * the server's catalogContextLimits join. CLI aliases have no global
 * denominator: the stats bar uses that session's actual CLI report instead.
 * Missing limits always render usage-only, without a hardcoded fallback. */
export function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number> {
	return new Map(catalog.models.flatMap((m) => m.contextWindow === null ? [] : [[`${m.provider}:${m.id}`, m.contextWindow] as const]));
}

/**
 * THE CONVERSATION MODEL CONTROL — dual-bound (owner, per-session models,
 * 2026-09-28). WITH a chatId (the in-session stats bar): the pills bind
 * THE SESSION'S OWN record — reads GET /api/chats/:id (its settings field;
 * a legacy unstamped record falls back to the strong slot's display,
 * exactly what the engine resolves), writes PUT /api/chats/:id/settings
 * (validated + level-clamped server-side). The session owns its model +
 * thinking level from birth; the strong slot never reaches it again.
 *
 * WITHOUT a chatId (the draft surfaces — home + /chat/new): the pills
 * bind the STRONG SLOT (reads the raw models section, GET /api/settings;
 * writes PUT /api/settings/models via composeSlotModel — the same seam
 * the settings Agent section and the SetupDialog write): picking there IS
 * changing the new-session default. Unpicked reads "—" (the
 * no-factory-fallback language: the UI never presents a default model).
 */
export function ModelControl({ chatId, onModelChange }: { chatId?: string; onModelChange?: (model: string | undefined) => void }) {
	const { catalog, refresh } = useModelCatalog();
	const [models, setModels] = useState<ModelsSettings | undefined>();
	// A successful read with no settings is a legacy session; undefined
	// means no session record is known yet, not permission to inherit Strong.
	const [session, setSession] = useState<{ settings?: ChatSettings }>();
	const [open, setOpen] = useState<"model" | "thinking" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [customOpen, setCustomOpen] = useState(false);
	const [customProvider, setCustomProvider] = useState("google");
	const [customModelId, setCustomModelId] = useState("");
	const [catalogBusy, setCatalogBusy] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const interactions = useInteractionLayers();

	// The record read — BOTH mount and the cross-surface signal land
	// here (fix wave: another surface's models write re-reads into the
	// pill live; own writes also notify, and the refetch is idempotent).
	// Dual-bound: chat mode reads BOTH the session record (the source of
	// truth) and the models section (the display fallback for a legacy
	// unstamped session — exactly what the engine resolves); draft mode
	// reads the models section alone.
	const readRecord = useCallback(() => {
		if (chatId) {
			fetch(`/api/chats/${encodeURIComponent(chatId)}?only=settings`)
				.then((r) => { if (!r.ok) throw new Error(`session read failed: ${r.status}`); return r.json() as Promise<{ settings?: ChatSettings }>; })
				.then((body) => setSession({ settings: body.settings }))
				.catch(() => {
					/* same read-only posture as a models-section failure */
				});
		}
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings: { models?: ModelsSettings } | null }>)
			.then((body) => setModels(body.settings?.models ?? undefined))
			.catch(() => {
				/* the record fetch failing leaves the control read-only
				   ("—" triggers, closed menus) — same posture as a
				   catalog failure */
			});
	}, [chatId]);

	useEffect(() => {
		readRecord();
	}, [readRecord]);

	useSettingsSaved((section) => {
		if (section === "models") readRecord();
	});

	// Dual-bound truth: chat mode displays the session's own record,
	// falling back to Strong only for a successfully read legacy unstamped
	// session — EXACTLY what resolveConversationSpec runs. An unresolved or
	// failed record read must not report a provisional global preference as
	// this session's identity (including to the Send guard). Draft mode is
	// the strong slot itself.
	const strong = models?.strong;
	const override: ChatSettings | undefined = chatId
		? session ? {
				model: session.settings?.model ?? strong?.model,
				thinkingLevel: session.settings?.thinkingLevel ?? strong?.thinkingLevel,
			} : undefined
		: strong;
	const effectiveId = override?.model?.id;
	const effectiveProvider = override?.model?.provider;
	useEffect(() => {
		onModelChange?.(effectiveProvider && effectiveId ? `${effectiveProvider}:${effectiveId}` : undefined);
	}, [effectiveProvider, effectiveId, onModelChange]);
	const storedLevel = override?.thinkingLevel;
	const entry = catalog?.models.find(
		(m) => m.id === effectiveId && m.provider === effectiveProvider,
	);
	const levels = entry?.supportedLevels ?? [];
	// Legacy display (chunk 2 item 4, owner): a record with a model but no
	// stored level shows the RESOLVED level — the ordering's first supported
	// — because that is exactly what the engine build would run. Display-
	// only: the record stays unset until a fresh pick populates it.
	const effectiveLevel = storedLevel ?? (entry ? defaultOrderLevel(levels) : undefined);

	// The intuitive dropdown contract (owner, stats-control round 1): any
	// click outside the open menu — or an Esc keypress — closes it. The
	// menu's own surface keeps it open: the toggle buttons live inside the
	// container, and the menu BODY lives in a portal on document.body
	// (MenuShell) — never a container descendant, so its rows are carved
	// out via [data-lh-menu] (the settings sections' discipline; without
	// it a row's pointerdown counts as outside and eats the pick —
	// live-caught in the fix wave, broken since the MenuShell migration).
	useEffect(() => {
		if (open === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const popup = interactions.getTopLayer();
			if (popup?.kind !== "popup" || !containerRef.current?.contains(popup.anchorRef?.current ?? null) || !interactions.isElementEligible(popup.rootRef.current)) return;
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (containerRef.current && !containerRef.current.contains(t)) {
				setOpen(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, interactions]);

	// One write seam: composeSlotModel preserves the cheap/vision siblings
	// (replace-whole-section discipline) and the per-field independence of
	// model + thinkingLevel within the strong slot.
	const save = useCallback(
		async (next: ModelsSettings) => {
			setError(null);
			try {
				const res = await fetch("/api/settings/models", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? `settings rejected (${res.status})`);
					return;
				}
				// Server truth, never the request body (fix wave): a pick
				// that rides an unsupported level lands CLAMPED in the record
				// — the pill must show the stored value in this interaction.
				const stored = (
					(await res.json().catch(() => null)) as { settings?: UserSettings } | null
				)?.settings?.models;
				setModels(stored ?? next);
				setOpen(null);
				notifySettingsSaved("models");
			} catch {
				setError("Could not reach the server — try again.");
			}
		},
		[],
	);

	// The session write seam (chat mode): PUT the per-chat settings route
	// — validated + level-clamped server-side; the response is the stored
	// truth (a pick riding an unsupported level lands CLAMPED — the pill
	// shows the stored value). No notifySettingsSaved: the write touches
	// one session's record, not the slots — no other surface reads it.
	const saveChat = useCallback(
		async (next: ChatSettings) => {
			setError(null);
			try {
				const res = await fetch(`/api/chats/${chatId}/settings`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? `settings rejected (${res.status})`);
					return;
				}
				const stored = (await res.json().catch(() => null)) as { settings?: ChatSettings } | null;
				setSession({ settings: stored?.settings ?? next });
				setOpen(null);
			} catch {
				setError("Could not reach the server — try again.");
			}
		},
		[chatId],
	);

	// One apply seam over both write paths: a pick names provider + id +
	// level; chat mode writes the session's own record (any pick pins it),
	// draft mode composes the strong slot (siblings preserved,
	// replace-whole-section discipline).
	const apply = useCallback(
		(provider: string, id: string, level: ThinkingLevel | undefined) => {
			if (chatId) {
				void saveChat({ model: { provider, id }, thinkingLevel: level });
			} else {
				// composeSlotModel's empty-string convention: no level = unset.
				void save(composeSlotModel(models, "strong", provider, id, level ?? ""));
			}
		},
		[chatId, models, save, saveChat],
	);

	// Shortcut seams (keyboard wave A): ⌘K opens the model menu (the
	// universal command convention); Shift+Tab cycles the thinking level
	// up the ladder (wrapping) — the owner's replacement for browser
	// tab-focus. Both work from any focus, including mid-typing.
	useEffect(() => {
		const onOpenPicker = () => {
			if (!isInputShortcutScopeEligible(containerRef.current, interactions)) return;
			setOpen("model");
			setError(null);
			refresh(); // mid-session key changes widen the menu (cache fix)
		};
		window.addEventListener("lh:kbd-open-model-picker", onOpenPicker);
		return () => window.removeEventListener("lh:kbd-open-model-picker", onOpenPicker);
	}, [refresh, interactions]);

	useEffect(() => {
		const onCycleThinking = () => {
			if (!isInputShortcutScopeEligible(containerRef.current, interactions)) return;
			if (levels.length === 0) return;
			const idx = effectiveLevel === undefined ? -1 : levels.indexOf(effectiveLevel);
			const next = levels[(idx + 1) % levels.length];
			if (next === undefined) return;
			apply(effectiveProvider ?? "", effectiveId ?? "", next);
		};
		window.addEventListener("lh:kbd-cycle-thinking", onCycleThinking);
		return () => window.removeEventListener("lh:kbd-cycle-thinking", onCycleThinking);
	}, [levels, effectiveLevel, effectiveProvider, effectiveId, apply, interactions]);

	// Selecting a model (click and Enter share one path): keep the
	// thinking level only when the new model supports it — otherwise
	// drop it (a carry-over would 400 at the server's catalog gate).
	const pickModel = (m: ModelCatalogEntry) => {
		// Auto-populate (chunk 2, owner: "populate everywhere"): a fresh pick
		// ALWAYS writes a level — the STORED one rides as-is (the write clamps
		// server-side when the new model doesn't support it; the signal
		// re-reads and the clamped truth displays), and a record with no
		// stored level populates the ordering's level. The unset state can
		// never re-enter through this door. (The DERIVED display level never
		// rides — it belongs to the OLD model; the fresh pick's level comes
		// from the fresh model's own ladder.)
		const nextLevel = populateLevel(storedLevel, m.supportedLevels);
		apply(m.provider, m.id, nextLevel);
	};

	// Stale-while-revalidate on manual open too (⌘K covers the keyboard
	// path above): the cached list shows instantly, the fresh federation
	// swaps in when it lands.
	const openMenu = (kind: "model" | "thinking") => {
		setOpen((o) => (o === kind ? null : kind));
		setError(null);
		if (kind === "model") {
			setCustomProvider(effectiveProvider ?? catalog?.providers.find((p) => p.keyPresent)?.id ?? "google");
			refresh();
		}
	};

	const mutateCatalog = async (payload: Record<string, unknown>, onDone?: (nextCatalog: ModelCatalogResponse) => void) => {
		setCatalogBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = (await res.json().catch(() => ({}))) as ModelCatalogResponse & { error?: string };
			if (!res.ok) {
				setError(data.error ?? `Model update failed (${res.status})`);
				return;
			}
			refresh();
			onDone?.(data);
		} catch {
			setError("Could not reach the server — try again.");
		} finally {
			setCatalogBusy(false);
		}
	};

	const submitCustomModel = () => {
		const id = customModelId.trim();
		if (!id) return;
		const provider = customProvider.trim() || "google";
		void mutateCatalog({ action: "add-custom-model", provider, id }, (nextCatalog) => {
			setCustomModelId("");
			setCustomOpen(false);
			const added = nextCatalog.models?.find((m) => m.provider === provider && m.id === id);
			if (added) pickModel(added);
		});
	};

	return (
		<div ref={containerRef} className="relative flex items-center gap-1.5" data-testid="model-control">
			<Hint
				label={effectiveId ? `${effectiveProvider ? `${effectiveProvider}:` : ""}${effectiveId}` : "Model selector"}
				action="open-model-picker"
				side="bottom"
			>
				<ModelPickerPill
					data-testid="stats-model"
					onClick={() => openMenu("model")}
					aria-expanded={open === "model"}
				>{effectiveId ? prettyModel(effectiveId) : "—"}</ModelPickerPill>
			</Hint>
			<Hint
				// "Thinking" + its real shortcut via the registry (owner interlude
				// 2026-09-25): ⇧⇥ cycles the level, so "Thinking (⇧⇥)" —
				// rebind-live like every Hint suffix.
				label="Thinking"
				action="cycle-thinking"
				side="bottom"
			>
				<ModelPickerPill
					data-testid="stats-thinking"
					onClick={() => {
						if (entry === undefined) return;
						openMenu("thinking");
					}}
					aria-expanded={open === "thinking"}
				>{effectiveLevel === undefined ? "—" : (THINKING_LABEL[effectiveLevel] ?? effectiveLevel)}</ModelPickerPill>
			</Hint>

			{/* The shared dropdown body (extracted 2026-09-20): the agent
			    settings' slot selects and the setup dialog use the exact same
			    one. */}
			{open === "model" && (
				<MenuShell
					anchorRef={containerRef}
					testid="model-menu" onClose={() => { setOpen(null); return "closed"; }}
					preferredSide="up"
					menuClass="flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					<ModelMenuList
						models={catalog?.models}
						effectiveId={effectiveId}
						effectiveProvider={effectiveProvider}
						onPick={pickModel}
						footer={
							catalog && catalog.models.length === 0
								? "No models — add a provider key in Keys"
								: chatId
									? "This session's model"
									: "Strong tier — the default for new sessions"
						}
					/>
					<div className="mt-1.5 border-t pt-1.5 flex flex-col gap-1.5">
						<div className="flex items-center justify-between gap-2 px-1">
							<button
								type="button"
								data-testid="toggle-custom-model"
								onClick={() => {
									setCustomOpen((v) => !v);
									setCustomProvider((p) => p || effectiveProvider || catalog?.providers.find((x) => x.keyPresent)?.id || "google");
								}}
								className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
							>
								{customOpen ? "Cancel custom ID" : "+ Add model ID"}
							</button>
							{effectiveProvider && (
								<button
									type="button"
									data-testid="pause-active-provider"
									disabled={catalogBusy}
									onClick={() => void mutateCatalog({ action: "toggle-pause-provider", provider: effectiveProvider, paused: true })}
									className="text-[11px] text-muted-foreground hover:text-amber-500 transition-colors"
									title={`Hide ${effectiveProvider} models without deleting credentials`}
								>
									Pause {effectiveProvider}
								</button>
							)}
						</div>
						{customOpen && (
							<div
								className="flex items-center gap-1 px-1"
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") {
										e.preventDefault();
										submitCustomModel();
									}
								}}
							>
								<select
									aria-label="Provider"
									value={customProvider}
									onChange={(e) => setCustomProvider(e.target.value)}
									className="h-7 rounded border bg-background px-1.5 text-[11px] text-foreground"
								>
									{(catalog?.providers.length ? catalog.providers.map((p) => p.id) : ["google", "google-vertex", "openai", "anthropic", "openrouter"]).map((pid) => (
										<option key={pid} value={pid}>{pid}</option>
									))}
								</select>
								<input
									type="text"
									value={customModelId}
									onChange={(e) => setCustomModelId(e.target.value)}
									placeholder="e.g. gemini-4-carbon"
									className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
								/>
								<button
									type="button"
									disabled={catalogBusy || !customModelId.trim()}
									onClick={submitCustomModel}
									className="h-7 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
								>
									Add
								</button>
							</div>
						)}
						{(catalog?.pausedProviders?.length ?? 0) > 0 && (
							<div className="flex flex-wrap items-center gap-1 px-1 text-[10px] text-muted-foreground">
								<span>Paused:</span>
								{catalog!.pausedProviders!.map((pid) => (
									<button
										key={pid}
										type="button"
										disabled={catalogBusy}
										onClick={() => void mutateCatalog({ action: "toggle-pause-provider", provider: pid, paused: false })}
										className="rounded border px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
										title={`Resume ${pid}`}
									>
										{pid} ↺
									</button>
								))}
							</div>
						)}
					</div>
				</MenuShell>
			)}

			{open === "thinking" && (
				<MenuShell
					anchorRef={containerRef}
					testid="thinking-menu" onClose={() => { setOpen(null); return "closed"; }}
					preferredSide="up"
					menuClass="flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<ThinkingMenuList
						levels={catalog ? levels : []}
						effectiveLevel={effectiveLevel}
						onPick={(level) => apply(effectiveProvider ?? "", effectiveId ?? "", level as ThinkingLevel)}
						empty={catalog ? (effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first.") : "Loading…"}
						footer="Levels this model actually supports"
					/>
					{error && <div className="mt-1 text-destructive">{error}</div>}
				</MenuShell>
			)}
		</div>
	);
}