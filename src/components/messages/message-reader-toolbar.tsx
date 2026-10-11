import clsx from "clsx";
import type { ReactNode } from "react";

/** Keep actions outside the independently scrolling message body. */
export function MessageReaderToolbar({ children, scrolled = false }: { children: ReactNode; scrolled?: boolean }) {
	return <div data-message-toolbar className={clsx("flex h-12 shrink-0 items-center px-2 border-b bg-white z-40 gap-3 max-md:gap-0", scrolled ? "border-neutral-200" : "border-transparent")}>{children}</div>;
}
