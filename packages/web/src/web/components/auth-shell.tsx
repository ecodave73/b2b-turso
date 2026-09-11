import type { ReactNode } from "react";

/**
 * The signed-out frame: a centred card on the grey page, with the product mark above it.
 * Same chrome for sign-in, sign-up and tenant creation so the three read as one flow.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className={wide ? "w-full max-w-lg" : "w-full max-w-sm"}>
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-[13px] font-semibold text-primary-foreground">
            B2
          </div>
          <span className="text-[15px] font-semibold text-foreground">B2B Platform</span>
        </div>

        <div className="rounded-md bg-card shadow-[0_1px_3px_rgb(0_0_0/0.06)]">
          <div className="px-6 pt-6">
            <h1 className="text-[20px] leading-tight font-semibold text-foreground">{title}</h1>
            {subtitle ? <p className="mt-1 text-[12px] text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="px-6 py-6">{children}</div>
        </div>

        {footer ? <div className="mt-4 text-center text-[12px] text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Filled error bar — matches the reference's coloured notify banner rather than a red hairline. */
export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4 rounded-md bg-destructive px-3 py-2 text-[12px] text-destructive-foreground">{message}</div>
  );
}
