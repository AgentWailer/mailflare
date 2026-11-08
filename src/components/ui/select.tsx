import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SelectProps } from "./select-types";

// A native select drawn with the same chevron as the other form selects, instead of each
// browser's own arrow, so neighbouring controls in one form look like one family.
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, containerClassName, ...props }, ref) => (
    <span className={cn("relative inline-flex min-w-0 rounded-lg border border-neutral-200 px-2 has-[:focus-visible]:border-blue-600", containerClassName)}>
      <select
        className={cn(
          "flex w-full appearance-none truncate rounded-md bg-transparent pr-6 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
    </span>
  ),
);
Select.displayName = "Select";
