import type { BackupTableGroupId } from "@/lib/backups/types";

export type BackupScheduleType = "daily" | "weekly" | "monthly";
export type BackupStatus = "queued" | "running" | "completed" | "failed";

export type BackupSettings = {
	id: string;
	enabled: boolean;
	scheduleType: BackupScheduleType;
	scheduleValue: number | null;
	retentionEnabled: boolean;
	retentionDays: number;
	excludedTableGroups: BackupTableGroupId[];
	updatedAt: string;
};

export type BackupItem = {
	id: string;
	kind?: "database" | "rescue";
	phase?: "database" | "inventory" | "objects" | "manifest" | "publish" | "cleanup" | null;
	verifiedAt?: string | null;
	objectCount?: number;
	objectBytes?: number;
	status: BackupStatus;
	trigger: "manual" | "scheduled";
	filename: string | null;
	size: number | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};

export type BackupsResponse = {
	settings: BackupSettings;
	backups: BackupItem[];
	configuration: {
		configured: boolean;
		missing: string[];
		rescue?: boolean;
		recoveryKeyConfigured?: boolean;
	};
};
