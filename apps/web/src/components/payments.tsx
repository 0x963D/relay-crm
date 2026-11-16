"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { usePagedQuery } from "@/lib/trpc/use-paged-query";
import { type PaymentRow, paymentGroups } from "@/lib/payments";
import { callbackDate, formatMoney } from "@/lib/display";
import { failureMessage } from "@/lib/failures";
import { cn } from "@/lib/utils";
import { PageHeader, Loading, Refusal, Empty } from "./pieces";
import { PaymentStatus, PaymentPart } from "./payment-pieces";
import { Button } from "./ui/button";
import { ShowMore } from "./show-more";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export function PaymentsScreen({
  zone,
  selected,
  children,
  form = false,
}: {
  zone: string;
  selected?: string | undefined;
  children?: ReactNode;
  form?: boolean;
}) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const [limit, setLimit] = useState(20);
  const opened = useQuery(
    trpc.payments.get.queryOptions({ id: selected ?? "" }, { enabled: !!selected }),
  );
  const narrowPanel =
    form ||
    opened.data?.state.status === "pendingApproval" ||
    opened.data?.state.status === "checkoutCreated";
  const compact = !!selected && !narrowPanel;
  const query = usePagedQuery(trpc.payments.list.queryOptions({ limit, offset: 0 }), "payments", {
    limit,
    read: (page, signal) => api.payments.list.query(page, { signal }),
    merge: (a, b) => ({
      ...b,
      needsReview: [...a.needsReview, ...b.needsReview],
      waitingForApproval: [...a.waitingForApproval, ...b.waitingForApproval],
      waitingForProvider: [...a.waitingForProvider, ...b.waitingForProvider],
      decidedThisWeek: [...a.decidedThisWeek, ...b.decidedThisWeek],
    }),
  });
  const data = query.data;
  if (!data)
    return query.error ? (
      <Refusal retry={() => void query.refetch()}>{failureMessage(query.error, "read")}</Refusal>
    ) : (
      <Loading label="Loading payments" />
    );
  const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0);
  const more = Object.values(data.counts).some((count) => count > limit);
  return (
    <>
      <PageHeader
        title="Payments"
        className={selected ? "max-md:hidden" : undefined}
        action={
          <Button variant="outline" asChild>
            <Link href="/accounts">Open accounts</Link>
          </Button>
        }
      >
        {data.counts.waitingForApproval} waiting for approval · {data.counts.waitingForProvider}{" "}
        waiting for the provider
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Payments"
          className={cn(
            "min-w-0 overflow-auto",
            selected || form
              ? compact
                ? "hidden w-pay-list shrink-0 border-e xl:block"
                : "hidden flex-1 border-e xl:block"
              : "flex-1",
          )}
        >
          {!total && (
            <Empty icon="payments" title="No payments yet">
              Open an account to record a payment or create a checkout.
            </Empty>
          )}
          {compact &&
            opened.data &&
            !paymentGroups.some(([key]) => data[key].some((row) => row.id === selected)) && (
              <section aria-label="Opened payment">
                <h2 className="px-6 pb-2 pt-5 text-caption font-semibold text-secondary-foreground">
                  Opened payment
                </h2>
                <ul>
                  <CompactPayment payment={opened.data} selected={selected} zone={zone} />
                </ul>
              </section>
            )}
          {paymentGroups.map(
            ([key, label]) =>
              data.counts[key] > 0 && (
                <section key={key} aria-label={label}>
                  <h2 className="flex gap-2 px-6 pb-2 pt-5 text-caption font-semibold text-secondary-foreground">
                    {label}
                    <span>{data.counts[key]}</span>
                  </h2>
                  <ul className={compact ? undefined : "md:hidden"}>
                    {data[key].map((payment) => (
                      <CompactPayment
                        key={payment.id}
                        payment={payment}
                        selected={selected}
                        zone={zone}
                      />
                    ))}
                  </ul>
                  {!compact && (
                    <div className="hidden md:block">
                      <Table aria-label={label} className="table-fixed">
                        <colgroup>
                          <col className="w-1/5" />
                          <col className="w-1/8" />
                          <col className="w-1/12" />
                          <col className="w-1/12" />
                          <col className="w-1/6" />
                          <col className="w-1/6" />
                          <col />
                        </colgroup>
                        <TableHeader>
                          <TableRow>
                            {[
                              "Account",
                              "Amount",
                              "Method",
                              "Kind",
                              "Recorded by",
                              "Status",
                              key === "waitingForProvider"
                                ? "Next check"
                                : key === "waitingForApproval"
                                  ? "Your part"
                                  : "When",
                            ].map((name) => (
                              <TableHead
                                key={name}
                                className={name === "Amount" ? "text-end" : undefined}
                              >
                                {name}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data[key].map((payment) => (
                            <TableRow
                              key={payment.id}
                              data-state={payment.id === selected ? "selected" : undefined}
                            >
                              <TableCell className="whitespace-normal">
                                <Link
                                  href={`/payments/${payment.id}`}
                                  className="font-semibold text-primary underline-offset-4 hover:underline"
                                >
                                  {payment.account?.name ?? payment.account?.email ?? "Account"}
                                </Link>
                              </TableCell>
                              <TableCell className="text-end font-semibold">
                                {formatMoney(payment.money)}
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                {payment.method === "manual" ? "Manual" : "Card"}
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                {payment.kind === "first" ? "First" : "Repeat"}
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                {payment.recordedBy?.name ?? "Staff member"}
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <PaymentStatus payment={payment} compact={compact} />
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                {key === "waitingForApproval" ? (
                                  <PaymentPart actions={payment.actions} />
                                ) : (
                                  callbackDate(
                                    key === "waitingForProvider"
                                      ? payment.nextCheckAt
                                      : "at" in payment.state
                                        ? payment.state.at
                                        : payment.createdAt,
                                    zone,
                                  )
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </section>
              ),
          )}
          {query.error && (
            <Refusal retry={() => void query.refetch()}>
              {failureMessage(query.error, "read")}
            </Refusal>
          )}
          {(more || limit > 20) && (
            <div className="p-4">
              <ShowMore
                more={more}
                busy={query.isFetching}
                noun="payments"
                onMore={() => {
                  setLimit((value) => value + 20);
                }}
              />
            </div>
          )}
        </section>
        {children && (
          <div
            className={cn(
              "min-w-0 flex-1 overflow-auto",
              narrowPanel && "xl:w-payment-form xl:flex-none",
            )}
          >
            {children}
          </div>
        )}
      </div>
    </>
  );
}

function CompactPayment({
  payment,
  selected,
  zone,
}: {
  payment: Pick<
    PaymentRow,
    "id" | "account" | "state" | "approvals" | "money" | "method" | "kind" | "createdAt" | "actions"
  >;
  selected?: string | undefined;
  zone: string;
}) {
  return (
    <li>
      <Link
        href={`/payments/${payment.id}`}
        aria-current={payment.id === selected ? "page" : undefined}
        className="block border-b px-6 py-3 hover:bg-muted aria-[current=page]:bg-accent"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold">
            {payment.account?.name ?? payment.account?.email ?? "Account"}
          </span>
          <PaymentStatus payment={payment} compact />
        </div>
        <p className="mt-1 text-caption text-secondary-foreground">
          <strong className="text-foreground">{formatMoney(payment.money)}</strong> ·{" "}
          {payment.method === "manual" ? "Manual" : "Card"} ·{" "}
          {payment.kind === "first" ? "First" : "Repeat"}
          {" · "}
          {payment.state.status === "needsReview"
            ? payment.state.reason
            : callbackDate("at" in payment.state ? payment.state.at : payment.createdAt, zone)}
        </p>
      </Link>
    </li>
  );
}
