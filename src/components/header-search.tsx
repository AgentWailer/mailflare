"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { HeaderSearchProps } from "./header-search-types";

// The header search shared by every layout. On phones it is an icon beside the menu button
// until tapped, then covers the header at full width; the wrapper still fills the row so
// whatever follows it stays pushed to the right. Mail uses the inline phone variant inside its search capsule.
export function HeaderSearch({ value, onChange, label, placeholder, onSubmit, trailing, inputProps, mobileInline = false }: HeaderSearchProps) {
	const [expanded, setExpanded] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (expanded) inputRef.current?.focus();
	}, [expanded]);

	return (
		<div className={clsx("flex min-w-0 flex-1 items-center", mobileInline && "mail-header-search md:max-w-[720px]")}>
			{!mobileInline && <button
				type="button"
				onClick={() => setExpanded(true)}
				aria-label={label}
				className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-neutral-200 md:hidden", value ? "bg-blue-100 text-blue-700" : "text-neutral-600", expanded && "hidden")}
			>
				<Search className="h-5 w-5" />
			</button>}
			<form
				role="search"
				onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}
				className={clsx("h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-[#eaf1fb] px-4 text-neutral-600 transition-colors md:flex md:focus-within:ring-2 md:focus-within:ring-blue-500/30", mobileInline ? "mail-search-form flex md:gap-3 md:px-3 max-md:bg-transparent max-md:px-2 max-md:gap-2" : expanded ? "flex max-md:fixed max-md:inset-x-2 max-md:top-2 max-md:z-[60] max-md:shadow-md focus-within:ring-2 focus-within:ring-blue-500/30" : "max-md:hidden")}
			>
				<Search aria-hidden="true" className={clsx("shrink-0", mobileInline ? "h-5 w-5 md:h-6 md:w-6" : "h-5 w-5")} />
				<Input
					ref={inputRef}
					{...inputProps}
					onBlur={() => setExpanded(false)}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					aria-label={label}
					placeholder={placeholder ?? label}
					className={clsx("h-full min-w-0 flex-1 bg-transparent text-base md:text-[15px] text-neutral-800 outline-none! shadow-none! border-none! ring-0! placeholder:text-neutral-500", mobileInline && "px-0")}
				/>
				{trailing}
			</form>
		</div>
	);
}
