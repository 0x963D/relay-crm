"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { CURRENCIES } from "@relay/domain";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { parseAmount, amountInput, type PaymentView } from "@/lib/payments";
import { formatMoney, shortDate } from "@/lib/display";
import { failureCode, failureMessage } from "@/lib/failures";
import { Refusal, Slip } from "./pieces";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export function PaymentForm({
  accountId,
  mode,
  zone,
  editing,
}: {
  accountId: string;
  mode: "card" | "manual";
  zone: string;
  editing?: PaymentView;
}) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const client = useQueryClient();
  const router = useRouter();
  const { data: account } = useSuspenseQuery(trpc.accounts.get.queryOptions({ id: accountId }));
  const [amount, setAmount] = useState(editing ? amountInput(editing.money) : "");
  const [currency, setCurrency] = useState<string>(editing?.money.currency ?? "GBP");
  const [kind, setKind] = useState<"first" | "repeat">(
    editing
      ? editing.kind === "first"
        ? "first"
        : "repeat"
      : account.paymentCount
        ? "repeat"
        : "first",
  );
  const [receipt, setReceipt] = useState<File | null>(null);
  const [reference, setReference] = useState(editing?.reference ?? "");
  const [validation, setValidation] = useState("");
  const [created, setCreated] = useState<{ paymentId: string; url: string | null } | null>(null);
  const createdPayment = useQuery(
    trpc.payments.get.queryOptions({ id: created?.paymentId ?? "" }, { enabled: created !== null }),
  );
  const [copied, setCopied] = useState("");
  const result = useRef<HTMLDivElement>(null);
  const request = useRef<{ terms: string; key: string } | null>(null);
  useEffect(() => {
    const clear = () => {
      setCreated(null);
    };
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
    };
  }, []);
  const save = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const money = parseAmount(amount, currency);
      if (!money) throw new Error("invalidAmount");
      let hash = editing?.receiptHash ?? "";
      if (receipt)
        hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", await receipt.arrayBuffer())),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      const terms = JSON.stringify({ accountId, amount, currency, kind, hash, reference });
      if (request.current?.terms !== terms) request.current = { terms, key: crypto.randomUUID() };
      const input = {
        key: request.current.key,
        accountId,
        amount: money.minor.toString(),
        currency,
        kind,
      };
      if (editing)
        return (
          await api.payments.editManual.mutate({
            id: editing.id,
            version: editing.version,
            amount: input.amount,
            currency,
            receiptHash: hash,
            reference: reference.trim() || null,
          })
        ).id;
      if (mode === "manual")
        return (
          await api.payments.recordManual.mutate({
            ...input,
            receiptHash: hash,
            reference: reference.trim() || null,
          })
        ).id;
      const response = await api.payments.createCheckout.mutate(input);
      // The capability stays in this mounted form; mutation and query caches receive only the ID.
      setCreated({ paymentId: response.paymentId, url: response.checkout.url });
      return response.paymentId;
    },
    onSuccess: async (id) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: trpc.accounts.get.queryKey({ id: accountId }) }),
        client.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() }),
        client.invalidateQueries({ queryKey: trpc.payments.list.queryKey() }),
        ...(editing
          ? [client.invalidateQueries({ queryKey: trpc.payments.get.queryKey({ id }) })]
          : []),
      ]);
      if (mode === "manual") router.push(`/payments/${id}`);
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: trpc.accounts.get.queryKey({ id: accountId }) });
    },
  });
  useEffect(() => {
    if (save.error || created || validation) result.current?.focus();
  }, [save.error, created, validation]);
  if (!account.mayEdit || (editing && !editing.actions.editManual))
    return (
      <Refusal title="This payment cannot be changed">
        Your access or the payment changed. Return to the account to see its current state.
      </Refusal>
    );
  if (created)
    return (
      <section
        ref={result}
        tabIndex={-1}
        aria-label="Checkout created"
        className="space-y-4 rounded-lg border p-4"
      >
        <h2 className="text-panel font-bold">Card checkout created</h2>
        <Slip kind="outline" icon="payments">
          Sandbox
        </Slip>
        <p>
          {formatMoney(parseAmount(amount, currency) ?? { minor: 0n, currency: "GBP" })} ·{" "}
          {kind === "first" ? "First" : "Repeat"} payment
        </p>
        {createdPayment.data ? (
          <dl className="grid grid-cols-label-value gap-x-4 gap-y-2 text-caption">
            <dt>Created by</dt>
            <dd>{createdPayment.data.recordedBy?.name ?? "Staff member"}</dd>
            <dt>Created at</dt>
            <dd>{shortDate(createdPayment.data.createdAt, zone)}</dd>
            <dt>Checkout expires</dt>
            <dd>{shortDate(createdPayment.data.expiresAt, zone)}</dd>
          </dl>
        ) : createdPayment.error ? (
          <Refusal retry={() => void createdPayment.refetch()}>
            {failureMessage(createdPayment.error, "read")}
          </Refusal>
        ) : (
          <p role="status">Loading checkout details</p>
        )}
        <p className="text-caption text-secondary-foreground">
          Only one payment can be in progress for this account.
        </p>
        {created.url ? (
          <>
            <Field label="Pay link" hint="Open the sandbox page to pay with invented money.">
              {(control) => <Input {...control} readOnly value={created.url ?? ""} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(created.url ?? "").then(
                    () => {
                      setCopied("Link copied.");
                    },
                    () => {
                      setCopied("The link could not be copied. Select it and copy it yourself.");
                    },
                  );
                }}
              >
                Copy the link
              </Button>
              <Button variant="outline" asChild>
                <a
                  href={created.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setCreated(null);
                  }}
                >
                  Open the page
                </a>
              </Button>
            </div>
            <p role="status">{copied}</p>
            <div className="rounded-lg border border-waiting-border bg-waiting p-4 text-waiting-foreground">
              <h3 className="font-semibold">Copy this link now. It will not be shown again.</h3>
              <p className="mt-1 text-caption">
                Only this page holds the pay link. Leaving or reloading removes it. If it is lost,
                close the payment as failed and create another checkout.
              </p>
            </div>
          </>
        ) : (
          <Refusal title="The checkout link is no longer available">
            This request already created a checkout. Open its payment; if the link is lost, close it
            as failed before creating another.
          </Refusal>
        )}
        <Button variant="outline" asChild>
          <Link
            href={`/payments/${created.paymentId}`}
            onClick={() => {
              setCreated(null);
            }}
          >
            Go to payment
          </Link>
        </Button>
      </section>
    );
  const pending = failureCode(save.error) === "pendingPayment" ? account.pendingPayment : null;
  return (
    <form
      className="max-w-xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        setValidation("");
        if (!parseAmount(amount, currency)) {
          setValidation("Enter a positive amount using the currency’s decimal places.");
          return;
        }
        if (mode === "manual" && !receipt && !editing?.receiptHash) {
          setValidation("Choose the receipt for this payment.");
          return;
        }
        save.mutate();
      }}
    >
      <h2 className="text-panel font-bold">
        {editing
          ? "Edit manual payment"
          : mode === "card"
            ? "Create a card checkout"
            : "Record a manual payment"}
      </h2>
      <p className="text-caption text-secondary-foreground">
        For {account.person?.name ?? account.person?.email ?? "this account"}
      </p>
      <div ref={result} tabIndex={-1}>
        {(validation || save.error) && (
          <Refusal
            title={
              mode === "card" ? "The checkout was not created" : "This payment was not recorded"
            }
          >
            <p>{validation || failureMessage(save.error)}</p>
            {pending && (
              <>
                <p>
                  {formatMoney(pending.money)} · {pending.method === "manual" ? "Manual" : "Card"} ·
                  recorded by {pending.recordedBy?.name ?? "a staff member"} on{" "}
                  {shortDate(pending.createdAt, zone)}.
                </p>
                <Link href={`/payments/${pending.id}`} className="underline">
                  Open the payment in progress
                </Link>
              </>
            )}
          </Refusal>
        )}
      </div>
      {mode === "manual" && (
        <Field label="Account" hint="Accounts come from won leads.">
          {(control) => (
            <Input
              {...control}
              value={account.person?.name ?? account.person?.email ?? "Account"}
              readOnly
            />
          )}
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              required
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Currency">
          {(control) => (
            <NativeSelect
              {...control}
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
            >
              {Object.keys(CURRENCIES).map((code) => (
                <option key={code}>{code}</option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <Field label="Kind">
        {(control) => (
          <ToggleGroup
            {...control}
            type="single"
            aria-label="Payment kind"
            value={kind}
            disabled={!!editing}
            onValueChange={(value) => {
              if (value === "first" || value === "repeat") setKind(value);
            }}
          >
            <ToggleGroupItem value="first">First</ToggleGroupItem>
            <ToggleGroupItem value="repeat">Repeat</ToggleGroupItem>
          </ToggleGroup>
        )}
      </Field>
      {mode === "manual" && (
        <>
          <Field
            label={editing ? "Replace receipt" : "Receipt"}
            hint="One receipt can back one payment only. Its fingerprint is recorded; the file stays on your device."
          >
            {(control) => (
              <Input
                {...control}
                type="file"
                onChange={(event) => {
                  setReceipt(event.target.files?.[0] ?? null);
                }}
              />
            )}
          </Field>
          <Field
            label="Receipt reference"
            hint="A filename or bank reference to help the approvers identify it."
          >
            {(control) => (
              <Input
                {...control}
                value={reference}
                maxLength={200}
                onChange={(event) => {
                  setReference(event.target.value);
                }}
              />
            )}
          </Field>
          <p className="text-caption text-secondary-foreground">
            {editing
              ? "Saving these terms voids every previous approval. You become a maker and cannot approve or reject this payment."
              : "Two other people must approve this payment. You cannot approve or reject it. You can cancel it while it waits."}
          </p>
        </>
      )}
      {mode === "card" && (
        <p className="text-caption text-secondary-foreground">
          The sandbox provider uses invented money. The pay link will appear once after you create
          the checkout.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" busy={save.isPending}>
          {save.isPending
            ? "Saving…"
            : editing
              ? "Save changes"
              : mode === "card"
                ? "Create checkout"
                : "Send for approval"}
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/accounts/${accountId}`}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
