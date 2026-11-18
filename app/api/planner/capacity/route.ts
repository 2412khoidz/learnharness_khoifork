import type { ModelRole } from "@/config";
import {
	applyCapacityCalibration,
	CapacityCalibrationConflict,
	diagnoseLearningCapacityWithAiServer,
	previewCapacityCalibration,
	previewLearningCapacityDiagnosisServer,
	PlannerAiUnavailable,
	readPlannerLearningCapacityServer,
	recallAuditActivity,
	recallGroupingActivity,
	runCapacityExperiments,
	undoCapacityCalibration,
} from "@/src/server";

const ALLOWED_ROLES = new Set<string>(["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"]);

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const date = searchParams.get("date") ?? undefined;
	if (searchParams.get("activity") === "1") {
		return Response.json({ audit: recallAuditActivity(), groups: recallGroupingActivity() }, { headers: { "Cache-Control": "no-store" } });
	}
	const { recallSources: _recallSources, ...capacity } = readPlannerLearningCapacityServer({ date });
	void _recallSources;
	return Response.json(capacity, {
		headers: { "Cache-Control": "no-store" },
	});
}

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	try {
		const raw = (await request.json()) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const action = typeof body.action === "string" ? body.action : "";
	const date = typeof body.date === "string" ? body.date : undefined;
	const preferredRole =
		typeof body.preferredRole === "string" && ALLOWED_ROLES.has(body.preferredRole)
			? (body.preferredRole as ModelRole)
			: undefined;

	if (action === "preview_calibration" || action === "apply_calibration" || action === "undo_calibration" || action === "run_local_experiments") {
		const headers = { "Cache-Control": "no-store" };
		try {
			if (action === "preview_calibration") return Response.json(previewCapacityCalibration({ date }), { headers });
			if (action === "run_local_experiments") return Response.json(runCapacityExperiments(date), { headers });
			if (action === "undo_calibration" && typeof body.undoId === "string") return Response.json(undoCapacityCalibration(body.undoId), { headers });
			if (action === "apply_calibration" && typeof body.revision === "string" && Array.isArray(body.items) &&
				body.items.length <= 50 && body.items.every((id) => typeof id === "string") && typeof body.realism === "boolean") {
				return Response.json(applyCapacityCalibration({ revision: body.revision, items: body.items, realism: body.realism }, { date }), { headers });
			}
			return Response.json({ error: "Invalid calibration selection." }, { status: 400, headers });
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : "Calibration failed." }, {
				status: error instanceof CapacityCalibrationConflict ? 409 : 400, headers,
			});
		}
	}

	if (action === "preview_diagnosis" || action === "diagnose_ai") {
		try {
			if (action === "preview_diagnosis") return Response.json(previewLearningCapacityDiagnosisServer({ date, preferredRole }), { headers: { "Cache-Control": "no-store" } });
			if (typeof body.revision !== "string") return Response.json({ error: "Preview the AI request before sending." }, { status: 400 });
			const res = await diagnoseLearningCapacityWithAiServer({
				date,
				preferredRole,
				signal: request.signal,
				previewRevision: body.revision,
			});
			return Response.json(res, { headers: { "Cache-Control": "no-store" } });
		} catch (err) {
			if (err instanceof PlannerAiUnavailable) {
				return Response.json({ error: err.message }, { status: 503 });
			}
			return Response.json(
				{ error: err instanceof Error ? err.message : "Failed to run cognitive diagnosis" },
				{ status: 502 },
			);
		}
	}

	return Response.json({ error: "Choose an available action. Workload changes require a current calibration preview." }, { status: 400 });
}
