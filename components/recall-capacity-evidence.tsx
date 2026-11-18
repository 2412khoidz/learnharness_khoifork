import type { RecallCapacityProfile, RecallRate } from "@/src/core";

const pct = (value: number) => `${Math.round(value * 100)}%`;
const rates = (value: RecallRate) => `${pct(value.full)} full · ${pct(value.atLeastPartial)} at least partial`;
const span = ([low, high]: [number, number]) => `${pct(low)}–${pct(high)}`;

export function RecallCapacityEvidence({ evidence }: { evidence: RecallCapacityProfile }) {
	if (!evidence.responses) return null;
	return <details className="min-w-44">
		<summary className="cursor-pointer">{evidence.estimate ? rates(evidence.estimate) : "No eligible weighted evidence"}</summary>
		<div className="mt-1 space-y-1 text-xs text-muted-foreground">
			<p>{evidence.raw ? `Observed: ${rates(evidence.raw)} on ${evidence.graded} graded answers.` : "No answers with a definite grade."} {evidence.uncertain} uncertain.</p>
			<p>{evidence.usable} scored answers across {evidence.days} days · evidence weight {evidence.weighted.toFixed(1)}.</p>
			<p>{evidence.provisional} provisional AI ({evidence.graded ? pct(evidence.provisional / evidence.graded) : "0%"}) · {evidence.confirmed} learner-confirmed · {evidence.assisted} assisted · {evidence.helpUnknown} help unknown.</p>
			<p>{evidence.confirmedEstimate ? `Confirmed only: ${rates(evidence.confirmedEstimate)}.` : "No eligible learner-confirmed answers."}</p>
			{evidence.leaveOneDayOut && <p>Without one day at a time: {span(evidence.leaveOneDayOut.full)} full · {span(evidence.leaveOneDayOut.atLeastPartial)} at least partial.</p>}
			{(evidence.overlapExcluded > 0 || evidence.overlapUnknown > 0) && <p>{evidence.overlapExcluded} already used in Quiz, Mistakes or FSRS · {evidence.overlapUnknown} without a source link to check.</p>}
		</div>
	</details>;
}
