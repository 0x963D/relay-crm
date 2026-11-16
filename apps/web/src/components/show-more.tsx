import type { ComponentProps } from "react";
import { Button } from "./ui/button";

export function ShowMore({
  more,
  busy,
  noun,
  onMore,
  ...props
}: {
  more: boolean;
  busy: boolean;
  noun: "leads" | "accounts" | "payments";
  onMore: () => void;
} & Pick<ComponentProps<typeof Button>, "size" | "className">) {
  return (
    <Button
      {...props}
      variant="outline"
      busy={busy}
      aria-disabled={!more || busy}
      onClick={() => {
        if (more && !busy) onMore();
      }}
    >
      {more ? `Show more ${noun}` : `All ${noun} shown`}
    </Button>
  );
}
