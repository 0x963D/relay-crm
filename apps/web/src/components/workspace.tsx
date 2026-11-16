"use client";
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
  agents,
  demo,
  zone,
}: {
  profile: Profile;
  agents: Outputs["leads"]["agents"];
  demo: boolean;
  zone: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const isManager = ["owner", "admin", "manager", "teamLead"].includes(profile.role);
  const defaultView = profile.role === "agent" ? "queue" : "pool";
  const requestedView = params.get("view");
  const view =
    requestedView === "queue" || (requestedView === "pool" && isManager)
      ? requestedView
      : defaultView;
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
      <nav className={mobile ? "mobile-nav" : "nav"} aria-label={mobile ? "Workspace" : "Main"}>
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
              <span className="nav-count">{poolTotal}</span>
            )}
            {!mobile && item.id === "queue" && profile.role === "agent" && queueTotal !== null && (
              <span className="nav-count">{queueTotal}</span>
            )}
          </a>
        ))}
      </nav>
    );
  }
  return (
    <SidebarProvider className={demo ? "" : "shell--live"}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      {demo && (
        <header className="demo">
          <span className="demo-tag">
            <Icon name="eye" size="small" />
            Demo
          </span>
          <span className="demo-copy">Invented data. It resets every night.</span>
          <span className="demo-sp" />
          <span className="demo-copy">You are viewing as</span>
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
        <div className="rail-end">
          <div className="me">
            <Avatar name={profile.name} large carbon />
            <div className="me-details">
              <div className="me-name">{profile.name}</div>
              <div className="me-role">
                {roleNames[profile.role]}
                {teamName ? ` � ${teamName}` : ""}
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
        <div className="mobile-identity">
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
        {error && (
          <div className="pad">
            <Refusal>{error}</Refusal>
          </div>
        )}
        {profile.teams && profile.teams.length > 1 && (
          <label className="row team-selection">
            <span className="label">Current team</span>
            <select
              className="input"
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
            </select>
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
