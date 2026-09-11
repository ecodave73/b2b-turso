import { cn } from "@/lib/utils";

/**
 * THE single owner of order-status colour. design.md pins the map; nothing else in the app may
 * hardcode a status colour, because eight statuses across five pages is exactly how a UI ends
 * up calling the same PAID order green in one table and blue in another.
 *
 * The two blues are deliberate: SHIPPED and CONFIRMED are "in motion" (#2260F6), INVOICED is
 * the deeper #1C64E4 — money has been asked for, but not yet received.
 */
const STATUS_COLOURS: Record<string, string> = {
  DRAFT: "#7C7C7C",
  PENDING: "#F9AF4F",
  CONFIRMED: "#2260F6",
  SHIPPED: "#2260F6",
  INVOICED: "#1C64E4",
  PAID: "#59D05D",
  CLOSED: "#59D05D",
  CANCELLED: "#FD686D",
};

/** Unknown statuses render grey rather than throwing — a new status must not blank a table. */
export function orderStatusColour(status: string): string {
  return STATUS_COLOURS[status] ?? "#7C7C7C";
}

export function OrderStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white",
        className,
      )}
      style={{ backgroundColor: orderStatusColour(status) }}
    >
      {status}
    </span>
  );
}
