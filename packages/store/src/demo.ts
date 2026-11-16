import { createHash, randomUUID } from "node:crypto";
import {
  UserId,
  TeamId,
  parseEmail,
  parseExternalId,
  normalizeAttribution,
  type AccountId,
  type Actor,
  type IntakeSource,
  type LeadId,
  type LeadWork,
  type PaymentId,
  type SandboxMode,
} from "@relay/domain";
import { openStore } from "./index.ts";
import { DEMO_COMPANY, DEMO_KEY, DEMO_PEOPLE } from "./demo-state.ts";
import { assignPool } from "./distribution.ts";
import { workLead } from "./work.ts";
import { connect, transact, transactionConnection, type Db, type Tx } from "./tx.ts";
import { exclusiveJob } from "./jobs.ts";
import type { ReceiptDelivery } from "./outbox.ts";

export interface DemoOptions {
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly today: Date;
  readonly timeZone?: string;
  readonly deliver: ReceiptDelivery;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Invalid demo fixture.");
  return value;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const day = 86400000;
const STAFF = [
  { ...DEMO_PEOPLE.manager, role: "manager" },
  { ...DEMO_PEOPLE.agent, role: "agent" },
  { ...DEMO_PEOPLE.accountant, role: "accountant" },
  {
    id: "00000000-0000-7000-8000-000000000104",
    name: "Tomasz Zielinski",
    email: "tomasz.zielinski@tidewell.example",
    role: "manager",
  },
  {
    id: "00000000-0000-7000-8000-000000000105",
    name: "Ffion Pryce",
    email: "ffion.pryce@tidewell.example",
    role: "agent",
  },
  {
    id: "00000000-0000-7000-8000-000000000106",
    name: "Noor Haddad",
    email: "noor.haddad@tidewell.example",
    role: "agent",
  },
  {
    id: "00000000-0000-7000-8000-000000000107",
    name: "Callum Reid",
    email: "callum.reid@tidewell.example",
    role: "agent",
  },
] as const;
const sales = required(TeamId.parse("00000000-0000-7000-8000-000000000201"));
const accountsTeam = required(TeamId.parse("00000000-0000-7000-8000-000000000202"));

async function connections<T>(options: DemoOptions, run: (owner: Db, app: Db) => Promise<T>) {
  const ownerLocation = new URL(options.ownerUrl);
  const appLocation = new URL(options.appUrl);
  if (ownerLocation.host !== appLocation.host || ownerLocation.pathname !== appLocation.pathname)
    throw new Error("Demo connections must target the same database.");
  if (!Number.isFinite(options.today.getTime())) throw new Error("Invalid demo date.");
  const owner = connect(options.ownerUrl);
  const app = connect(options.appUrl);
  try {
    const [ownerRole] = await owner.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    const [appRole] = await app.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (ownerRole?.role !== "relay_owner" || appRole?.role !== "relay_app")
      throw new Error("Demo setup needs relay_owner and relay_app connections.");
    return await run(owner, app);
  } finally {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
}

async function demoLease<T>(owner: Db, run: (signal: AbortSignal) => Promise<T>) {
  const lease = await exclusiveJob(owner, "demo", run);
  if (!lease.ran) throw new Error("Demo setup or reset is already running.");
  return lease.result;
}

async function marker(owner: Db) {
  const rows = await owner.$queryRaw<{ key: string; company: string; state: string }[]>`
    SELECT key, company, state FROM demo_seed`;
  const row = rows[0];
  if (rows.length !== 1 || row?.key !== DEMO_KEY || row.company !== DEMO_COMPANY)
    throw new Error("This database was not created by the Tidewell demo seed.");
  return row;
}

async function demoTables(tx: Tx) {
  const tables = await tx.$queryRaw<{ name: string }[]>`
    SELECT tablename AS name FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('_prisma_migrations','demo_seed','job_leases') ORDER BY tablename`;
  return tables.map(({ name }) => `public."${name.replaceAll('"', '""')}"`);
}

async function seed(owner: Db, app: Db, options: DemoOptions, signal: AbortSignal) {
  await transact(owner, async (tx) => {
    for (const table of await demoTables(tx)) {
      const [row] = await tx.$queryRawUnsafe<{ occupied: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM ${table}) AS occupied`,
      );
      if (row?.occupied !== false) throw new Error("Seed requires an empty database.");
    }
    await tx.$executeRaw`INSERT INTO demo_seed(key,company,state,seeded_at)
      VALUES(${DEMO_KEY},${DEMO_COMPANY},'building',${options.today})
      ON CONFLICT(key) DO UPDATE SET state='building',seeded_at=EXCLUDED.seeded_at`;
    await tx.team.createMany({
      data: [
        { id: sales, name: "Sales", kind: "sales" },
        { id: accountsTeam, name: "Accounts", kind: "accounts" },
      ],
    });
    await tx.user.createMany({ data: STAFF.map((person) => ({ ...person, emailVerified: true })) });
    await tx.membership.createMany({
      data: STAFF.map((person) => ({
        userId: person.id,
        teamId: person.id === DEMO_PEOPLE.accountant.id ? accountsTeam : sales,
      })),
    });
    await tx.emailSuppression.create({
      data: { email: "leila.farouk@example.com", reason: "Invented demo suppression" },
    });
  });
  const [bounds] = await owner.$queryRaw<{ end: Date }[]>`
    SELECT (date_trunc('day', ${options.today}::timestamptz AT TIME ZONE ${options.timeZone ?? "UTC"})
        + interval '1 day') AT TIME ZONE ${options.timeZone ?? "UTC"} AS end`;
  const nextDay = required(bounds).end;
  const history = await owner.$queryRaw<{ at: Date }[]>`
    SELECT (((${options.today}::timestamptz AT TIME ZONE ${options.timeZone ?? "UTC"})::date
      - ago + time '09:00') AT TIME ZONE ${options.timeZone ?? "UTC"}) AS at
    FROM generate_series(14,1,-1) AS ago ORDER BY ago DESC`;
  let paymentTime = required(history[7]).at;
  const clock = () => paymentTime;
  const paymentTimes = new Map<PaymentId, Date>();
  const advance = (id: PaymentId) => {
    signal.throwIfAborted();
    paymentTime = new Date(required(paymentTimes.get(id)).getTime() + 1200000);
    paymentTimes.set(id, paymentTime);
  };
  const stories = new Map<LeadId, Date>();
  const storyTime = (id: LeadId) => {
    const at = new Date(required(stories.get(id)).getTime() + 1200000);
    stories.set(id, at);
    return at;
  };
  let leadNumber = 0;
  const store = openStore({ connectionString: options.appUrl, connection: app, clock });
  const actor = (name: string): Actor => {
    const person = required(STAFF.find((person) => person.name === name));
    return { userId: required(UserId.parse(person.id)), role: person.role, team: null };
  };
  const manager = actor("Priya Raman");
  const agent = actor("Dele Akinwale");
  const accountant = actor("Esther Okafor");
  const noor = actor("Noor Haddad");
  const ffion = actor("Ffion Pryce");
  const callum = actor("Callum Reid");
  const nameEmail = (name: string) => name.toLowerCase().replaceAll(" ", ".").replaceAll("-", "");
  const courses: Readonly<Record<string, string>> = {
    "IELTS evening": "IELTS evening · January intake",
    "Business English": "Business English · lunchtime online",
    "Spanish beginners": "Spanish beginners · weekend",
    "German A1": "German A1 · evening",
    "Summer school": "Summer school · early bird",
  };
  let phone = 140;
  async function lead(
    name: string,
    course: string,
    source: IntakeSource = "metaLeadAds",
    previous?: Actor,
  ) {
    signal.throwIfAborted();
    phone++;
    const number = leadNumber++;
    const createdAt = new Date(required(history[number % 7]).at.getTime() + (number % 12) * 900000);
    const email = parseEmail(`${nameEmail(name)}@example.com`);
    if (!email.ok) throw new Error("Invalid invented email.");
    const leadPhone = `+44 7700 900${String(phone)}`;
    const submit = (externalId: string, at: Date) =>
      store.intake({
        source,
        externalId: required(parseExternalId(externalId)),
        email: email.value,
        name,
        phone: leadPhone,
        attribution: normalizeAttribution({
          campaign: course === "No campaign" ? null : (courses[course] ?? course),
          form: course === "IELTS evening" ? "IELTS enquiry" : "Course enquiry",
          adSet: course === "IELTS evening" ? "London, age 25 to 40" : null,
          ad: course === "IELTS evening" ? "Band 7 in 8 weeks, video" : null,
        }),
        submittedAt: at,
        receivedAt: at,
        raw: { demo: true },
      });
    const result = await submit(`demo:${name}`, createdAt);
    if (result.outcome.kind !== "leadCreated")
      throw new Error("Seed intake did not create a lead.");
    const id = result.outcome.leadId;
    stories.set(id, createdAt);
    if (previous) {
      await assign(id, previous);
      await work(
        id,
        {
          kind: "attempt",
          attempt: {
            channel: "call",
            outcome: "noAnswer",
            note: "No answer to the earlier enquiry.",
          },
        },
        previous,
      );
      await work(
        id,
        { kind: "close", closing: { kind: "lost", note: "The earlier course date did not work." } },
        previous,
      );
      const reopened = await submit(`demo:reopen:${name}`, storyTime(id));
      if (reopened.outcome.kind !== "leadReopened")
        throw new Error("Demo enquiry did not reopen the lost lead.");
    }
    return id;
  }
  async function assign(id: LeadId, to = agent) {
    signal.throwIfAborted();
    await assignPool(
      app,
      manager,
      [id],
      { ownerId: to.userId, teamId: sales },
      randomUUID(),
      storyTime(id),
    );
  }
  const work = (id: LeadId, command: LeadWork, by = agent) => {
    signal.throwIfAborted();
    return workLead(app, by, { id, key: randomUUID(), work: command }, randomUUID(), storyTime(id));
  };
  const attempt = (id: LeadId, note: string, spoke: boolean, callbackAt?: Date) =>
    work(id, {
      kind: "attempt",
      attempt: {
        channel: "call",
        outcome: spoke ? "spokeToThem" : "noAnswer",
        note,
        ...(callbackAt ? { callback: { kind: "set", at: callbackAt } } : {}),
      },
    });
  const dueToday = new Date(nextDay.getTime() - 1);
  const queue = [
    {
      name: "Hye-jin Park",
      course: "IELTS evening",
      note: "Asked for a call after her night shift",
      spoke: true,
      callback: new Date(required(history[13]).at.getTime() + 1800000),
    },
    {
      name: "Mateus Carvalho",
      course: "Business English",
      note: "No answer",
      spoke: false,
      twice: true,
      callback: new Date(required(history[13]).at.getTime() + 6 * 3600000),
    },
    {
      name: "Sofia Lindgren",
      course: "Spanish beginners",
      note: "Wants the Saturday class times",
      spoke: true,
      callback: dueToday,
    },
    {
      name: "Anika Sharma",
      course: "IELTS evening",
      note: "No answer",
      spoke: false,
      callback: dueToday,
    },
    {
      name: "Kofi Mensah",
      course: "Business English",
      note: "Asked for the price in writing",
      spoke: true,
    },
    { name: "Amara Nwosu", course: "IELTS evening", note: "No answer", spoke: false, twice: true },
    { name: "Samir Fadel", course: "Spanish beginners" },
    { name: "Bashir Karimi", course: "German A1", source: "webForm" },
    {
      name: "Camille Laurent",
      course: "Summer school",
      note: "Booking for two people",
      spoke: true,
      callback: new Date(nextDay.getTime() + 10 * 3600000),
    },
    {
      name: "Ines Moreau",
      course: "German A1",
      note: "Deciding between two start dates",
      spoke: true,
      callback: new Date(nextDay.getTime() + 2 * day + 14.5 * 3600000),
    },
  ] as const;
  try {
    for (const item of queue) {
      const id = await lead(item.name, item.course, "source" in item ? item.source : "metaLeadAds");
      await assign(id);
      if ("note" in item) {
        if ("twice" in item) await attempt(id, "No answer", false);
        await attempt(id, item.note, item.spoke, "callback" in item ? item.callback : undefined);
      }
    }
    for (const [name, course, source, previous] of [
      ["Luca Ferraro", "Spanish beginners", "metaLeadAds"],
      ["Nadia Rahimi", "IELTS evening", "metaLeadAds"],
      ["Wei Chen", "IELTS evening", "metaLeadAds"],
      ["Zainab Yusuf", "Summer school", "metaLeadAds"],
      ["Tunde Bakare", "Summer school", "metaLeadAds", noor],
      ["Diego Salazar", "Spanish beginners", "metaLeadAds"],
      ["Ingrid Solberg", "German A1", "metaLeadAds"],
      ["Ravi Menon", "Summer school", "metaLeadAds", callum],
      ["Farah Siddiqui", "IELTS evening", "metaLeadAds"],
      ["Emil Novak", "IELTS evening", "metaLeadAds"],
      ["Oskar Nowak", "German A1", "metaLeadAds"],
      ["Thabo Nkosi", "Summer school", "metaLeadAds"],
      ["Chiara Russo", "Summer school", "metaLeadAds"],
      ["Marek Dvorak", "Summer school", "metaLeadAds"],
    ] as const)
      await lead(name, course, source, previous);
    const accountIds = new Map<string, AccountId>();
    const accountOpenedAt = new Map<string, Date>();
    for (const [name, course, owner] of [
      ["Jonas Weber", "Business English", agent],
      ["Aoife Brennan", "Spanish beginners", agent],
      ["Chiara Bianchi", "Spanish beginners", ffion],
      ["Hana Kobayashi", "Business English", agent],
      ["Isabela Duarte", "Summer school", agent],
      ["Leila Farouk", "IELTS evening", agent],
      ["Marek Novak", "IELTS evening", agent],
      ["Mireille Dubois", "Spanish beginners", noor],
      ["Pedro Alves", "German A1", agent],
      ["Tariq Aziz", "German A1", noor],
      ["Yusuf Demir", "German A1", agent],
    ] as const) {
      const id = await lead(name, course);
      await assign(id, owner);
      await work(
        id,
        {
          kind: "attempt",
          attempt: {
            channel: "call",
            outcome: "spokeToThem",
            note: "Confirmed the course and price.",
          },
        },
        owner,
      );
      const won = await work(id, { kind: "close", closing: { kind: "won" } }, owner);
      accountIds.set(name, required(won.accountId));
      accountOpenedAt.set(name, required(stories.get(id)));
    }
    const targets = [
      ["IELTS evening", "metaLeadAds", 142, 6, 97, 21],
      ["Business English", "metaLeadAds", 88, 0, 61, 9],
      ["Spanish beginners", "metaLeadAds", 76, 4, 49, 13],
      ["German A1", "metaLeadAds", 54, 2, 31, 6],
      ["Summer school", "metaLeadAds", 39, 11, 12, 1],
      ["German A1", "webForm", 8, 0, 7, 3],
      ["No campaign", "csv", 5, 0, 4, 1],
    ] as const;
    const existing = await store.campaignFunnel(manager);
    const firstNames = [
      "Amina",
      "Ben",
      "Celia",
      "Dario",
      "Elena",
      "Felix",
      "Greta",
      "Hugo",
      "Imani",
      "Jules",
      "Lina",
      "Marco",
      "Nia",
      "Omar",
      "Petra",
      "Rosa",
      "Soren",
      "Talia",
      "Vera",
      "Yara",
    ];
    const surnames = [
      "Abadi",
      "Berg",
      "Costa",
      "Diallo",
      "Evans",
      "Flores",
      "Gupta",
      "Hart",
      "Ibrahim",
      "Jensen",
      "Khan",
      "Lopes",
      "Martin",
      "Nilsen",
      "Ortiz",
      "Patel",
      "Quinn",
      "Reyes",
      "Silva",
      "Torres",
    ];
    const openQueues = [
      { actor: ffion, remaining: 9 },
      { actor: callum, remaining: 12 },
      { actor: noor, remaining: 7 },
    ];
    let generated = 0;
    for (const [course, source, received, unassigned, contacted, won] of targets) {
      const row = existing.rows.find(
        (row) => row.source === source && row.campaign === (courses[course] ?? null),
      );
      let waiting = unassigned - (row?.unassigned ?? 0);
      let conversations = contacted - (row?.contacted ?? 0);
      let wins = won - (row?.won ?? 0);
      if (Math.min(waiting, conversations, wins) < 0)
        throw new Error("Named demo stories exceed the campaign totals.");
      for (let n = row?.received ?? 0; n < received; n++) {
        const number = generated++;
        const name = `${required(firstNames[number % firstNames.length])} ${required(surnames[Math.floor(number / firstNames.length)])}`;
        const id = await lead(name, course, source);
        if (waiting > 0) {
          waiting--;
          continue;
        }
        const isWin = wins > 0;
        if (isWin) wins--;
        const open = isWin ? undefined : openQueues.find((queue) => queue.remaining > 0);
        if (open) open.remaining--;
        const owner = open?.actor ?? ffion;
        await assign(id, owner);
        const spoke = conversations > 0;
        if (spoke) conversations--;
        await work(
          id,
          {
            kind: "attempt",
            attempt: {
              channel: "call",
              outcome: spoke ? "spokeToThem" : "noAnswer",
              note: spoke
                ? "Discussed the course schedule and fees."
                : "No answer after the course enquiry.",
            },
          },
          owner,
        );
        if (open) continue;
        await work(
          id,
          {
            kind: "close",
            closing: isWin
              ? { kind: "won" }
              : { kind: "lost", note: "Chose a different course date." },
          },
          owner,
        );
      }
    }
    const deliveryStates = new Map<string, "failed" | "unknown">();
    const occurrences = new Map<string, number>();
    const startPayment = (name: string) => {
      signal.throwIfAborted();
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const firstDay = history.findIndex((slot) => slot.at > required(accountOpenedAt.get(name)));
      if (firstDay < 0) throw new Error("Demo account opened outside its history.");
      const index = required([Math.max(4, firstDay), 9, 12, 13][occurrence]);
      const slot = [...accountIds.keys()].indexOf(name) % 5;
      paymentTime = new Date(required(history[index]).at.getTime() + slot * 1800000);
    };
    let command = 0;
    async function manual(name: string, amount: bigint, kind: "first" | "repeat", by = agent) {
      command++;
      startPayment(name);
      const payment = await store.recordManualPayment(
        by,
        {
          key: `demo:manual:${String(command)}`,
          accountId: required(accountIds.get(name)),
          money: { minor: amount, currency: "GBP" },
          kind,
          receiptHash: hash(`invented-receipt-${String(command)}`),
          reference: `${name.toLowerCase().replaceAll(" ", "-")}-transfer.pdf`,
        },
        randomUUID(),
      );
      paymentTimes.set(payment.id, paymentTime);
      return payment;
    }
    const approve = (id: PaymentId, by: Actor, version = 0) => {
      advance(id);
      return store.approveManualPayment(by, { id, version, roleVersion: 0 }, randomUUID());
    };
    async function completedManual(
      name: string,
      amount: bigint,
      kind: "first" | "repeat",
      reverse = false,
      by = agent,
    ) {
      const payment = await manual(name, amount, kind, by);
      await approve(payment.id, reverse ? accountant : manager);
      await approve(payment.id, reverse ? manager : accountant);
      return payment.id;
    }
    async function card(
      name: string,
      amount: bigint,
      kind: "first" | "repeat",
      mode: SandboxMode,
      by = manager,
      expired = false,
    ) {
      startPayment(name);
      const money = { minor: amount, currency: "GBP" } as const;
      const payment = await store.createPayment(
        by,
        { key: randomUUID(), accountId: required(accountIds.get(name)), money, kind, mode },
        0,
        randomUUID(),
      );
      const terms = await store.checkoutTerms(by, payment.id);
      const checkout = await store.createSandboxCheckout({
        ...terms,
        expiresAt: expired
          ? new Date(paymentTime.getTime() + 300000)
          : new Date(nextDay.getTime() + day),
      });
      paymentTimes.set(payment.id, paymentTime);
      return { id: payment.id, money, token: required(checkout.token) };
    }
    async function observe(
      id: PaymentId,
      money: { readonly minor: bigint; readonly currency: "GBP" },
      status: "completed" | "expired" = "completed",
    ) {
      advance(id);
      return store.receivePaymentWebhook({
        paymentId: id,
        eventId: randomUUID(),
        payloadHash: hash(id),
        observed: { status, money },
      });
    }
    const retrying = await completedManual("Jonas Weber", 39500n, "first");
    deliveryStates.set(retrying, "failed");
    await completedManual("Jonas Weber", 39500n, "repeat", true);
    const recovered = await card("Jonas Weber", 39500n, "repeat", "drop");
    await store.paySandboxCheckout(recovered.token);
    advance(recovered.id);
    const token = required(await store.claimPaymentCheck(recovered.id, clock(), 60000));
    const paid = required(await store.getSandboxCheckout(recovered.id));
    await store.finishPaymentCheck(recovered.id, token, {
      status: "completed",
      money: { minor: paid.amount, currency: "GBP" },
    });
    await observe(recovered.id, recovered.money);
    const duplicate = await card("Hana Kobayashi", 39500n, "first", "twice");
    await store.paySandboxCheckout(duplicate.token);
    const event = {
      paymentId: duplicate.id,
      eventId: randomUUID(),
      payloadHash: hash(duplicate.id),
      observed: { status: "completed", money: duplicate.money },
    } as const;
    advance(duplicate.id);
    await store.receivePaymentWebhook(event);
    advance(duplicate.id);
    await store.receivePaymentWebhook(event);
    deliveryStates.set(duplicate.id, "unknown");
    const exhausted = await completedManual("Hana Kobayashi", 39500n, "repeat");
    deliveryStates.set(exhausted, "failed");
    await completedManual("Aoife Brennan", 48000n, "first");
    await completedManual("Chiara Bianchi", 24000n, "first", false, ffion);
    await completedManual("Mireille Dubois", 39500n, "first", false, noor);
    await completedManual("Pedro Alves", 48000n, "first");
    const suppressed = await card("Leila Farouk", 72000n, "first", "normal");
    await store.paySandboxCheckout(suppressed.token);
    await observe(suppressed.id, suppressed.money);
    const mismatch = await card("Jonas Weber", 39500n, "repeat", "normal");
    await store.paySandboxCheckout(mismatch.token);
    await observe(mismatch.id, { minor: 35900n, currency: "GBP" });
    const late = await card("Tariq Aziz", 48000n, "first", "drop", noor, true);
    advance(late.id);
    const expiryCheck = required(await store.claimPaymentCheck(late.id, clock(), 60000));
    await store.finishPaymentCheck(late.id, expiryCheck, { status: "expired", money: late.money });
    await observe(late.id, late.money);
    const expired = await card("Tariq Aziz", 48000n, "first", "drop", noor, true);
    await observe(expired.id, expired.money, "expired");
    await card("Marek Novak", 48000n, "first", "normal", agent);
    await card("Chiara Bianchi", 24000n, "repeat", "normal", ffion);
    const yusuf = await manual("Yusuf Demir", 47900n, "first", actor("Tomasz Zielinski"));
    advance(yusuf.id);
    await store.editManualPayment(
      agent,
      {
        id: yusuf.id,
        version: 0,
        money: { minor: 48000n, currency: "GBP" },
        receiptHash: hash("yusuf-corrected"),
        reference: "yusuf-demir-transfer.pdf",
      },
      randomUUID(),
    );
    await approve(yusuf.id, manager, 1);
    await manual("Isabela Duarte", 115000n, "first");
    const mireille = await manual("Mireille Dubois", 39500n, "repeat", noor);
    const pedro = await manual("Pedro Alves", 24000n, "repeat");
    advance(pedro.id);
    await store.decideManualPayment(
      accountant,
      {
        id: pedro.id,
        version: 0,
        decision: "reject",
        reason: "The invented receipt does not match the bank transfer.",
      },
      randomUUID(),
    );
    await manual("Aoife Brennan", 24000n, "repeat", actor("Tomasz Zielinski"));
    await approve(mireille.id, accountant);
    const delivery: ReceiptDelivery = async (message, signal) => {
      const state = deliveryStates.get(message.paymentId);
      return state
        ? {
            state,
            reason:
              state === "failed"
                ? "Invented SMTP connection refusal."
                : "Invented connection loss after DATA. Delivery is unknown.",
          }
        : options.deliver(message, signal);
    };
    const receiptStart = new Date(required(history[13]).at.getTime() + 6 * 3600000);
    await store.runOutbox(delivery, { at: receiptStart, signal });
    await transact(app, (tx) =>
      tx.outbox.update({ where: { paymentId: retrying }, data: { nextAttemptAt: dueToday } }),
    );
    for (let cycle = 0; cycle < 3; cycle++) {
      const cycleStart = receiptStart.getTime() + cycle * 45 * 60000;
      if (cycle > 0) {
        paymentTime = new Date(cycleStart);
        await store.requeueReceipt(manager, exhausted, randomUUID());
        await store.runOutbox(delivery, { at: paymentTime, signal });
      }
      for (const minutes of [5, 15, 35])
        await store.runOutbox(delivery, { at: new Date(cycleStart + minutes * 60000), signal });
    }
    await transact(
      owner,
      (tx) => tx.$executeRaw`UPDATE demo_seed SET state='ready' WHERE key=${DEMO_KEY}`,
    );
    return { changed: true, company: DEMO_COMPANY };
  } finally {
    await store.close();
  }
}

export function seedDemo(options: DemoOptions) {
  return connections(options, async (owner, app) => {
    const rows = await owner.$queryRaw<{ state: string }[]>`SELECT state FROM demo_seed`;
    if (rows.length) {
      const row = await marker(owner);
      if (row.state !== "ready") return resetDemo({ ...options, demo: true });
      return { changed: false, company: DEMO_COMPANY };
    }
    return demoLease(owner, (signal) => seed(owner, app, options, signal));
  });
}

export function resetDemo(options: DemoOptions & { readonly demo: boolean }) {
  if (!options.demo) throw new Error("Demo reset requires RELAY_DEMO=1.");
  return connections(options, async (owner, app) => {
    await marker(owner);
    return demoLease(owner, async (demoSignal) => {
      const reconcile = await exclusiveJob(owner, "reconcile", async (reconcileSignal) => {
        const outbox = await exclusiveJob(owner, "outbox", async (outboxSignal) => {
          const signal = AbortSignal.any([demoSignal, reconcileSignal, outboxSignal]);
          signal.throwIfAborted();
          return transact(
            owner,
            async (tx) => {
              await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
              await tx.$executeRaw`UPDATE demo_seed SET state='building' WHERE key=${DEMO_KEY}`;
              const names = await demoTables(tx);
              // Immutable history is discarded only inside this owner transaction on a marked demo database.
              for (const name of names)
                await tx.$executeRawUnsafe(`ALTER TABLE ${name} DISABLE TRIGGER USER`);
              await tx.$executeRawUnsafe(`TRUNCATE ${names.join(",")} RESTART IDENTITY`);
              for (const name of names)
                await tx.$executeRawUnsafe(`ALTER TABLE ${name} ENABLE TRIGGER USER`);
              return seed(
                transactionConnection(owner, tx),
                transactionConnection(app, tx),
                options,
                signal,
              );
            },
            { timeoutMs: 180000, maxAttempts: 1 },
          );
        });
        if (!outbox.ran) throw new Error("Receipt delivery is running. Retry the reset.");
        return outbox.result;
      });
      if (!reconcile.ran) throw new Error("Reconciliation is running. Retry the reset.");
      return reconcile.result;
    });
  });
}

export async function demoSchedule(ownerUrl: string, timeZone: string, at = new Date()) {
  const owner = connect(ownerUrl);
  try {
    const rows = await owner.$queryRaw<{ seededAt: Date; start: Date; next: Date }[]>`
      SELECT seeded_at AS "seededAt",
        date_trunc('day', ${at}::timestamptz AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone} AS start,
        (date_trunc('day', ${at}::timestamptz AT TIME ZONE ${timeZone}) + interval '1 day') AT TIME ZONE ${timeZone} AS next
      FROM demo_seed WHERE key=${DEMO_KEY}`;
    return required(rows[0]);
  } finally {
    await owner.$disconnect();
  }
}
