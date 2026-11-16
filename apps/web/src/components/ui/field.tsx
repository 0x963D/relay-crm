"use client";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: (props: { id: string; "aria-describedby": string | undefined }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const description = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-caption font-semibold">
        {label}
      </label>
      {children({ id, "aria-describedby": description })}
      {hint && (
        <p id={description} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
