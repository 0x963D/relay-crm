-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "role" AS ENUM ('owner', 'admin', 'manager', 'teamLead', 'agent', 'accountant');

-- CreateEnum
CREATE TYPE "team_kind" AS ENUM ('sales', 'accounts');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('new', 'assigned', 'working', 'won', 'lost', 'dead');

-- CreateEnum
CREATE TYPE "work_stage" AS ENUM ('contacted', 'callBack', 'noAnswer');

-- CreateEnum
CREATE TYPE "lost_reason" AS ENUM ('notInterested', 'noBudget', 'choseCompetitor', 'badTiming', 'other');

-- CreateEnum
CREATE TYPE "dead_reason" AS ENUM ('duplicate', 'wrongNumber', 'doNotContact');

-- CreateEnum
CREATE TYPE "intake_source" AS ENUM ('metaLeadAds', 'webForm', 'csv', 'manual');

-- CreateEnum
CREATE TYPE "intake_outcome" AS ENUM ('leadCreated', 'attachedToOpenLead', 'leadReopened', 'linkedToAccount', 'suppressedDoNotContact', 'rejectedNoEmail');

-- CreateEnum
CREATE TYPE "activity_kind" AS ENUM ('intake', 'statusChange');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "team_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id","team_id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "email_key" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "status" "lead_status" NOT NULL,
    "owner_id" UUID,
    "team_id" UUID,
    "stage" "work_stage",
    "call_back_at" TIMESTAMPTZ(3),
    "no_answer_count" INTEGER,
    "lost_reason" "lost_reason",
    "dead_reason" "dead_reason",
    "account_id" UUID,
    "first_assigned_at" TIMESTAMPTZ(3),
    "previous_owner_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_events" (
    "id" UUID NOT NULL,
    "source" "intake_source" NOT NULL,
    "external_id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "campaign" TEXT,
    "ad_set" TEXT,
    "ad" TEXT,
    "form" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "raw" JSON NOT NULL,
    "outcome" "intake_outcome" NOT NULL,
    "lead_id" UUID,
    "account_id" UUID,

    CONSTRAINT "intake_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "kind" "activity_kind" NOT NULL,
    "lead_id" UUID,
    "account_id" UUID,
    "intake_event_id" UUID,
    "detail" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_team_id_idx" ON "memberships"("team_id");

-- CreateIndex
CREATE INDEX "accounts_owner_id_idx" ON "accounts"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_email_key_key" ON "leads"("email_key");

-- CreateIndex
CREATE UNIQUE INDEX "leads_account_id_key" ON "leads"("account_id");

-- CreateIndex
CREATE INDEX "leads_created_at_id_idx" ON "leads"("created_at", "id");

-- CreateIndex
CREATE INDEX "leads_owner_id_created_at_id_idx" ON "leads"("owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "leads_team_id_created_at_id_idx" ON "leads"("team_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "intake_events_lead_id_idx" ON "intake_events"("lead_id");

-- CreateIndex
CREATE INDEX "intake_events_account_id_idx" ON "intake_events"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "intake_events_source_external_id_key" ON "intake_events"("source", "external_id");

-- CreateIndex
CREATE INDEX "activities_lead_id_id_idx" ON "activities"("lead_id", "id");

-- CreateIndex
CREATE INDEX "activities_account_id_id_idx" ON "activities"("account_id", "id");

-- CreateIndex
CREATE INDEX "activities_intake_event_id_idx" ON "activities"("intake_event_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_previous_owner_id_fkey" FOREIGN KEY ("previous_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_intake_event_id_fkey" FOREIGN KEY ("intake_event_id") REFERENCES "intake_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
