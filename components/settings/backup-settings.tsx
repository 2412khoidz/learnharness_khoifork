"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

interface BackupRestoreResponse {
	ok?: boolean;
	restoredFiles?: number;
	summary?: {
		nodesCount: number;
		chainsCount: number;
		chatsCount: number;
		flashcardsPropositionsCount: number;
		flashcardsReviewsCount: number;
	};
	error?: string;
}

export function BackupSettings() {
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [busy, setBusy] = useState(false);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const handleExport = async () => {
		setBusy(true);
		setStatusMessage(null);
		setErrorMessage(null);
		try {
			const res = await fetch("/api/backup", { cache: "no-store" });
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(err.error ?? `HTTP ${res.status}`);
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `kronoharness-backup-${new Date().toISOString().slice(0, 10)}.json`;
			document.body.append(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
			setStatusMessage("Snapshot backup downloaded (API keys excluded for safety).");
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to export backup");
		} finally {
			setBusy(false);
		}
	};

	const handleRestoreFile = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;

		setBusy(true);
		setStatusMessage(null);
		setErrorMessage(null);
		try {
			const text = await file.text();
			const parsed = JSON.parse(text) as unknown;
			const res = await fetch("/api/backup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(parsed),
			});
			const data = (await res.json().catch(() => ({}))) as BackupRestoreResponse;
			if (!res.ok || !data.ok) {
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const s = data.summary;
			setStatusMessage(
				s
					? `Restored ${data.restoredFiles ?? 0} files (${s.nodesCount} nodes, ${s.chatsCount} sessions, ${s.flashcardsPropositionsCount} card propositions). Reload app to refresh views.`
					: `Restored ${data.restoredFiles ?? 0} files. Reload app to refresh views.`,
			);
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to restore backup");
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsGroup label="Backup & Restore" testid="group-backup">
			<SettingsRow
				label="Export learning snapshot"
				hint="Download knowledge graph, chat history, FSRS-6 flashcards, and exam settings into one portable file. API keys are never exported."
				testid="row-backup-export"
			>
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy}
					data-testid="backup-export-btn"
					onClick={() => void handleExport()}
				>
					<DownloadIcon className="mr-1.5 size-3.5" aria-hidden />
					Export snapshot
				</Button>
			</SettingsRow>
			<SettingsRow
				label="Restore from snapshot"
				hint="Import a .json snapshot exported from ChronoHarness. Existing learning records matching files in the archive are overwritten."
				testid="row-backup-import"
			>
				<input
					ref={fileInputRef}
					type="file"
					accept=".json,application/json"
					className="hidden"
					data-testid="backup-import-input"
					onChange={(e) => void handleRestoreFile(e)}
				/>
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy}
					data-testid="backup-import-btn"
					onClick={() => fileInputRef.current?.click()}
				>
					<UploadIcon className="mr-1.5 size-3.5" aria-hidden />
					Restore snapshot
				</Button>
			</SettingsRow>
			{statusMessage && (
				<p role="status" data-testid="backup-status" className="text-xs text-emerald-600 dark:text-emerald-400">
					{statusMessage}
				</p>
			)}
			{errorMessage && (
				<p role="alert" data-testid="backup-error" className="text-xs text-error">
					{errorMessage}
				</p>
			)}
		</SettingsGroup>
	);
}
