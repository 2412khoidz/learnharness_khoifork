import { NextResponse } from "next/server";
import { readGraphFsrsSummary } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return NextResponse.json(readGraphFsrsSummary());
}
