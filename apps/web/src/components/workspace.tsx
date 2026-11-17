"use client";
import { type ReactNode, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import type { Outputs } from "@/lib/api";
import { isLeadManager } from "@/lib/workspace";
import { authFailure } from "@/lib/failures";
import { Avatar, Brand, Refusal } from "./pieces";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { Field } from "./ui/field";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Sidebar } from "./ui/sidebar";
import { ThemeSwitch } from "./theme-switch";
const roleNames = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  teamLead: "Team lead",
  agent: "Agent",
  accountant: "Accountant",
};
const poolCount = (data: Outputs["leads"]["pool"]) => data.total;
const agentCount = (data: Outputs["leads"]["agents"]) =>
  new Set(data.map((agent) => agent.ownerId)).size;
const queueCount = (data: Outputs["leads"]["queue"]) =>
  Object.values(data.counts).reduce((sum, n) => sum + n, 0);
const paymentCount = (data: Outputs["payments"]["list"]) =>
  data.counts.needsReview + data.counts.waitingForApproval + data.counts.waitingForProvider;
const accountCount = (data: Outputs["accounts"]["list"]) => data.total;
export function Workspace({
  profile,
  demo,
  children,
}: {
  profile: Outputs["session"]["profile"];
  demo: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const trpc = useTRPC();
  const client = useQueryClient();
  const manager = isLeadManager(profile.role);
  const poolTotal = useQuery(
    trpc.leads.pool.queryOptions({ limit: 14, offset: 0 }, { enabled: manager, select: poolCount }),
  ).data;
  const agentTotal = useQuery(
    trpc.leads.agents.queryOptions({ offset: 0 }, { enabled: manager, select: agentCount }),
  ).data;
  const queueTotal = useQuery(
    trpc.leads.queue.queryOptions(
      { agentId: profile.userId, limit: 20 },
      { enabled: profile.role === "agent", select: queueCount },
    ),
  ).data;
  const counts: Record<string, number | undefined> = {
    "/pool": poolTotal,
    "/agents": agentTotal,
    "/queue": queueTotal,
    "/payments": useQuery(
      trpc.payments.list.queryOptions({ limit: 20, offset: 0 }, { select: paymentCount }),
    ).data,
    "/accounts": useQuery(
      trpc.accounts.list.queryOptions({ limit: 20, offset: 0 }, { select: accountCount }),
    ).data,
  };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectTeam = useMutation(
    trpc.session.selectTeam.mutationOptions({
      onSuccess: async () => {
        await client.invalidateQueries();
        router.refresh();
      },
      onError: () => {
        setError("The team could not be selected. Refresh and try again.");
      },
    }),
  );
  const nav: { href: string; label: string; icon: IconName }[] = isLeadManager(profile.role)
    ? [
        { href: "/pool", label: "Lead pool", icon: "inbox" },
        { href: "/agents", label: "Agent queues", icon: "queue" },
      ]
    : profile.role === "agent"
      ? [{ href: "/queue", label: "My queue", icon: "queue" }]
      : [];
  nav.push(
    { href: "/payments", label: "Payments", icon: "payments" },
    { href: "/accounts", label: "Accounts", icon: "accounts" },
  );
  if (["owner", "admin", "manager"].includes(profile.role))
    nav.push({ href: "/funnel", label: "Campaign funnel", icon: "funnel" });
  async function authAction(role?: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(role ? "/api/auth/demo" : "/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(role ? { role } : {}),
      });
      if (response.ok) location.assign("/");
      else
        setError(role ? await authFailure(response, "demo") : "You could not sign out. Try again.");
    } catch {
      setError("The server could not be reached. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }
  const navigation = (
    <nav aria-label="Main" className="flex gap-1 md:flex-col">
      {nav.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname.startsWith(item.href) ? "page" : undefined}
          className="relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-xs font-medium md:min-h-9 md:flex-none md:flex-row md:justify-start md:gap-2 md:px-3 md:text-sm text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground aria-[current=page]:bg-background aria-[current=page]:text-primary"
        >
          <Icon name={item.icon} />
          <span aria-hidden="true" className="md:hidden">
            {
              {
                "/pool": "Pool",
                "/agents": "Queues",
                "/queue": "Queue",
                "/payments": "Payments",
                "/accounts": "Accounts",
                "/funnel": "Funnel",
              }[item.href]
            }
          </span>
          <span className="sr-only md:not-sr-only">{item.label}</span>
          {counts[item.href] !== undefined && (
            <span
              aria-hidden="true"
              data-slot="nav-count"
              className="absolute end-1 top-1 text-xs tabular-nums md:static md:ms-auto md:text-caption"
            >
              {counts[item.href]}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
  const team = profile.teams?.find((value) => value.id === profile.team?.id);
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-sidebar">
      <a
        href="#main"
        className="fixed start-2 top-1 z-50 -translate-y-20 rounded bg-background p-2 text-primary focus:translate-y-0"
      >
        Skip to content
      </a>
      {demo && (
        <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-3 px-4 text-caption text-sidebar-muted">
          <span className="flex items-center gap-1.5 font-semibold text-sidebar-foreground">
            <Icon name="eye" size="small" />
            Demo
          </span>
          <span className="hidden sm:inline">Invented data. It resets every night.</span>
          <span className="flex-1" />
          <span className="hidden lg:inline">You are viewing as</span>
          <ToggleGroup
            type="single"
            aria-label="View the demo as"
            value={profile.demoRole ?? ""}
            className="rounded-lg bg-sidebar-accent p-1"
            onValueChange={(value) => {
              if (value && value !== profile.demoRole) void authAction(value);
            }}
          >
            {["manager", "agent", "accountant"].map((role) => (
              <ToggleGroupItem
                key={role}
                value={role}
                disabled={pending}
                className="h-7 px-2 text-xs text-sidebar-muted data-[state=on]:bg-background data-[state=on]:text-foreground sm:px-3 sm:text-sm"
              >
                {role[0]?.toUpperCase()}
                {role.slice(1)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </header>
      )}
      <section
        aria-label="Workspace controls"
        className="flex shrink-0 items-center gap-3 px-4 py-3 md:hidden"
      >
        <div className="flex-1">
          <Brand />
        </div>
        <ThemeSwitch />
        <Button
          variant="ghost"
          size="icon"
          className="text-sidebar-foreground"
          aria-label="Sign out"
          busy={pending}
          onClick={() => void authAction()}
        >
          <Icon name="logout" />
        </Button>
      </section>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar className="hidden w-rail shrink-0 px-3.5 pb-3 pt-3 md:flex">
          <div className="px-1.5 pb-6">
            <Brand />
          </div>
          {navigation}
          <div className="mt-auto border-t border-sidebar-border pt-3 text-sidebar-foreground">
            <div className="flex items-center gap-2">
              <Avatar name={profile.name} large carbon />
              <div className="min-w-0 flex-1">
                <p className="text-caption font-semibold">{profile.name}</p>
                <p className="whitespace-nowrap text-xs text-sidebar-muted">
                  {roleNames[profile.role]}
                  {team ? ` · ${team.name}` : ""}
                </p>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <ThemeSwitch />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                busy={pending}
                onClick={() => void authAction()}
              >
                <Icon name="logout" />
              </Button>
            </div>
          </div>
        </Sidebar>
        <main
          id="main"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-t-xl bg-background md:me-2.5 md:mb-2.5 md:rounded-xl"
        >
          {error && (
            <div className="p-4">
              <Refusal>{error}</Refusal>
            </div>
          )}
          {!!profile.teams && profile.teams.length > 1 && (
            <Field
              label="Current team"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b px-6 py-2"
            >
              {(control) => (
                <NativeSelect
                  {...control}
                  value={profile.team?.id ?? ""}
                  disabled={selectTeam.isPending}
                  onChange={(event) => {
                    selectTeam.mutate({ teamId: event.target.value || null });
                  }}
                >
                  <option value="">Choose a team</option>
                  {profile.teams?.map((value) => (
                    <option value={value.id} key={value.id}>
                      {value.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          {children}
        </main>
      </div>
      {!!nav.length && <div className="shrink-0 px-3 py-1 md:hidden">{navigation}</div>}
    </div>
  );
}
