import { NextResponse } from "next/server";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { FORK_UPDATE_MESSAGE } from "@/lib/fork";
import type { UpdateStatus } from "./types";
import packageMetadata from "../../../../../package.json";

export async function authorizeAdminRequest(request: Request) {
  const env = getEnv();
  let user: Awaited<ReturnType<typeof requireUser>>;

  try {
    user = await requireUser(env, request);
  } catch {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  try {
    assertPrimaryAdmin(user);
  } catch {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { env };
}


export async function getUpdateStatus(env: CloudflareEnv): Promise<UpdateStatus> {
  void env; // No GitHub token or external version check is required.
  return {
    available: false,
    configured: true,
    configuration: [],
    currentVersion: packageMetadata.version,
    repository: "AgentWailer/mailflare",
    manualOnly: true,
  };
}

/** Never dispatch the upstream workflow: it replaces the entire tracked tree. */
export async function dispatchUpdateWorkflow(): Promise<never> {
  throw new Error(FORK_UPDATE_MESSAGE);
}
