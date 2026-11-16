import Link from "next/link";
import type { PaymentView, PaymentRow } from "@/lib/payments";
import { paymentStatus } from "@/lib/payments";
import { formatMoney } from "@/lib/display";
import { Slip } from "./pieces";
import { Icon } from "./icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from "./ui/table";

export function PaymentPart({ actions }: { actions: PaymentRow["actions"] }) {
  const approved = actions.approvalRefusal === "alreadyApproved";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon
        name={actions.approve || approved ? "check" : actions.cancel ? "close" : "ban"}
        size="small"
      />
      {actions.approve
        ? "You can approve"
        : actions.cancel
          ? "You can cancel it"
          : approved
            ? "You approved it"
            : "You cannot approve"}
    </span>
  );
}

export function PaymentStatus({
  payment,
  compact = false,
}: {
  payment: Pick<PaymentRow, "state" | "approvals">;
  compact?: boolean;
}) {
  const status = payment.state.status;
  return (
    <Slip
      kind={
        status === "completed"
          ? "complete"
          : ["checkoutCreated", "pendingApproval"].includes(status)
            ? "waiting"
            : status === "expired"
              ? "neutral"
              : "refused"
      }
      icon={
        status === "completed"
          ? "done"
          : ["checkoutCreated", "pendingApproval"].includes(status)
            ? "wait"
            : "error"
      }
    >
      {compact && status === "checkoutCreated" ? "Waiting" : paymentStatus(payment)}
    </Slip>
  );
}
export function LedgerPosting({ payment }: { payment: PaymentView }) {
  if (!payment.posting) return null;
  const total = (side: string) =>
    payment.posting?.lines
      .filter((line) => line.side === side)
      .reduce((sum, line) => sum + line.amount, 0n) ?? 0n;
  return (
    <section aria-label="Ledger posting" className="space-y-3">
      <h3 className="font-semibold">Ledger posting</h3>
      <Table aria-label="Payment posting">
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-end">Debit</TableHead>
            <TableHead className="text-end">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payment.posting.lines
            .toSorted((a, b) => (a.side === b.side ? 0 : a.side === "debit" ? -1 : 1))
            .map((line) => (
              <TableRow key={line.id}>
                <TableCell className="whitespace-normal">{line.account.name}</TableCell>
                {["debit", "credit"].map((side) => (
                  <TableCell key={side} className="text-end font-semibold">
                    {line.side === side
                      ? formatMoney({ minor: line.amount, currency: payment.money.currency })
                      : ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Debits equal credits</TableCell>
            {["debit", "credit"].map((side) => (
              <TableCell className="text-end" key={side}>
                {formatMoney({ minor: total(side), currency: payment.money.currency })}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      </Table>
      <Link className="text-primary underline" href={`/accounts/${payment.accountId}/ledger`}>
        Open {payment.account?.name ?? "this account"}’s ledger
      </Link>
    </section>
  );
}
