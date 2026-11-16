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
  createPayment,
  checkoutTerms,
  receivePaymentWebhook,
  duePayments,
  claimPaymentCheck,
  finishPaymentCheck,
  closePaymentReview,
  getPayment,
  listPayments,
  accountLedger,
  type CreatePayment,
  type ProviderEvent,
} from "./payments.ts";
import type { ProviderPayment, Money, SandboxMode } from "@relay/domain";
import { createSandboxCheckout, getSandboxCheckout, paySandboxCheckout } from "./sandbox.ts";
import { connect } from "./tx.ts";

export type { LeadListItem };
export { AccessError, isAccessError } from "./errors.ts";
export type Store = ReturnType<typeof openStore>;

export function openStore(config: { readonly connectionString: string }) {
  const db = connect(config.connectionString);
  return {
    createPayment: (actor: Actor, input: CreatePayment, firstCheckMs: number) =>
      createPayment(db, actor, input, firstCheckMs),
    checkoutTerms: (actor: Actor, id: PaymentId) => checkoutTerms(db, actor, id),
    receivePaymentWebhook: (event: ProviderEvent) => receivePaymentWebhook(db, event),
    duePayments: (at: Date, limit: number) => duePayments(db, at, limit),
    claimPaymentCheck: (id: string, at: Date, intervalMs: number) =>
      claimPaymentCheck(db, id, at, intervalMs),
    finishPaymentCheck: (id: string, token: string, observed: ProviderPayment | null) =>
      finishPaymentCheck(db, id, token, observed),
    closePaymentReview: (actor: Actor, id: PaymentId, reason: string) =>
      closePaymentReview(db, actor, id, reason),
    getPayment: (actor: Actor, id: PaymentId) => getPayment(db, actor, id),
    listPayments: (actor: Actor, limit: number) => listPayments(db, actor, limit),
    accountLedger: (actor: Actor, id: AccountId) => accountLedger(db, actor, id),
    createSandboxCheckout: (input: {
      readonly paymentId: string;
      readonly money: Money;
      readonly mode: SandboxMode;
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
    assignPool: (actor: Actor, leadIds: readonly LeadId[], to: Assignment) =>
      assignPool(db, actor, leadIds, to),
    reassignLead: (actor: Actor, leadId: LeadId, to: Assignment) =>
      reassignLead(db, actor, leadId, to),
    previewDistribution: (actor: Actor, request: DistributionRequest) =>
      previewDistribution(db, actor, request),
    submitDistribution: (
      actor: Actor,
      input: { readonly previewId: string; readonly fingerprint: string; readonly key: string },
    ) => submitDistribution(db, actor, input),
    close: () => db.$disconnect(),
  };
}
