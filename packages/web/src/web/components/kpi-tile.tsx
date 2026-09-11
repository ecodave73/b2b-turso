import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The solid-colour KPI tile from the reference: white icon on the left, label above a large
 * number on the right. Tones are fixed to the sampled palette — a tile never picks its colour
 * from the value it displays, so the strip stays stable as numbers move.
 */
const TONES = {
  orange: "bg-warning",
  green: "bg-success",
  coral: "bg-destructive",
  blue: "bg-primary",
} as const;

export type KpiTone = keyof typeof TONES;

export function KpiTile({
  label,
  value,
  icon: Icon,
  tone,
  hint,
  loading = false,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone: KpiTone;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-4 rounded-md px-5 py-4 text-white", TONES[tone])}>
      <Icon className="size-8 shrink-0 opacity-90" strokeWidth={1.75} />
      <div className="min-w-0">
        <div className="text-[12px] font-normal text-white/85">{label}</div>
        <div className="text-[22px] leading-tight font-semibold tabular-nums">
          {loading ? <span className="text-white/70">—</span> : value}
        </div>
        {hint ? <div className="truncate text-[11px] text-white/75">{hint}</div> : null}
      </div>
    </div>
  );
}
