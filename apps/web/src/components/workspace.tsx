"use client";
import { useQuery } from "@tanstack/react-query";
import { workspaceView, isLeadManager } from "@/lib/workspace";
import { reads } from "@/lib/reads";
import { failureMessage } from "@/lib/failures";
import { NativeSelect } from "./ui/native-select";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Outputs } from "@/lib/api";
import { api } from "@/lib/api";
import { authFailure } from "@/lib/failures";
import { Avatar, Brand, Refusal } from "./pieces";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Sidebar, SidebarInset, SidebarProvider } from "./ui/sidebar";
import { ThemeSwitch } from "./theme-switch";
import { PoolScreen } from "./pool";
import { QueueScreen, type Profile } from "./queue";
const roleNames = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  teamLead: "Team lead",
  agent: "Agent",
  accountant: "Accountant",
};
interface Nav {
  id: string;
  label: string;
  icon: IconName;
}
export function Workspace({
  profile,
  agents: initialAgents,
  demo,
  zone,
}: {
  profile: Profile;
  agents: Outputs["leads"]["agents"];
  demo: boolean;
  zone: string;
}) {
  const people = useQuery(reads.agents());
  const agents = people.data ?? initialAgents;
  const router = useRouter();
  const params = useSearchParams();
  const isManager = isLeadManager(profile.role);
  const view = workspaceView(profile.role, params.get("view"));
  const [pending, setPending] = useState(false);
  const [poolTotal, setPoolTotal] = useState<number | null>(null);
  const [queueTotal, setQueueTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nav: Nav[] = [
    ...(isManager
      ? [
          { id: "pool", label: "Lead pool", icon: "inbox" as const },
          { id: "queue", label: "Agent queues", icon: "queue" as const },
        ]
      : profile.role === "agent"
        ? [{ id: "queue", label: "My queue", icon: "queue" as const }]
        : []),
  ];
  async function switchRole(role: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (response.ok) {
        location.assign("/");
        return;
      }
      setError(await authFailure(response, "demo"));
    } catch {
      setError(await authFailure(null, "demo"));
    } finally {
      setPending(false);
    }
  }
  async function signOut() {
    setPending(true);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.ok) location.assign("/");
      else setError("You could not sign out. Try again.");
    } catch {
      setError("You could not sign out. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }
  const teamName = profile.teams?.find((team) => team.id === profile.team?.id)?.name;
  function navigation(mobile = false) {
    return (
      <nav
        className={
          mobile
            ? "mobile-nav hidden max-phone:flex max-phone:flex-wrap max-phone:gap-related max-phone:p-content max-phone:[border-block-start:1px_solid_var(--color-rule)] max-phone:[&_a]:flex max-phone:[&_a]:items-center max-phone:[&_a]:gap-compact max-phone:[&_a]:p-related max-phone:[&_a]:min-h-[44px] max-phone:[&_a]:[font-size:13px] max-phone:[&_a[aria-current='page']]:text-primary max-phone:[&_a[aria-current='page']]:bg-selected max-phone:[&_a[aria-current='page']]:rounded-control"
            : "nav flex flex-col gap-[2px] [&_a]:flex [&_a]:items-center [&_a]:gap-control [&_a]:h-[36px] [&_a]:px-control [&_a]:[border-radius:7px] [&_a]:text-shell-secondary [&_a]:[text-decoration:none] [&_a]:text-(length:--text-body) [&_a]:font-[560] [&_a:hover]:bg-shell-hover [&_a:hover]:text-shell-foreground [&_a[aria-current='page']]:bg-surface [&_a[aria-current='page']]:text-primary [&_a[aria-current='page']]:font-[650] dark:[&_a[aria-current='page']]:text-foreground max-phone:[.rail_&]:hidden"
        }
        aria-label={mobile ? "Workspace" : "Main"}
      >
        {nav.map((item) => (
          <a
            key={item.id}
            href={`/?view=${item.id}`}
            aria-current={view === item.id ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              router.push(`/?view=${item.id}`);
            }}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {!mobile && item.id === "pool" && poolTotal !== null && (
              <span className="nav-count ms-auto text-(length:--text-caption) font-[600]">
                {poolTotal}
              </span>
            )}
            {!mobile && item.id === "queue" && profile.role === "agent" && queueTotal !== null && (
              <span className="nav-count ms-auto text-(length:--text-caption) font-[600]">
                {queueTotal}
              </span>
            )}
          </a>
        ))}
      </nav>
    );
  }
  return (
    <SidebarProvider
      className={demo ? "" : "shell--live [grid-template-rows:1fr] pt-control max-phone:pt-0"}
    >
      <a
        className="skip fixed [inset-block-start:4px] [inset-inline-start:8px] [z-index:10] [transform:translateY(-200%)] bg-surface text-primary p-related [&:focus]:[transform:none]"
        href="#main"
      >
        Skip to content
      </a>
      {demo && (
        <header className="demo [grid-column:1_/_-1] flex items-center gap-group px-[18px_12px] text-shell-secondary text-(length:--text-small) [&_form]:contents max-phone:min-h-[44px] max-phone:px-[16px_10px] max-phone:gap-compact">
          <span className="demo-tag inline-flex items-center gap-compact text-shell-foreground font-[600]">
            <Icon name="eye" size="small" />
            Demo
          </span>
          <span className="demo-copy max-phone:hidden">Invented data. It resets every night.</span>
          <span className="demo-sp flex-1" />
          <span className="demo-copy max-phone:hidden">You are viewing as</span>
          <ToggleGroup
            type="single"
            aria-label="View the demo as"
            value={profile.role}
            onValueChange={(value) => {
              if (value && value !== profile.role) void switchRole(value);
            }}
          >
            {["manager", "agent"].map((role) => (
              <ToggleGroupItem value={role} key={role} disabled={pending}>
                {role[0]?.toUpperCase()}
                {role.slice(1)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </header>
      )}
      <Sidebar>
        <Brand />
        {navigation()}
        <div className="rail-end mt-auto max-phone:hidden">
          <div className="me flex items-center gap-control p-[10px_6px_0] [border-block-start:1px_solid_var(--color-shell-border)] flex-wrap max-phone:[.rail_&]:hidden">
            <Avatar name={profile.name} large carbon />
            <div className="me-details flex-1 min-w-0">
              <div className="me-name font-[600] text-(length:--text-small) leading-[16px]">
                {profile.name}
              </div>
              <div className="me-role text-(length:--text-caption) leading-[15px] text-shell-secondary">
                {roleNames[profile.role]}
                {teamName ? ` · ${teamName}` : ""}
              </div>
              <ThemeSwitch />
            </div>
            <Button
              variant="ghost"
              size="icon"
              disabled={pending}
              aria-label="Sign out"
              onClick={() => {
                void signOut();
              }}
            >
              <Icon name="logout" />
            </Button>
          </div>
        </div>
        <div className="mobile-identity max-phone:flex max-phone:gap-related max-phone:items-center hidden">
          <ThemeSwitch />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Sign out ${profile.name}`}
            disabled={pending}
            onClick={() => {
              void signOut();
            }}
          >
            <Avatar name={profile.name} large carbon />
          </Button>
        </div>
      </Sidebar>
      <SidebarInset>
        {people.isError && (
          <div className="p-pane">
            <Refusal title="Agents could not be loaded">
              {failureMessage(people.error, "read")}
            </Refusal>
          </div>
        )}
        {error && (
          <div className="pad p-[18px_24px] max-phone:p-content">
            <Refusal>{error}</Refusal>
          </div>
        )}
        {profile.teams && profile.teams.length > 1 && (
          <label className="row flex items-center gap-related max-phone:[.lead-body_&]:flex-wrap max-phone:[.pool-panel_label&]:min-h-[44px] team-selection p-[12px_24px]">
            <span className="label text-(length:--text-small) font-[600]">Current team</span>
            <NativeSelect
              className="input flex items-center gap-related h-[36px] px-control border-[1px] border-solid border-control-border rounded-control bg-surface text-foreground text-(length:--text-body) [.sign-sheet_&]:h-[44px] [.sign-sheet_&]:w-full max-phone:min-h-[44px] [&:focus-visible]:[outline:none] [&:focus-visible]:border-primary [&:focus-visible]:[box-shadow:0_0_0_3px_var(--color-selected)]"
              value={profile.team?.id ?? ""}
              onChange={(event) => {
                void api.session.selectTeam.mutate({ teamId: event.target.value || null }).then(
                  () => {
                    location.reload();
                  },
                  () => {
                    setError("The team could not be selected. Refresh and try again.");
                  },
                );
              }}
            >
              <option value="">Choose a team</option>
              {profile.teams.map((team) => (
                <option value={team.id} key={team.id}>
                  {team.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        {view === "queue" && (isManager || profile.role === "agent") ? (
          <QueueScreen
            key={params.get("agent") ?? profile.userId}
            profile={profile}
            agents={agents}
            zone={zone}
            onTotalChange={setQueueTotal}
          />
        ) : (
          <PoolScreen initialAgents={agents} zone={zone} onTotalChange={setPoolTotal} />
        )}
        {navigation(true)}
      </SidebarInset>
    </SidebarProvider>
  );
}
