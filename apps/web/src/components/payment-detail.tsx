"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import {
  completedBy,
  eventDetail,
  reportedMoney,
  groupPaymentEvents,
  type PaymentView,
} from "@/lib/payments";
import { callbackDate, formatMoney, shortDate } from "@/lib/display";
import { failureMessage, failureMessages } from "@/lib/failures";
import { cn } from "@/lib/utils";
import { PaymentStatus, LedgerPosting } from "./payment-pieces";
import { Signoff, Refusal } from "./pieces";
import { Timeline, TimelineEntry } from "./timeline";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Textarea } from "./ui/textarea";
import { Icon } from "./icons";

type Action = "approve" | "reject" | "cancel" | "closeReview" | "closeCheckout" | "requeueReceipt";
export function PaymentDetail({
  id,
  zone,
  canCloseReview,
}: {
  id: string;
  zone: string;
  canCloseReview: boolean;
}) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const client = useQueryClient();
  const { data: payment } = useSuspenseQuery(trpc.payments.get.queryOptions({ id }));
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const result = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  const command = useMutation({
    mutationFn: async (action: Action) => {
      const input = { id, version: payment.version, reason };
      switch (action) {
        case "approve":
          return api.payments.approve.mutate({
            id,
            version: payment.version,
            roleVersion: payment.actions.roleVersion,
          });
        case "reject":
          return api.payments.reject.mutate(input);
        case "cancel":
          return api.payments.cancel.mutate(input);
        case "closeReview":
          return api.payments.closeReview.mutate({ id, reason });
        case "closeCheckout":
          return api.payments.closeCheckout.mutate({ id, reason });
        case "requeueReceipt":
          return api.payments.requeueReceipt.mutate({ id });
      }
    },
    onSuccess: async (value, action) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: trpc.payments.get.queryKey({ id }) }),
        ...(action === "requeueReceipt"
          ? []
          : [
              client.invalidateQueries({ queryKey: trpc.payments.list.queryKey() }),
              client.invalidateQueries({
                queryKey: trpc.accounts.get.queryKey({ id: payment.accountId }),
              }),
              client.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() }),
              ...(action === "approve"
                ? [
                    client.invalidateQueries({
                      queryKey: trpc.accounts.ledger.queryKey({ id: payment.accountId }),
                    }),
                  ]
                : []),
            ]),
      ]);
      setMessage(
        "message" in value
          ? value.message
          : action === "approve"
            ? "Your approval was recorded."
            : action === "requeueReceipt"
              ? "The receipt was queued again. The payment and ledger did not change."
              : "Your decision was recorded.",
      );
      setReason("");
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: trpc.payments.get.queryKey({ id }) });
    },
  });
  useEffect(() => {
    if (command.isError || message) result.current?.focus();
  }, [command.isError, message]);
  const run = (action: Action) => {
    setMessage("");
    command.mutate(action);
  };
  const state = payment.state;
  const completed = state.status === "completed";
  const reviewing = state.status === "needsReview";
  const waiting = state.status === "checkoutCreated";
  const manualWaiting = state.status === "pendingApproval";
  const closedState = payment.events.findLast((event) => {
    const status = eventDetail(event.detail).status;
    return status === "expired" || status === "failed" || event.kind === "checkoutClosed";
  });
  const approvals = payment.approvals.filter((a) => !a.voidedAt);
  const reports = payment.events.filter(
    (event) =>
      ["reconcilerCheck", "webhookDelivery"].includes(event.kind) &&
      eventDetail(event.detail).providerStatus === "completed",
  ).length;
  const decisionPanel = (payment.actions.closeCheckout ||
    (reviewing && canCloseReview) ||
    payment.actions.reject ||
    payment.actions.cancel) && (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim())
          run(
            payment.actions.closeCheckout
              ? "closeCheckout"
              : reviewing
                ? "closeReview"
                : payment.actions.cancel
                  ? "cancel"
                  : "reject",
          );
      }}
    >
      <h3 className="font-semibold">
        {manualWaiting ? "Record a decision" : "Close this payment as failed"}
      </h3>
      <p className="text-caption text-secondary-foreground">
        {reviewing
          ? "A payment in review cannot be completed. Close it with a written reason. Any refund happens outside Relay CRM."
          : waiting
            ? "For a checkout the customer will not use. If the customer has already paid, it goes to review."
            : "A written reason is kept with your decision."}
      </p>
      <Field label="Reason" hint="A written reason is required.">
        {(control) => (
          <Textarea
            {...control}
            required
            maxLength={2000}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {payment.actions.approve && (
          <Button
            type="button"
            busy={command.isPending}
            onClick={() => {
              run("approve");
            }}
          >
            Approve as {approvals.length ? "second" : "first"} approver
          </Button>
        )}
        <Button
          type="submit"
          variant="destructive"
          busy={command.isPending}
          disabled={!reason.trim()}
        >
          {manualWaiting
            ? payment.actions.cancel
              ? "Cancel payment"
              : "Reject payment"
            : "Close as failed"}
        </Button>
        {payment.actions.cancel && payment.actions.reject && (
          <Button
            type="button"
            variant="outline"
            busy={command.isPending}
            disabled={!reason.trim()}
            onClick={() => {
              run("reject");
            }}
          >
            Reject payment
          </Button>
        )}
      </div>
    </form>
  );
  return (
    <article aria-label="Payment detail" className="@container/payment">
      <h1 className="sr-only md:hidden">Payment detail</h1>
      <div className="space-y-4 border-b p-4 md:p-6">
        <Link
          href="/payments"
          className="inline-flex items-center gap-1 text-caption text-primary xl:hidden"
        >
          <Icon name="back" />
          Back to payments
        </Link>
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 ref={heading} tabIndex={-1} className="text-3xl font-bold outline-none">
              {formatMoney(payment.money)}
            </h2>
            <PaymentStatus payment={payment} reason />
          </div>
          <p className="mt-1 text-caption text-secondary-foreground">
            {payment.kind === "first" ? "First" : "Repeat"} payment ·{" "}
            <Link className="text-primary underline" href={`/accounts/${payment.accountId}`}>
              {payment.account?.name ?? "Account"}
            </Link>{" "}
            · {payment.campaign ?? "No campaign"} ·{" "}
            {payment.method === "manual" ? "manual" : "card, sandbox provider"}
            {" · "}Sold by {payment.soldBy?.name ?? "No seller recorded"}
          </p>
        </div>
        <div className="grid gap-4 @lg/payment:grid-cols-3">
          <Signoff
            caption={payment.method === "manual" ? "Recorded by" : "Checkout created by"}
            name={payment.recordedBy?.name ?? "Staff member"}
            time={callbackDate(payment.createdAt, zone)}
          />
          {manualWaiting || (completed && payment.method === "manual") ? (
            <>
              <Signoff
                caption="First approval"
                emptyLabel="Waiting for a first approver"
                name={approvals[0]?.approver?.name ?? null}
                time={approvals[0] ? callbackDate(approvals[0].at, zone) : undefined}
              />
              <Signoff
                caption="Second approval · a different person"
                emptyLabel="Waiting for a second approver"
                name={approvals[1]?.approver?.name ?? null}
                time={approvals[1] ? callbackDate(approvals[1].at, zone) : undefined}
              />
            </>
          ) : (
            <>
              <Signoff
                caption="Completed by"
                name={
                  completed
                    ? completedBy(state.by)
                    : waiting
                      ? "Waiting for the provider"
                      : "Not completed"
                }
                icon={completed ? "done" : "wait"}
              />
              <Signoff
                caption="Credited to this account"
                name={completed ? (payment.account?.name ?? "Account") : "Nothing was credited"}
                icon={completed ? "accounts" : "ban"}
              />
            </>
          )}
        </div>
      </div>
      <div className="space-y-5 p-4 md:p-6">
        {(command.error !== null || message !== "") && (
          <div ref={result} tabIndex={-1}>
            {command.error ? (
              <Refusal>{failureMessage(command.error)}</Refusal>
            ) : (
              <p role="status" className="font-medium text-complete-foreground">
                {message}
              </p>
            )}
          </div>
        )}
        {(completed || reviewing) && (
          <section
            aria-label="Payment outcome"
            className={cn(
              "flex flex-wrap items-center gap-4 rounded-lg border p-4",
              completed
                ? "border-complete-border bg-complete text-complete-foreground"
                : "border-refused-border bg-refused text-refused-foreground",
            )}
          >
            <Icon name={completed ? "done" : "error"} size="large" />
            <div className="min-w-0 flex-1">
              <h3 className="text-panel font-bold">
                {completed ? "Credited once" : "Nothing was credited"}
              </h3>
              <p className="mt-1 text-caption">
                {reviewing
                  ? state.reason === "paid after close"
                    ? "The provider reported payment after this checkout had closed."
                    : `The provider reported ${formatMoney(state.reported)} ${state.reported.currency}. This payment is for ${formatMoney(payment.money)} ${payment.money.currency}.`
                  : payment.method === "manual"
                    ? "Two approvers approved this payment. One ledger posting credited the account."
                    : "The payment is complete. Later deliveries do not credit the account again."}
              </p>
            </div>
            {payment.method !== "manual" && (
              <div className="text-center">
                <p className="text-2xl font-bold">{reports}</p>
                <p className="text-xs">
                  {reports === 1 ? "time" : "times"} the provider
                  <br />
                  reported it paid
                </p>
              </div>
            )}
            <div className="text-center">
              <p className="text-2xl font-bold">{payment.postingCount}</p>
              <p className="text-xs">
                ledger {payment.postingCount === 1 ? "posting" : "postings"}
                <br />
                written
              </p>
            </div>
          </section>
        )}
        {reviewing && (
          <section aria-label="Review comparison" className="grid gap-4 @lg/payment:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">This payment</p>
              <p className="text-xl font-bold">
                {state.reason === "paid after close"
                  ? closedState && eventDetail(closedState.detail).status === "expired"
                    ? "Expired"
                    : "Closed as failed"
                  : `${formatMoney(payment.money)} ${payment.money.currency}`}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">The provider reported</p>
              <p className="text-xl font-bold text-refused-foreground">
                {state.reason === "paid after close"
                  ? "Paid"
                  : `${formatMoney(state.reported)} ${state.reported.currency}`}
              </p>
              {state.reason === "paid after close" && (
                <p className="text-caption">
                  {formatMoney(state.reported)} {state.reported.currency}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">What differs</p>
              <p className="text-xl font-bold">
                {state.reason === "paid after close"
                  ? "The state"
                  : state.reason === "currency mismatch"
                    ? `${payment.money.currency} / ${state.reported.currency}`
                    : formatMoney({
                        minor:
                          payment.money.minor > state.reported.minor
                            ? payment.money.minor - state.reported.minor
                            : state.reported.minor - payment.money.minor,
                        currency: payment.money.currency,
                      })}
              </p>
              <p className="text-caption text-secondary-foreground">
                {state.reason === "paid after close"
                  ? payment.money.minor === state.reported.minor &&
                    payment.money.currency === state.reported.currency
                    ? "The amount and the currency match."
                    : "The payment was already closed. The reported money also differs."
                  : state.reason === "currency mismatch"
                    ? "The currency. Amounts in different currencies cannot be compared."
                    : "The amount. The currency matches."}
              </p>
            </div>
          </section>
        )}
        <div className="grid gap-6 @2xl/payment:grid-cols-payment-detail">
          <div className="space-y-6">
            {waiting && (
              <section className="space-y-3">
                <h3 className="font-semibold">What happens next</h3>
                <p>When the customer pays, the provider sends a signed webhook.</p>
                <p>If no webhook arrives, the reconciler asks the provider.</p>
                <dl className="grid grid-cols-label-value gap-x-4 gap-y-2 text-caption">
                  <dt>Next check</dt>
                  <dd>{shortDate(payment.nextCheckAt, zone)}</dd>
                  <dt>First check</dt>
                  <dd>
                    {payment.reconciliation
                      ? shortDate(
                          new Date(
                            payment.createdAt.getTime() + payment.reconciliation.firstCheckMs,
                          ),
                          zone,
                        )
                      : "Reconciliation is unavailable"}
                  </dd>
                  <dt>Check interval</dt>
                  <dd>
                    {payment.reconciliation
                      ? `${String(payment.reconciliation.intervalMs / 1000)} seconds`
                      : "Unavailable"}
                  </dd>
                  <dt>Checkout expires</dt>
                  <dd>
                    {payment.expiresAt
                      ? shortDate(payment.expiresAt, zone)
                      : "No checkout was created"}
                  </dd>
                </dl>
                <p className="text-caption text-secondary-foreground">
                  The pay link was shown once, when the checkout was created. If it is lost, close
                  this payment as failed and create a new checkout.
                </p>
              </section>
            )}
            {manualWaiting && (
              <section className="space-y-4">
                <div>
                  <h3 className="font-semibold">Receipt reference</h3>
                  <p>{payment.reference ?? "No reference recorded"}</p>
                  <p className="text-xs text-muted-foreground">
                    The receipt fingerprint is recorded. The original file is not stored here.
                  </p>
                </div>
                {payment.actions.approvalRefusal && (
                  <p className="text-caption text-secondary-foreground">
                    {failureMessages[payment.actions.approvalRefusal]}
                  </p>
                )}
                {decisionPanel}
                {payment.actions.editManual && (
                  <Button variant="outline" asChild>
                    <Link href={`/payments/${id}/edit`}>Edit payment</Link>
                  </Button>
                )}
                <h3 className="font-semibold">Who may not approve this payment</h3>
                <ul className="space-y-3">
                  {payment.cannotApprove.map((entry, index) => (
                    <li
                      key={`${entry.user?.id ?? "unknown"}-${String(index)}`}
                      className="text-caption"
                    >
                      <strong>{entry.user?.name ?? "Staff member"}</strong> ·{" "}
                      {entry.reason === "paymentRecorder"
                        ? "recorded it and may cancel it, but cannot approve or reject it."
                        : entry.reason === "paymentMaker"
                          ? "edited it and cannot approve or reject it."
                          : entry.reason === "alreadyApproved"
                            ? "already approved it. Another person must decide."
                            : "changed role and no longer has approval rights."}
                    </li>
                  ))}
                </ul>
                <p className="text-caption text-secondary-foreground">
                  An edit voids the approvals already given. Your role is checked again when you
                  decide.
                </p>
              </section>
            )}
            <PaymentEvents payment={payment} zone={zone} />
          </div>
          <div className="space-y-6 @2xl/payment:border-s @2xl/payment:ps-6">
            <LedgerPosting payment={payment} />
            {!manualWaiting && decisionPanel}
            {!payment.postingCount && (
              <p className="text-caption text-secondary-foreground">
                No ledger posting was written. A payment is credited only when it completes.
              </p>
            )}
            <Receipt
              payment={payment}
              zone={zone}
              busy={command.isPending}
              sendAgain={() => {
                run("requeueReceipt");
              }}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

function PaymentEvents({ payment, zone }: { payment: PaymentView; zone: string }) {
  let webhookSeen = false;
  let absenceShown = false;
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <h3 className="font-semibold">What happened</h3>
        <span className="text-xs text-muted-foreground">Oldest first</span>
      </div>
      <Timeline name="Payment events">
        {groupPaymentEvents(payment.events).map(({ event, count, lastAt }) => {
          const detail = eventDetail(event.detail);
          const amount = reportedMoney(detail);
          const provider = event.kind === "webhookDelivery" || event.kind === "reconcilerCheck";
          const absence =
            event.kind === "reconcilerCheck" &&
            detail.providerStatus === "completed" &&
            !webhookSeen &&
            !absenceShown;
          if (absence) absenceShown = true;
          if (event.kind === "webhookDelivery") webhookSeen = true;
          const title =
            event.kind === "checkoutCreated"
              ? "Checkout created"
              : event.kind === "manualRecorded"
                ? "Manual payment recorded"
                : event.kind === "settlement"
                  ? "The payment was completed"
                  : event.kind === "webhookDelivery"
                    ? detail.duplicate
                      ? "The webhook arrived again"
                      : detail.late
                        ? "The webhook arrived late"
                        : "The webhook arrived"
                    : event.kind === "reconcilerCheck"
                      ? "The reconciler asked the provider"
                      : event.kind === "approved"
                        ? "Approval recorded"
                        : event.kind === "edited"
                          ? payment.approvals.some(
                              (approval) =>
                                approval.paymentVersion + 1 === detail.version &&
                                approval.voidedAt !== null,
                            )
                            ? "Payment edited · previous approvals voided"
                            : "Payment edited"
                          : event.kind === "reviewClosed" || event.kind === "checkoutClosed"
                            ? "Payment closed as failed"
                            : event.kind === "cancelled"
                              ? "Payment cancelled"
                              : event.kind === "rejected"
                                ? "Payment rejected"
                                : event.kind === "checkoutCancellation"
                                  ? "Provider cancellation checked"
                                  : event.kind === "receiptRequeued"
                                    ? "Receipt queued again"
                                    : "Payment updated";
          return (
            <Fragment key={String(event.sequence)}>
              {absence && (
                <TimelineEntry icon="wait" gap>
                  <h4 className="font-semibold">No webhook was recorded before this check</h4>
                  <p className="mt-1 text-caption text-secondary-foreground">
                    The reconciler checked the provider without a signed webhook having arrived.
                  </p>
                </TimelineEntry>
              )}
              <TimelineEntry
                icon={
                  event.kind === "settlement"
                    ? "done"
                    : event.kind === "reconcilerCheck"
                      ? "refresh"
                      : provider
                        ? "payments"
                        : "history"
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h4 className="font-semibold">
                    {count > 1 ? `${String(count)} reconciler checks changed nothing` : title}
                  </h4>
                  <time className="text-xs text-muted-foreground" dateTime={event.at.toISOString()}>
                    {callbackDate(event.at, zone)}
                    {count > 1 && ` to ${callbackDate(lastAt, zone)}`}
                  </time>
                </div>
                <div className="mt-1 space-y-1 text-caption text-secondary-foreground">
                  {provider && (
                    <p>
                      {detail.providerStatus === "completed"
                        ? "The provider reported: paid"
                        : detail.providerStatus === "pending"
                          ? "The provider reported: waiting"
                          : detail.error
                            ? "The provider could not be reached"
                            : `The provider reported: ${typeof detail.providerStatus === "string" ? detail.providerStatus : "unavailable"}`}
                      {amount ? `, ${formatMoney(amount)} ${amount.currency}.` : "."}
                    </p>
                  )}
                  {provider && detail.changed === false && <p>Nothing changed.</p>}
                  {event.kind === "settlement" && (
                    <p>The ledger posting was written and the receipt was queued.</p>
                  )}
                  {(event.kind === "checkoutCreated" || event.kind === "manualRecorded") && (
                    <p>
                      By {payment.recordedBy?.name ?? "a staff member"}, for{" "}
                      {formatMoney(payment.money)}.
                    </p>
                  )}
                  {event.actor && !["checkoutCreated", "manualRecorded"].includes(event.kind) && (
                    <p>By {event.actor.name}.</p>
                  )}
                  {typeof detail.reason === "string" && <p>{detail.reason}</p>}
                </div>
              </TimelineEntry>
              {provider && detail.changed === true && detail.status !== "completed" && (
                <TimelineEntry icon={detail.status === "expired" ? "clock" : "error"}>
                  <h4 className="font-semibold">
                    {detail.status === "needsReview"
                      ? "Moved to needs review"
                      : detail.status === "expired"
                        ? "Payment closed as expired"
                        : "Payment closed as failed"}
                  </h4>
                  <p className="mt-1 text-caption text-secondary-foreground">
                    Nothing was credited.
                  </p>
                </TimelineEntry>
              )}
            </Fragment>
          );
        })}
      </Timeline>
    </section>
  );
}

function Receipt({
  payment,
  zone,
  busy,
  sendAgain,
}: {
  payment: PaymentView;
  zone: string;
  busy: boolean;
  sendAgain: () => void;
}) {
  const receipt = payment.receipt;
  const atCap = receipt !== null && receipt.attempts >= payment.receiptAttemptLimit;
  return (
    <section aria-label="Receipt" className="space-y-3">
      <h3 className="font-semibold">Receipt</h3>
      {!receipt ? (
        <p className="text-caption text-secondary-foreground">
          No receipt is queued. A receipt is queued after the payment completes.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Icon name="mail" />
            <strong>Receipt email</strong>
            <span className="ms-auto text-caption">
              {receipt.processing
                ? "Sending"
                : receipt.state === "sent"
                  ? "Sent"
                  : receipt.state === "unknown"
                    ? "Delivery unknown"
                    : receipt.state === "suppressed"
                      ? "Not sent"
                      : receipt.nextAttemptAt
                        ? `Next attempt ${callbackDate(receipt.nextAttemptAt, zone)}`
                        : "Failed"}
            </span>
          </div>
          <p className="text-caption text-secondary-foreground">
            {receipt.recipient ? `To ${receipt.recipient}.` : "No email address was recorded."}{" "}
            {receipt.attempts} {receipt.attempts === 1 ? "attempt" : "attempts"} of{" "}
            {payment.receiptAttemptLimit} allowed.
          </p>
          {receipt.state === "unknown" && (
            <p className="text-caption">
              The message left Relay CRM without a clear delivery answer. It will not retry by
              itself. Sending again may deliver a duplicate receipt.
            </p>
          )}
          {receipt.state === "suppressed" && (
            <p className="text-caption">Delivery is suppressed. It will not retry.</p>
          )}
          <ol className="space-y-2">
            {receipt.history.map((attempt) => (
              <li key={attempt.id} className="text-caption">
                <strong>
                  {attempt.number === 0 ? "Not sent" : `Attempt ${String(attempt.number)}`}
                </strong>{" "}
                · {shortDate(attempt.startedAt, zone)} · {attempt.state}
                {attempt.reason && (
                  <p className="mt-1 text-secondary-foreground">{attempt.reason}</p>
                )}
              </li>
            ))}
          </ol>
          {payment.actions.requeueReceipt && (
            <Button variant="outline" busy={busy} onClick={sendAgain}>
              Send again
            </Button>
          )}
          {atCap && receipt.state !== "sent" && (
            <Refusal announce={false} title="The receipt cannot be sent again">
              {failureMessages.receiptAttemptLimit}
            </Refusal>
          )}
          <p className="text-xs text-muted-foreground">
            Receipt delivery does not change the payment or its ledger posting.
          </p>
        </>
      )}
    </section>
  );
}
