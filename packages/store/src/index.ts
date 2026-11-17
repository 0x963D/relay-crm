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
import { listLeads, leadPool, queueAgents, type LeadListItem } from "./leads.ts";
import { listAccounts, getAccount } from "./accounts.ts";
import {
  authenticationDatabase,
  sessionPrincipal,
  initialSessionTeam,
  selectTeam,
  ensureDevelopmentActor,
  sessionProfile,
} from "./auth.ts";
import {
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
  paymentUsingReceipt,
  type RecordManualPayment,
  type ManualDecision,
  type ManualTerms,
  createPayment,
  checkoutTerms,
  finishCheckoutCreation,
  recordCheckoutCancellation,
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
  getSandboxCheckoutByToken,
  paySandboxCheckout,
  cancelSandboxCheckout,
} from "./sandbox.ts";
import { workLead, workQueue, leadDetail as getLead, campaignFunnel } from "./work.ts";
import type { UserId, LeadWork } from "@relay/domain";
import { exclusiveJob } from "./jobs.ts";
import { connect, type Db } from "./tx.ts";
import { demoPerson, demoReady, databaseReady, type DemoRole } from "./demo-state.ts";
export { DEMO_PEOPLE, DEMO_ROLES, type DemoRole } from "./demo-state.ts";

export type { LeadListItem };
export { AccessError, isAccessError } from "./errors.ts";
export type Store = ReturnType<typeof openStore>;

export function openStore(config: {
  readonly connectionString: string;
  readonly connection?: Db;
  readonly clock?: () => Date;
  readonly receipts?: Pick<OutboxOptions, "leaseMs" | "sendTimeoutMs" | "lifetimeAttemptLimit">;
}) {
  const db = connect(config.connectionString, config.clock, config.connection);
  return {
    sessionProfile: (actor: Actor) => sessionProfile(db, actor),
    leadPool: (actor: Actor, page: { limit: number; offset: number }) => leadPool(db, actor, page),
    queueAgents: (actor: Actor, offset: number) => queueAgents(db, actor, offset),
    demoPerson: (role: DemoRole) => demoPerson(db, role),
    demoReady: () => demoReady(db),
    databaseReady: () => databaseReady(db),
    exclusiveJob: <T>(route: "outbox" | "reconcile", run: (signal: AbortSignal) => Promise<T>) =>
      exclusiveJob(db, route, run),
    runOutbox: (deliver: ReceiptDelivery, options?: OutboxOptions) =>
      runOutbox(db, deliver, { ...config.receipts, ...options }),
    leaseReceipt: (id: string, at: Date, leaseMs: number) =>
      leaseReceipt(db, id, at, leaseMs, config.receipts?.lifetimeAttemptLimit),
    requeueReceipt: (actor: Actor, id: PaymentId, requestId: string) =>
      requeueReceipt(db, actor, id, requestId, config.receipts?.lifetimeAttemptLimit),
    recordManualPayment: (actor: Actor, input: RecordManualPayment, requestId: string) =>
      recordManualPayment(db, actor, input, requestId),
    paymentUsingReceipt: (actor: Actor, hash: string) => paymentUsingReceipt(db, actor, hash),
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
    finishCheckoutCreation: (id: string, creationToken: string | null = null) =>
      finishCheckoutCreation(db, id, creationToken),
    recordCheckoutCancellation: (
      id: string,
      observed: ProviderPayment | null,
      requestId: string,
      providerAsked: boolean,
    ) => recordCheckoutCancellation(db, id, observed, requestId, providerAsked),
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
    getPayment: (actor: Actor, id: PaymentId) =>
      getPayment(db, actor, id, config.receipts?.lifetimeAttemptLimit),
    listPayments: (actor: Actor, limit: number, offset = 0) =>
      listPayments(db, actor, limit, config.receipts?.lifetimeAttemptLimit, offset),
    accountLedger: (actor: Actor, id: AccountId) => accountLedger(db, actor, id),
    createSandboxCheckout: (input: {
      readonly paymentId: string;
      readonly money: Money;
      readonly mode: SandboxMode;
      readonly expiresAt?: Date;
      readonly creationToken?: string;
    }) => createSandboxCheckout(db, input),
    getSandboxCheckout: (id: string) => getSandboxCheckout(db, id),
    getSandboxCheckoutByToken: (token: string) => getSandboxCheckoutByToken(db, token),
    paySandboxCheckout: (id: string, mode?: SandboxMode) => paySandboxCheckout(db, id, mode),
    intake: intakeWith(db) satisfies Intake,
    authenticationDatabase: authenticationDatabase(db),
    sessionPrincipal: (id: string) => sessionPrincipal(db, id),
    initialSessionTeam: (userId: string) => initialSessionTeam(db, userId),
    selectTeam: (sessionId: string, teamId: TeamId | null) => selectTeam(db, sessionId, teamId),
    takeRequestLimit: (key: string, max: number, windowSeconds: number) =>
      takeRequestLimit(db, key, max, windowSeconds),
    ensureDevelopmentActor: (actor: Actor) => ensureDevelopmentActor(db, actor),
    workLead: (
      actor: Actor,
      input: { readonly id: LeadId; readonly key: string; readonly work: LeadWork },
      requestId: string,
    ) => workLead(db, actor, input, requestId),
    workQueue: (
      actor: Actor,
      input: {
        readonly agentId: UserId;
        readonly at: Date;
        readonly timeZone: string;
        readonly limit: number;
        readonly offset?: number;
      },
    ) => workQueue(db, actor, input),
    campaignFunnel: (actor: Actor) => campaignFunnel(db, actor),
    listLeads: (actor: Actor, page: { readonly limit: number }) => listLeads(db, actor, page),
    getLead: (actor: Actor, id: LeadId) => getLead(db, actor, id),
    editLead: (
      actor: Actor,
      id: LeadId,
      fields: { readonly name: string | null; readonly phone: string | null },
      requestId: string,
    ) => editLead(db, actor, id, fields, requestId),
    listAccounts: (actor: Actor, page: { readonly limit: number; readonly offset?: number }) =>
      listAccounts(db, actor, page),
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
