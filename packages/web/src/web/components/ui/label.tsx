import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `htmlFor` is destructured and applied explicitly rather than arriving through `{...props}`.
 * It behaves identically, but it makes the association visible to the a11y lint rule — which
 * cannot see through a spread — and it makes the binding to a control the obvious default for
 * anyone writing a form with this.
 */
function Label({ className, htmlFor, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      htmlFor={htmlFor}
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-[12px] leading-none font-medium text-secondary-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
