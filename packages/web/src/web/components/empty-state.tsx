import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Every list route gets one of these (design.md). An empty table with nothing but a header row
 * is indistinguishable from a broken query — this says which of the two it is and what to do
 * about it.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {Icon ? <Icon className="size-8 text-muted-foreground/60" strokeWidth={1.5} /> : null}
      <p className="text-[14px] font-semibold text-foreground">{title}</p>
      {description ? <p className="max-w-md text-[13px] text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
