import type * as React from "react";
import { cn } from "@/lib/utils";

/** shadcn's native select: the platform's own list, keyboard and screen reader behaviour. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-7 min-w-0 rounded-md border border-input bg-background px-1.5 text-xs text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
