/**
 * LhMark — ChronoHarness app mark, inlined as JSX so it rides along with the
 * components (no network fetch, recolorable, crisp at any size). 806×806 viewBox,
 * no padding: sizing/padding is the consumer's job. The gray path is the
 * temporal dial arc; the hourglass frame and knowledge nexus constellation use
 * the strong line ink (white in dark, the foreground in light).
 */
export function LhMark({ className = "" }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 806 806"
			className={className}
			style={{ fillRule: "evenodd", clipRule: "evenodd", strokeLinejoin: "round", strokeMiterlimit: 2 }}
			aria-hidden="true"
		>
			{/* Outer temporal dial arc (gray harness ring) */}
			<path
				d="M 718 221 A 366 366 0 1 1 498 49 L 482 109 A 304 304 0 1 0 664 252 Z"
				style={{ fill: "rgb(148,148,148)" }}
			/>
			{/* Hourglass frame in strong line ink */}
			<path
				d="M 244 190 L 562 190 L 562 246 L 520 246 C 520 340, 448 378, 448 403 C 448 428, 520 466, 520 560 L 562 560 L 562 616 L 244 616 L 244 560 L 286 560 C 286 466, 358 428, 358 403 C 358 378, 286 340, 286 246 L 244 246 Z M 342 246 C 342 326, 396 368, 403 374 C 410 368, 464 326, 464 246 Z M 403 432 C 396 438, 342 480, 342 560 L 464 560 C 464 480, 410 438, 403 432 Z"
				style={{ fill: "var(--lh-line-strong)" }}
			/>
			{/* Central chrono-nexus & knowledge nodes in strong line ink */}
			<path
				d="M 347 403 a 56 56 0 1 0 112 0 a 56 56 0 1 0 -112 0 Z M 373 292 a 30 30 0 1 0 60 0 a 30 30 0 1 0 -60 0 Z M 373 514 a 30 30 0 1 0 60 0 a 30 30 0 1 0 -60 0 Z"
				style={{ fill: "var(--lh-line-strong)" }}
			/>
		</svg>
	);
}
