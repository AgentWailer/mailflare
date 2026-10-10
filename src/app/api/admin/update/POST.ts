import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "./utils";
import { FORK_UPDATE_MESSAGE } from "@/lib/fork";

export async function POST(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;
	return NextResponse.json({ error: FORK_UPDATE_MESSAGE }, { status: 409 });
}
