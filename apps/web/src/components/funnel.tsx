"use client";
import Link from "next/link";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { countLabel, sourceLabel } from "@/lib/display";
import { PageHeader, Empty, Slip } from "./pieces";
import { Button } from "./ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from "./ui/table";

export function FunnelScreen() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.reports.funnel.queryOptions());
  const total = data.rows.reduce(
    (sum, row) => ({
      received: sum.received + row.received,
      unassigned: sum.unassigned + row.unassigned,
      contacted: sum.contacted + row.contacted,
      won: sum.won + row.won,
    }),
    { received: 0, unassigned: 0, contacted: 0, won: 0 },
  );
  const max = Math.max(1, ...data.rows.map((row) => row.received));
  const waiting = data.rows.toSorted((a, b) => b.unassigned - a.unassigned)[0];
  const percent = (won: number, received: number) =>
    received
      ? new Intl.NumberFormat("en-GB", {
          style: "percent",
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(won / received)
      : "—";
  function exportCsv() {
    const escape = (value: string | number) => {
      const text = String(value);
      const cell = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
      return `"${cell.replaceAll('"', '""')}"`;
    };
    const rows = [
      ["Campaign", "Source", "Received", "Unassigned", "Contacted", "Won", "Conversion"],
      ...data.rows.map((row) => [
        row.campaign ?? "No campaign",
        sourceLabel(row.source),
        row.received,
        row.unassigned,
        row.contacted,
        row.won,
        percent(row.won, row.received),
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.map((row) => row.map(escape).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "campaign-funnel.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageHeader
        title="Campaign funnel"
        action={
          <Button variant="outline" onClick={exportCsv}>
            Export CSV
          </Button>
        }
      >
        {countLabel(total.received, "lead")} received · {countLabel(data.campaignCount, "campaign")}{" "}
        and {countLabel(data.otherSourceCount, "other source")}
      </PageHeader>
      <div className="overflow-auto">
        <div className="flex flex-wrap items-center gap-4 px-6 py-4 text-caption text-secondary-foreground">
          {[
            ["bg-funnel-received", "Received"],
            ["bg-primary", "Contacted"],
            ["bg-funnel-won", "Won"],
          ].map(([color, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`size-3 rounded-sm ${color ?? ""}`} />
              {label}
            </span>
          ))}
          <span className="text-xs">Every bar uses one scale. The full width is {max} leads.</span>
        </div>
        {!data.rows.length ? (
          <Empty icon="funnel" title="No leads received yet">
            Campaign totals will appear after leads arrive.
          </Empty>
        ) : (
          <Table aria-label="Campaign funnel">
            <TableHeader>
              <TableRow>
                {[
                  "Campaign and source",
                  "Funnel",
                  "Received",
                  "Unassigned",
                  "Contacted",
                  "Won",
                  "Conversion",
                ].map((label) => (
                  <TableHead
                    key={label}
                    className={
                      label === "Campaign and source" || label === "Funnel" ? undefined : "text-end"
                    }
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={`${row.source ?? "unknown"}:${row.campaign ?? "none"}`}>
                  <TableCell className="py-4">
                    <p className="font-semibold">{row.campaign ?? "No campaign"}</p>
                    <p className="text-xs text-muted-foreground">{sourceLabel(row.source)}</p>
                  </TableCell>
                  <TableCell className="min-w-36">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 100 8"
                      preserveAspectRatio="none"
                      className="h-3 w-full"
                    >
                      <rect
                        width={(row.received / max) * 100}
                        height="8"
                        className="fill-funnel-received"
                      />
                      <rect
                        width={(row.contacted / max) * 100}
                        height="8"
                        className="fill-primary"
                      />
                      <rect width={(row.won / max) * 100} height="8" className="fill-funnel-won" />
                    </svg>
                  </TableCell>
                  <TableCell className="text-end">{row.received}</TableCell>
                  <TableCell className="text-end">
                    {row.unassigned ? (
                      <Slip kind="waiting" icon="wait">
                        {row.unassigned} waiting
                      </Slip>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell className="text-end">{row.contacted}</TableCell>
                  <TableCell className="text-end font-semibold text-complete-foreground">
                    {row.won}
                  </TableCell>
                  <TableCell className="text-end font-semibold">
                    {percent(row.won, row.received)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>All leads</TableCell>
                {[
                  total.received,
                  total.unassigned,
                  total.contacted,
                  total.won,
                  percent(total.won, total.received),
                ].map((value, index) => (
                  <TableCell key={index} className="text-end">
                    {value}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>
        )}
        <div className="grid gap-4 p-6 lg:grid-cols-2">
          {waiting && waiting.unassigned > 0 && (
            <div className="rounded-lg border border-waiting-border bg-waiting p-4 text-waiting-foreground">
              <h2 className="font-semibold">
                {waiting.campaign ?? sourceLabel(waiting.source)} has {waiting.unassigned} leads
                with no owner
              </h2>
              <p className="mt-1 text-caption">
                They are in the lead pool.{" "}
                <Link href="/pool" className="underline">
                  Assign them
                </Link>
              </p>
            </div>
          )}
          <p className="rounded-lg border bg-muted p-4 text-caption text-secondary-foreground">
            <strong>How to read this.</strong> A row is one campaign from one source. Received
            includes leads later closed as dead. Contacted counts leads an agent spoke to; an
            attempt alone does not count. Conversion is won divided by received.
          </p>
        </div>
      </div>
    </>
  );
}
