"use client";

import { useState } from "react";
import type { ExamTimetableEntry } from "@/src/core";

type Draft = Omit<ExamTimetableEntry, "id">;
const empty: Draft = { title: "" };
const fields: Array<{ key: keyof Draft; label: string; type?: string }> = [
	{ key: "title", label: "Subject / exam" }, { key: "courseCode", label: "Course code" },
	{ key: "date", label: "Exam date", type: "date" }, { key: "startTime", label: "Start time", type: "time" },
	{ key: "endTime", label: "End time", type: "time" }, { key: "location", label: "Room / location" },
	{ key: "examType", label: "Exam type" }, { key: "format", label: "Format" },
	{ key: "session", label: "Session" }, { key: "seat", label: "Candidate number" }, { key: "notes", label: "Notes" },
];

export function PlannerExamTimetable({ entries, busy, onSave }: { entries: ExamTimetableEntry[]; busy: boolean; onSave: (entries: ExamTimetableEntry[]) => Promise<boolean> }) {
	const [draft, setDraft] = useState<Draft>(empty);
	const [editing, setEditing] = useState<string | null>(null);
	const [error, setError] = useState("");
	const save = async () => {
		if (!draft.title.trim()) { setError("Enter a subject or exam name."); return; }
		if (draft.endTime && (!draft.startTime || draft.endTime <= draft.startTime)) { setError("End time must be after start time."); return; }
		const entry = { ...draft, id: editing ?? crypto.randomUUID(), title: draft.title.trim() };
		if (await onSave(editing ? entries.map((item) => item.id === editing ? entry : item) : [...entries, entry])) {
			setDraft(empty); setEditing(null); setError("");
		}
	};
	return <section className="grid gap-4 lg:grid-cols-2 text-xs">
		<div className="rounded-xl border bg-card p-4">
			<h3 className="text-sm font-medium">{editing ? "Edit exam" : "Add exam"}</h3>
			<p className="mt-1 text-muted-foreground">Exam dates are stored separately and do not create exam profiles or study quotas. Leave unknown details blank.</p>
			<div className="mt-3 grid grid-cols-2 gap-2">{fields.map(({ key, label, type }) => <label key={key} className={key === "title" || key === "notes" ? "col-span-2" : ""}><span className="mb-1 block text-muted-foreground">{label}</span><input type={type ?? "text"} value={draft[key] ?? ""} onChange={(event) => setDraft((old) => ({ ...old, [key]: key === "title" ? event.target.value : event.target.value || undefined }))} className="w-full rounded-md border bg-background px-2 py-1.5" /></label>)}</div>
			{error && <p role="alert" className="mt-2 text-warning">{error}</p>}
			<div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-40">{editing ? "Save changes" : "Add exam"}</button>{editing && <button type="button" onClick={() => { setEditing(null); setDraft(empty); setError(""); }} className="rounded border px-3 py-1.5">Cancel</button>}</div>
		</div>
		<div className="space-y-2">
			<h3 className="text-sm font-medium">Exam Timetable ({entries.length})</h3>
			{entries.length === 0 && <p className="rounded-xl border border-dashed p-4 text-muted-foreground">No exams yet. Add one here or send an image to Coach.</p>}
			{entries.map((item) => <article key={item.id} className="rounded-xl border bg-card p-3"><div className="flex items-start justify-between gap-2"><div><h4 className="font-medium">{item.title}</h4><p className="mt-1 text-muted-foreground">{item.date || "Date not set"}{item.startTime ? ` · ${item.startTime}` : ""}{item.endTime ? `–${item.endTime}` : item.startTime ? " · End time not set" : ""}{item.location ? ` · ${item.location}` : ""}</p></div><div className="flex gap-2"><button type="button" disabled={busy} onClick={() => { const { id, ...values } = item; setEditing(id); setDraft(values); setError(""); }} className="rounded border px-2 py-1">Edit</button><button type="button" disabled={busy} onClick={() => void onSave(entries.filter((event) => event.id !== item.id))} className="rounded border px-2 py-1">Delete</button></div></div>{[item.courseCode, item.examType, item.format, item.session && `Session ${item.session}`, item.seat && `Candidate ${item.seat}`, item.notes].filter(Boolean).length > 0 && <p className="mt-2 text-muted-foreground">{[item.courseCode, item.examType, item.format, item.session && `Session ${item.session}`, item.seat && `Candidate ${item.seat}`, item.notes].filter(Boolean).join(" · ")}</p>}</article>)}
		</div>
	</section>;
}
