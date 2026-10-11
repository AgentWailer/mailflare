"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, MoreHorizontal, Trash2 } from "lucide-react";
import { useLanguage } from "./language-provider";
import { MessageActionMenuContent } from "./messages/message-action-menu-content";
import type { ReorderableItemActions } from "./reorderable-list-types";

export function LabelActions({ name, actions, canDelete, onDelete }: {
	name: string;
	actions: ReorderableItemActions;
	canDelete: boolean;
	onDelete: () => void;
}) {
	const { t } = useLanguage();
	const itemClass = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm";
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button type="button" aria-label={t("labels.actions", { name })}
					className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-200/60 max-md:h-11 max-md:w-11">
					<MoreHorizontal className="h-4 w-4" />
				</button>
			</DropdownMenu.Trigger>
			<MessageActionMenuContent>
				<DropdownMenu.Item className={itemClass} disabled={!actions.canMoveUp} onSelect={actions.moveUp}>
					<ArrowUp className="h-4 w-4" />{t("labels.moveUp")}
				</DropdownMenu.Item>
				<DropdownMenu.Item className={itemClass} disabled={!actions.canMoveDown} onSelect={actions.moveDown}>
					<ArrowDown className="h-4 w-4" />{t("labels.moveDown")}
				</DropdownMenu.Item>
				{canDelete && <>
					<DropdownMenu.Separator className="my-1 border-t border-neutral-200" />
					<DropdownMenu.Item className={`${itemClass} text-red-600`} onSelect={onDelete}>
						<Trash2 className="h-4 w-4" />{t("labels.delete")}
					</DropdownMenu.Item>
				</>}
			</MessageActionMenuContent>
		</DropdownMenu.Root>
	);
}
