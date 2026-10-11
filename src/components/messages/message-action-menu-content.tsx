"use client";

import type { ComponentProps } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

/** Keep message action menus inside the screen, including short mobile viewports. */
export function MessageActionMenuContent({ className, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
	return (
		<DropdownMenu.Portal>
			<DropdownMenu.Content
				align="end"
				sideOffset={6}
				collisionPadding={12}
				className={cn(
					"message-action-menu z-[130] w-64 max-w-[calc(100vw-24px)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain rounded-xl border border-neutral-200 bg-white p-2 text-neutral-700 shadow-lg outline-none [touch-action:pan-y] [&_svg]:shrink-0 [&_[role=menuitem]]:cursor-pointer [&_[role=menuitem]]:outline-none [&_[data-highlighted]]:bg-neutral-100 [&_[data-disabled]]:text-neutral-400 max-md:[&_[role=menuitem]]:min-h-11 max-md:[&_[role=menuitem]]:text-base",
					className,
				)}
				{...props}
			/>
		</DropdownMenu.Portal>
	);
}
