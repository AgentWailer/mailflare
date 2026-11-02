import { authFetch } from "@/lib/auth/client";
import type { GeneralSettings } from "./types";

export async function loadGeneralSettings(): Promise<GeneralSettings> {
	const response = await authFetch("/api/admin/general", { cache: "no-store" });
	const data = await response.json();
	if (!response.ok) throw new Error((data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : undefined) ?? "Could not load general settings");
	return data as GeneralSettings;
}

export async function saveGeneralSettings(changes: Partial<GeneralSettings>): Promise<GeneralSettings> {
	const response = await authFetch("/api/admin/general", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(changes),
	});
	const data = await response.json();
	if (!response.ok) throw new Error((data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : undefined) ?? "Could not save general settings");
	return data as GeneralSettings;
}
