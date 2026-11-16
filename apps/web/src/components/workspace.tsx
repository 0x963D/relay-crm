"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Outputs } from "@/lib/api";
import { api } from "@/lib/api";
import { authFailure } from "@/lib/failures";
import { Avatar, Brand, Empty, Refusal } from "./pieces";
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
  available: boolean;
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
  const defaultView = profile.role === "agent" ? "queue" : isManager ? "pool" : "payments";
  const view = params.get("view") ?? defaultView;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav: Nav[] = [
    ...(isManager
      ? [
          { id: "pool", label: "Lead pool", icon: "inbox" as const, available: true },
          { id: "queue", label: "Agent queues", icon: "queue" as const, available: true },
        ]
      : profile.role === "agent"
        ? [{ id: "queue", label: "My queue", icon: "queue" as const, available: true }]
        : []),
    { id: "payments", label: "Payments", icon: "payments", available: false },
    { id: "accounts", label: "Accounts", icon: "accounts", available: false },
    ...(isManager
      ? [{ id: "funnel", label: "Campaign funnel", icon: "funnel" as const, available: false }]
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
  const sections = (
    <nav className="nav" aria-label="Main">
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
        </a>
      ))}
    </nav>
  );
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
            {["manager", "agent", "accountant"].map((role) => (
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
        {sections}
        <div className="rail-end">
          <div className="me">
            <Avatar name={profile.name} large carbon />
            <div className="me-details">
              <div className="me-name">{profile.name}</div>
              <div className="me-role">
                {roleNames[profile.role]}
                {profile.teams?.find((t) => t.id === profile.team?.id)?.name
                  ? ` · ${profile.teams.find((t) => t.id === profile.team?.id)?.name ?? ""}`
                  : ""}
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
            aria-label={`${profile.name
              .split(" ")
              .map((part) => part[0])
              .slice(0, 2)
              .join("")}, sign out ${profile.name}`}
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
          />
        ) : view === "pool" && isManager ? (
          <PoolScreen initialAgents={agents} zone={zone} />
        ) : (
          <>
            <header className="ph">
              <h1>{nav.find((n) => n.id === view)?.label ?? "Workspace"}</h1>
            </header>
            <Empty icon="info" title="This view is unavailable">
              Use the navigation to open an available workspace.
            </Empty>
          </>
        )}
        <nav className="mobile-nav" aria-label="Workspace">
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
            </a>
          ))}
        </nav>
      </SidebarInset>
    </SidebarProvider>
  );
}
