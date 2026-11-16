"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { usePagedQuery } from "@/lib/trpc/use-paged-query";
import { formatMoney, shortDate } from "@/lib/display";
import { completedBy } from "@/lib/payments";
import { failureMessage } from "@/lib/failures";
import { cn } from "@/lib/utils";
import { PageHeader, Loading, Refusal, Empty, Slip } from "./pieces";
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

export function AccountsScreen({
  selected,
  children,
}: {
  selected?: string;
  children?: ReactNode;
}) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const [limit, setLimit] = useState(20);
  const query = usePagedQuery(trpc.accounts.list.queryOptions({ limit, offset: 0 }), "accounts", {
    limit,
    read: (page, signal) => api.accounts.list.query(page, { signal }),
    merge: (a, b) => ({ ...b, items: [...a.items, ...b.items] }),
  });
  const data = query.data;
  if (!data)
    return query.error ? (
      <Refusal retry={() => void query.refetch()}>{failureMessage(query.error, "read")}</Refusal>
    ) : (
      <Loading label="Loading accounts" />
    );
  const more = data.total > limit;
  return (
    <>
      <PageHeader title="Accounts" className={selected ? "max-md:hidden" : undefined}>
        {data.total} accounts · an account opens when a lead is won
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Accounts"
          className={cn(
            "min-w-0 overflow-auto",
            selected ? "hidden w-pay-list shrink-0 border-e xl:block" : "flex-1",
          )}
        >
          <div className="flex justify-between px-6 py-3 text-xs text-muted-foreground">
            <span>Account, A to Z</span>
            {data.items.some((account) => account.balances !== null) && <span>Balance</span>}
          </div>
          {!data.total && (
            <Empty icon="accounts" title="No accounts yet">
              An account opens when a lead is won. Accounts you can use will appear here.
            </Empty>
          )}
          <ul>
            {data.items.map((account) => (
              <li key={account.id}>
                <Link
                  href={`/accounts/${account.id}`}
                  aria-current={account.id === selected ? "page" : undefined}
                  className="block border-b px-6 py-3 hover:bg-muted aria-[current=page]:bg-accent"
                >
                  <div className="flex justify-between gap-3">
                    <span className="truncate font-semibold">
                      {account.person?.name ?? account.person?.email ?? "Account"}
                    </span>
                    {account.balances !== null && (
                      <span className="shrink-0 font-semibold">
                        {account.balances.length
                          ? account.balances
                              .map((balance) =>
                                formatMoney({ minor: balance.balance, currency: balance.currency }),
                              )
                              .join(" · ")
                          : "No postings"}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-secondary-foreground">
                    <span className="truncate">
                      {account.campaign ?? "No campaign"} · {account.paymentCount ?? 0} payments
                    </span>
                    {account.paymentInProgress && (
                      <Slip kind="waiting" icon="wait">
                        Waiting ·{" "}
                        {account.paymentInProgress.status === "pendingApproval"
                          ? "approval"
                          : "provider"}
                      </Slip>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {query.error && (
            <Refusal retry={() => void query.refetch()}>
              {failureMessage(query.error, "read")}
            </Refusal>
          )}
          {(more || limit > 20) && (
            <div className="p-4">
              <Button
                variant="outline"
                busy={query.isFetching}
                aria-disabled={!more}
                onClick={() => {
                  if (more) setLimit((value) => value + 20);
                }}
              >
                {more ? "Show more accounts" : "All accounts shown"}
              </Button>
            </div>
          )}
        </section>
        {children && <div className="min-w-0 flex-1 overflow-auto">{children}</div>}
      </div>
    </>
  );
}

export function AccountDetail({
  id,
  zone,
  ledger = false,
  children,
}: {
  id: string;
  zone: string;
  ledger?: boolean;
  children?: ReactNode;
}) {
  const trpc = useTRPC();
  const { data: account } = useSuspenseQuery(trpc.accounts.get.queryOptions({ id }));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [id, ledger]);
  return (
    <article className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only md:hidden">Account detail</h1>
      <Link href="/accounts" className="text-primary underline">
        Back to accounts
      </Link>
      <header className="space-y-2 border-b pb-4">
        <h2 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
          {account.person?.name ?? "Account"}
        </h2>
        <p className="text-caption text-secondary-foreground">
          {account.campaign ?? "No campaign"} · {account.person?.email ?? "No email address"}
        </p>
        {account.balances !== null && (
          <div>
            <p className="text-xs text-muted-foreground">Balance</p>
            <p className="text-3xl font-bold">
              {account.balances.length
                ? account.balances
                    .map((balance) =>
                      formatMoney({ minor: balance.balance, currency: balance.currency }),
                    )
                    .join(" · ")
                : "No postings yet"}
            </p>
          </div>
        )}
      </header>
      {!children && (
        <div className="flex flex-wrap gap-2">
          {account.mayEdit && (
            <>
              <Button asChild>
                <Link href={`/payments/new/${id}/card`}>Create card checkout</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/payments/new/${id}/manual`}>Record manual payment</Link>
              </Button>
            </>
          )}
          {account.balances !== null && !ledger && (
            <Button asChild variant="outline">
              <Link href={`/accounts/${id}/ledger`}>Open ledger</Link>
            </Button>
          )}
        </div>
      )}
      {account.pendingPayment && !children && (
        <div className="rounded-lg border border-waiting-border bg-waiting p-4 text-waiting-foreground">
          <h3 className="font-semibold">A payment is in progress</h3>
          <p className="my-2 text-caption">
            {formatMoney(account.pendingPayment.money)} ·{" "}
            {account.pendingPayment.method === "manual" ? "Manual" : "Card"} · recorded by{" "}
            {account.pendingPayment.recordedBy?.name ?? "a staff member"}
          </p>
          <Link className="underline" href={`/payments/${account.pendingPayment.id}`}>
            Open the payment in progress
          </Link>
        </div>
      )}
      {children}
      {ledger && account.balances !== null && <AccountLedger id={id} zone={zone} />}
    </article>
  );
}

function AccountLedger({ id, zone }: { id: string; zone: string }) {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.accounts.ledger.queryOptions({ id }));
  return (
    <section aria-label="Account ledger" className="space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="font-semibold">Ledger</h3>
        <span className="text-xs text-muted-foreground">Oldest first</span>
      </div>
      {!data.balances.length && (
        <Empty icon="accounts" title="No ledger lines yet">
          A completed payment adds a credit to this account.
        </Empty>
      )}
      {data.balances.map((balance) => (
        <Table
          className="max-md:block"
          key={balance.currency}
          aria-label={`${balance.currency} ledger`}
        >
          <caption className="sr-only">{balance.currency} ledger</caption>
          <TableHeader className="max-md:hidden">
            <TableRow>
              {[
                "When",
                "Payment",
                "This account’s line",
                "The posting’s other line",
                "Balance",
              ].map((label) => (
                <TableHead
                  key={label}
                  className={label === "When" || label === "Payment" ? undefined : "text-end"}
                >
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className="max-md:block">
            {balance.entries.map((entry) => (
              <TableRow
                key={entry.paymentId}
                className="max-md:grid max-md:grid-cols-2 max-md:gap-1 max-md:py-3"
              >
                <TableCell className="max-md:col-span-2">{shortDate(entry.at, zone)}</TableCell>
                <TableCell className="whitespace-normal max-md:col-span-2">
                  <Link href={`/payments/${entry.paymentId}`} className="text-primary underline">
                    {entry.kind === "first" ? "First" : "Repeat"} payment ·{" "}
                    {entry.method === "manual" ? "manual" : "card"}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {entry.completion.by === "manualApproval" && "approver" in entry.completion
                      ? `Second approval by ${entry.completion.approver?.name ?? "an approver"}`
                      : `Completed by ${completedBy(entry.completion.by).toLowerCase()}`}
                  </p>
                </TableCell>
                <TableCell className="whitespace-normal text-end font-semibold">
                  <p className="text-xs font-normal text-muted-foreground md:hidden">
                    This account
                  </p>
                  {formatMoney({ minor: entry.amount, currency: balance.currency })}
                  <p className="text-xs font-normal text-muted-foreground">
                    {entry.side === "credit" ? "Credit" : "Debit"}
                  </p>
                </TableCell>
                <TableCell className="whitespace-normal text-end">
                  {entry.posting?.lines
                    .filter((line) => line.side !== entry.side)
                    .map((line) => (
                      <div key={line.id}>
                        {formatMoney({ minor: line.amount, currency: balance.currency })}
                        <p className="text-xs text-muted-foreground">
                          {line.side === "debit" ? "Debit" : "Credit"} · {line.account.name}
                        </p>
                      </div>
                    ))}
                </TableCell>
                <TableCell className="whitespace-normal text-end font-semibold max-md:col-span-2">
                  <p className="text-xs font-normal text-muted-foreground md:hidden">Balance</p>
                  {formatMoney({ minor: entry.balance, currency: balance.currency })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="max-md:block">
            <TableRow className="max-md:grid max-md:grid-cols-2">
              <TableCell className="whitespace-normal" colSpan={4}>
                Balance · credits minus debits
              </TableCell>
              <TableCell className="whitespace-normal text-end">
                {formatMoney({ minor: balance.balance, currency: balance.currency })}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      ))}
      <p className="rounded-lg border bg-muted p-4 text-caption text-secondary-foreground">
        Each completed payment has one posting: a credit to this account and a debit of the same
        amount to the provider or bank. Debits equal credits. Lines are added and never changed. A
        payment that has not completed has no line.
      </p>
    </section>
  );
}
