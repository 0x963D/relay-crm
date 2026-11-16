import {
  runOutbox,
  leaseReceipt,
  requeueReceipt,
  type ReceiptDelivery,
  type OutboxOptions,
} from "./outbox.ts";
import type {
  PaymentId,
  Actor,
  Intake,
  LeadId,
  AccountId,
  TeamId,
  Assignment,
  DistributionRequest,
} from "@relay/domain";
import { intakeWith } from "./intake.ts";
import { listLeads, type LeadListItem } from "./leads.ts";
import { listAccounts, getAccount } from "./accounts.ts";
import {
  authenticationDatabase,
  sessionPrincipal,
  initialSessionTeam,
  selectTeam,
  ensureDevelopmentActor,
} from "./auth.ts";
import {
  getLead,
  editLead,
  assignPool,
  reassignLead,
  previewDistribution,
  submitDistribution,
} from "./distribution.ts";
import { takeRequestLimit } from "./rate-limit.ts";
import {
  recordManualPayment,
  approveManualPayment,
  decideManualPayment,
  editManualPayment,
  type RecordManualPayment,
  type ManualDecision,
  type ManualTerms,
  createPayment,
  checkoutTerms,
  receivePaymentWebhook,
  duePayments,
  claimPaymentCheck,
  finishPaymentCheck,
  closePayment,
  getPayment,
  listPayments,
  accountLedger,
  type CreatePayment,
  type ProviderEvent,
} from "./payments.ts";
import type { ProviderPayment, Money, SandboxMode } from "@relay/domain";
import {
  createSandboxCheckout,
  getSandboxCheckout,
  paySandboxCheckout,
  cancelSandboxCheckout,
} from "./sandbox.ts";
import { connect } from "./tx.ts";

export type { LeadListItem };
export { AccessError, isAccessError } from "./errors.ts";
export type Store = ReturnType<typeof openStore>;

export function openStore(config: { readonly connectionString: string }) {
  const db = connect(config.connectionString);
  return {
    runOutbox: (deliver: ReceiptDelivery, options?: OutboxOptions) =>
      runOutbox(db, config.connectionString, deliver, options),
    leaseReceipt: (id: string, at: Date, leaseMs: number) => leaseReceipt(db, id, at, leaseMs),
    requeueReceipt: (actor: Actor, id: PaymentId, requestId: string) =>
      requeueReceipt(db, actor, id, requestId),
    recordManualPayment: (actor: Actor, input: RecordManualPayment, requestId: string) =>
      recordManualPayment(db, actor, input, requestId),
    approveManualPayment: (
      actor: Actor,
      input: ManualDecision & { readonly roleVersion: number },
      requestId: string,
    ) => approveManualPayment(db, actor, input, requestId),
    decideManualPayment: (
      actor: Actor,
      input: ManualDecision & { readonly reason: string; readonly decision: "reject" | "cancel" },
      requestId: string,
    ) => decideManualPayment(db, actor, input, requestId),
    editManualPayment: (actor: Actor, input: ManualDecision & ManualTerms, requestId: string) =>
      editManualPayment(db, actor, input, requestId),
    createPayment: (actor: Actor, input: CreatePayment, firstCheckMs: number, requestId: string) =>
      createPayment(db, actor, input, firstCheckMs, requestId),
    checkoutTerms: (actor: Actor, id: PaymentId) => checkoutTerms(db, actor, id),
    receivePaymentWebhook: (event: ProviderEvent) => receivePaymentWebhook(db, event),
    duePayments: (at: Date, limit: number) => duePayments(db, at, limit),
    claimPaymentCheck: (id: string, at: Date, intervalMs: number) =>
      claimPaymentCheck(db, id, at, intervalMs),
    finishPaymentCheck: (id: string, token: string, observed: ProviderPayment | null) =>
      finishPaymentCheck(db, id, token, observed),
    closePaymentReview: (actor: Actor, id: PaymentId, reason: string, requestId: string) =>
      closePayment(db, actor, id, reason, requestId, "closeReview"),
    closePaymentCheckout: (actor: Actor, id: PaymentId, reason: string, requestId: string) =>
      closePayment(db, actor, id, reason, requestId, "closeCheckout"),
    cancelSandboxCheckout: (id: string) => cancelSandboxCheckout(db, id),
    getPayment: (actor: Actor, id: PaymentId) => getPayment(db, actor, id),
    listPayments: (actor: Actor, limit: number) => listPayments(db, actor, limit),
    accountLedger: (actor: Actor, id: AccountId) => accountLedger(db, actor, id),
    createSandboxCheckout: (input: {
      readonly paymentId: string;
      readonly money: Money;
      readonly mode: SandboxMode;
      readonly expiresAt?: Date;
    }) => createSandboxCheckout(db, input),
    getSandboxCheckout: (id: string) => getSandboxCheckout(db, id),
    paySandboxCheckout: (id: string) => paySandboxCheckout(db, id),
    intake: intakeWith(db) satisfies Intake,
    authenticationDatabase: authenticationDatabase(db),
    sessionPrincipal: (id: string) => sessionPrincipal(db, id),
    initialSessionTeam: (userId: string) => initialSessionTeam(db, userId),
    selectTeam: (sessionId: string, teamId: TeamId | null) => selectTeam(db, sessionId, teamId),
    takeRequestLimit: (key: string, max: number, windowSeconds: number) =>
      takeRequestLimit(db, key, max, windowSeconds),
    ensureDevelopmentActor: (actor: Actor) => ensureDevelopmentActor(db, actor),
    listLeads: (actor: Actor, page: { readonly limit: number }) => listLeads(db, actor, page),
    getLead: (actor: Actor, id: LeadId) => getLead(db, actor, id),
    editLead: (
      actor: Actor,
      id: LeadId,
      fields: { readonly name: string | null; readonly phone: string | null },
    ) => editLead(db, actor, id, fields),
    listAccounts: (actor: Actor, page: { readonly limit: number }) => listAccounts(db, actor, page),
    getAccount: (actor: Actor, id: AccountId) => getAccount(db, actor, id),
    assignPool: (actor: Actor, leadIds: readonly LeadId[], to: Assignment, requestId: string) =>
      assignPool(db, actor, leadIds, to, requestId),
    reassignLead: (actor: Actor, leadId: LeadId, to: Assignment, requestId: string) =>
      reassignLead(db, actor, leadId, to, requestId),
    previewDistribution: (actor: Actor, request: DistributionRequest) =>
      previewDistribution(db, actor, request),
    submitDistribution: (
      actor: Actor,
      input: { readonly previewId: string; readonly fingerprint: string; readonly key: string },
      requestId: string,
    ) => submitDistribution(db, actor, input, requestId),
    close: () => db.$disconnect(),
  };
}
