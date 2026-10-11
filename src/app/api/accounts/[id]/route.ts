import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { updateManagedAccountSchema } from "@/lib/validators";
import { requireTeamAdmin } from "../utils";
import { getAccountSeatError } from "@/lib/licenses/seats";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import type { AccountRouteParams } from "./types";
import { selectAccountById, updateAccountCredentials } from "./utils";
import { deleteUserSessions } from "@/lib/auth/session";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { deleteManagedAccount } from "./delete";

export async function GET(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const actor = access.user!;
	return NextResponse.json({
		account: {
			id: account.id,
			email: account.email,
			name: account.name,
			role: account.role,
			isPrimaryAdmin: account.isPrimaryAdmin,
			disabled: account.disabled,
			canManageMailboxes: account.canManageMailboxes,
			canManageDomains: account.canManageDomains,
			canManageUsers: account.canManageUsers,
			forwardingEmail: account.forwardingEmail,
			canForwardEmail: (await getLicenseEntitlements(access.env)).canForwardEmail,
			hasAvatar: !!account.avatarKey,
			editable: isPrimaryAdmin(actor) || (canManageUsers(actor) && account.role === "user" && !account.isPrimaryAdmin),
			canChangeRole: isPrimaryAdmin(actor),
			canTransferPrimary: isPrimaryAdmin(actor) && !account.isPrimaryAdmin && !account.disabled,
			deletable: account.id !== actor.id && !account.isPrimaryAdmin
				&& (isPrimaryAdmin(actor) || (canManageUsers(actor) && account.role === "user")),
		},
	});
}

export async function PATCH(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const db = getDb(access.env);
	const account = await selectAccountById(db, id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const actor = access.user!;
	const actorIsPrimary = isPrimaryAdmin(actor);
	if (!actorIsPrimary && !canManageUsers(actor)) {
		return NextResponse.json({ error: "You do not have permission to manage users" }, { status: 403 });
	}
	// Admins without the primary role can only manage plain user accounts.
	if (!actorIsPrimary && (account.role === "admin" || account.isPrimaryAdmin)) {
		return NextResponse.json({ error: "Only the primary admin can manage admin accounts" }, { status: 403 });
	}
	const parsed = updateManagedAccountSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	if (!actorIsPrimary && parsed.data.role !== account.role) {
		return NextResponse.json({ error: "Only the primary admin can change roles" }, { status: 403 });
	}
	const canForwardEmail = (await getLicenseEntitlements(access.env)).canForwardEmail;
	if (!canForwardEmail && parsed.data.forwardingEmail && parsed.data.forwardingEmail !== account.forwardingEmail) {
		return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	}
	if (account.disabled && !parsed.data.disabled) {
		const seatError = await getAccountSeatError(access.env);
		if (seatError) return NextResponse.json({ error: seatError }, { status: 403 });
	}
	await updateAccountCredentials(db, id, { name: parsed.data.name, password: parsed.data.password ?? null });
	// A password set by an admin is a reset: whoever held the old one is signed out.
	if (parsed.data.password || (parsed.data.disabled && !account.isPrimaryAdmin)) await deleteUserSessions(access.env, id);
	// The primary admin always stays an enabled admin; only a transfer can move the role.
	const role = account.isPrimaryAdmin ? "admin" : actorIsPrimary ? parsed.data.role : account.role;
	const disabled = account.isPrimaryAdmin ? false : parsed.data.disabled;
	await db.update(users).set({
		role,
		disabled,
		canManageMailboxes: parsed.data.canManageMailboxes,
		...(actorIsPrimary && parsed.data.canManageDomains !== undefined ? { canManageDomains: parsed.data.canManageDomains } : {}),
		...(actorIsPrimary && parsed.data.canManageUsers !== undefined ? { canManageUsers: parsed.data.canManageUsers } : {}),
		...(parsed.data.forwardingEmail !== undefined ? { forwardingEmail: parsed.data.forwardingEmail } : {}),
	}).where(eq(users.id, id));
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const actor = access.user!;
	if (!canManageUsers(actor)) return NextResponse.json({ error: "You do not have permission to delete accounts" }, { status: 403 });
	const { id } = await params;
	const db = getDb(access.env);
	const account = await selectAccountById(db, id);
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	if (account.isPrimaryAdmin || id === actor.id) return NextResponse.json({ error: "The primary admin and your own account cannot be deleted" }, { status: 409 });
	if (!isPrimaryAdmin(actor) && account.role === "admin") return NextResponse.json({ error: "Only the primary admin can delete admin accounts" }, { status: 403 });
	const body = await request.json().catch(() => null) as { confirmEmail?: unknown } | null;
	if (typeof body?.confirmEmail !== "string" || body.confirmEmail.trim().toLowerCase() !== account.email.toLowerCase()) {
		return NextResponse.json({ error: "Enter the account email to confirm deletion" }, { status: 400 });
	}
	const [successor] = await db.select({ id: users.id }).from(users).where(and(
		eq(users.isPrimaryAdmin, true), eq(users.role, "admin"), eq(users.disabled, false),
	)).limit(1);
	if (!successor || successor.id === id) return NextResponse.json({ error: "No enabled primary administrator is available to retain this account's assets" }, { status: 409 });
	try {
		const result = await deleteManagedAccount(access.env, { id, email: account.email, actorId: actor.id, successorId: successor.id });
		return NextResponse.json({ ok: true, ...result });
	} catch (error) {
		console.error("Account deletion failed", error);
		return NextResponse.json({ error: "The account could not be deleted. Reload its details and try again." }, { status: 409 });
	}
}
