import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table
      data-slot="table"
      className={cn(
        "tbl w-full [border-collapse:collapse] text-(length:--text-body) [&_th]:text-start [&_th]:text-(length:--text-caption) [&_th]:leading-[16px] [&_th]:font-[600] [&_th]:text-tertiary [&_th]:p-[10px_12px] [&_th]:[border-block-end:1px_solid_var(--color-rule)] [&_th]:whitespace-nowrap [&_th]:[font-stretch:94%] [&_td]:p-[0_12px] [&_td]:h-[44px] [&_td]:[border-block-end:1px_solid_var(--color-rule)] [&_td]:whitespace-nowrap [&_tfoot_td]:font-[650] [&_tfoot_td]:[border-block-end:0] [&_tfoot_td]:[border-block-start:1.5px_solid_var(--color-foreground)] [&_tbody_tr:hover]:bg-muted [&_tbody_tr[aria-selected='true']]:bg-selected [.pool-list_&]:text-(length:--text-small) [.pool-list_&_th]:px-control [.pool-list_&_td]:px-control [.pool-list_&_td]:max-w-[180px] [.pool-list_&_td]:whitespace-nowrap [.pool-list_&_td]:overflow-hidden [.pool-list_&_td]:text-ellipsis max-laptop:[.pool-list_&_th]:px-compact max-laptop:[.pool-list_&_td]:px-compact max-phone:[.pool-list_&]:block max-phone:[.pool-list_&]:w-full max-phone:[.pool-list_&_td]:whitespace-normal max-phone:[.pool-list_&_td]:p-[2px_4px]",
        className,
      )}
      {...props}
    />
  );
}
export function TableHeader(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}
export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}
export function TableRow(props: ComponentProps<"tr">) {
  return <tr {...props} />;
}
export function TableHead(props: ComponentProps<"th">) {
  return <th scope="col" {...props} />;
}
export function TableCell(props: ComponentProps<"td">) {
  return <td {...props} />;
}
