"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarIcon, GraduationCapIcon, SparklesIcon } from "lucide-react";
import type { ExamPrepConfig, ExamPrepStatus, StudyMode, StudyPace } from "@/src/core";

const PACE_LABELS: ReadonlyArray<{ id: StudyPace; label: string; hint: string }> = [
	{ id: "thorough", label: "Thorough", hint: "Full proofs & deep understanding" },
	{ id: "efficient", label: "Efficient", hint: "Focused core proofs & due concepts" },
	{ id: "crash-course", label: "Crash", hint: "High-yield exam tactics & speed" },
];

export function ExamPrepSidebarCard() {
	const router = useRouter();
	const [status, setStatus] = useState<ExamPrepStatus | null>(null);
	const [editing, setEditing] = useState(false);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftDate, setDraftDate] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(() => {
		if (typeof fetch !== "function") return;
		fetch("/api/exam-prep", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<ExamPrepStatus>) : null))
			.then((data) => {
				if (!data) return;
				setStatus(data);
				setDraftTitle(data.config.examTitle);
				setDraftDate(data.config.examDate ?? "");
			})
			.catch(() => {
				/* ignore when offline or during test mocks */
			});
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const patchConfig = async (patch: Partial<ExamPrepConfig>) => {
		setSaving(true);
		try {
			const res = await fetch("/api/exam-prep", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (res.ok) {
				const data = (await res.json()) as ExamPrepStatus;
				setStatus(data);
				setDraftTitle(data.config.examTitle);
				setDraftDate(data.config.examDate ?? "");
			}
		} catch {
			/* best-effort update */
		} finally {
			setSaving(false);
		}
	};

	const mode: StudyMode = status?.config.mode ?? "long-term";
	const pace: StudyPace = status?.config.pace ?? "thorough";
	const readiness = status?.examReadinessPct ?? 0;
	const days = status?.daysRemaining ?? null;

	const countdownText =
		days === null
			? null
			: days > 0
				? `D-${days}`
				: days === 0
					? "Today"
					: `+${Math.abs(days)}d`;

	return (
		<div
			data-testid="kronoharness-exam-card"
			className="mx-3 mb-2 rounded-lg border bg-background/50 p-2 text-[11px] text-foreground"
		>
			<div className="flex items-center justify-between gap-1.5">
				<span className="inline-flex items-center gap-1 font-medium tracking-tight text-foreground">
					{mode === "exam" ? (
						<GraduationCapIcon className="size-3.5 text-amber-500" />
					) : (
						<SparklesIcon className="size-3.5 text-emerald-500" />
					)}
					<span>KronoHarness</span>
				</span>
				<span className="tabular-nums text-[10px] text-muted-foreground" title="Weighted FSRS-6 Exam Readiness">
					Readiness {readiness}%
				</span>
			</div>

			<div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full transition-all duration-300 ${
						readiness >= 80 ? "bg-emerald-500" : readiness >= 55 ? "bg-amber-500" : "bg-rose-500"
					}`}
					style={{ width: `${Math.min(100, Math.max(4, readiness))}%` }}
				/>
			</div>

			<div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-0.5">
				<button
					type="button"
					disabled={saving}
					onClick={() => void patchConfig({ mode: "long-term" })}
					className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
						mode === "long-term"
							? "bg-background text-foreground shadow-xs"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					Long-Term
				</button>
				<button
					type="button"
					disabled={saving}
					onClick={() => void patchConfig({ mode: "exam" })}
					className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
						mode === "exam"
							? "bg-background text-foreground shadow-xs"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					Exam Prep
				</button>
			</div>

			<div className="mt-1.5 flex items-center gap-1">
				{PACE_LABELS.map((item) => (
					<button
						key={item.id}
						type="button"
						disabled={saving}
						title={item.hint}
						onClick={() => void patchConfig({ pace: item.id })}
						className={`flex-1 rounded border px-1 py-0.5 text-[10px] transition-colors ${
							pace === item.id
								? "border-foreground/40 bg-accent font-medium text-foreground"
								: "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
						}`}
					>
						{item.label}
					</button>
				))}
			</div>

			{mode === "exam" && (
				<div className="mt-1.5 border-t pt-1.5">
					<div className="flex items-center justify-between gap-1.5">
						<button
							type="button"
							onClick={() => setEditing((v) => !v)}
							className="inline-flex min-w-0 items-center gap-1 truncate text-[10px] text-muted-foreground hover:text-foreground"
							title="Set exam title & countdown date"
						>
							<CalendarIcon className="size-3 shrink-0" />
							<span className="truncate">
								{status?.config.examTitle || "Set exam details"}
							</span>
						</button>
						<div className="flex shrink-0 items-center gap-1">
							{countdownText && (
								<span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-400">
									{countdownText}
								</span>
							)}
							<button
								type="button"
								onClick={() => router.push("/chat/new?mode=practice")}
								className="rounded border px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent"
								title="Start targeted Practice with Exam Prep mode"
							>
								Drill
							</button>
						</div>
					</div>
					{editing && (
						<div className="mt-1.5 flex flex-col gap-1">
							<input
								type="text"
								value={draftTitle}
								onChange={(e) => setDraftTitle(e.target.value)}
								placeholder="Exam title (e.g. Finals)"
								className="h-6 rounded border bg-background px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
							/>
							<div className="flex items-center gap-1">
								<input
									type="date"
									value={draftDate}
									onChange={(e) => setDraftDate(e.target.value)}
									className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-[10px] outline-none focus:ring-1 focus:ring-ring"
								/>
								<button
									type="button"
									disabled={saving}
									onClick={() => {
										void patchConfig({
											examTitle: draftTitle,
											examDate: draftDate || null,
										});
										setEditing(false);
									}}
									className="h-6 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground"
								>
									Save
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
