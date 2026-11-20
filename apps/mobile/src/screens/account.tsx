import { useState } from "react";
import { Alert, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { failureFrom } from "../api/client.ts";
import { useReadOptions } from "../api/use-read-options.ts";
import { readFailureText } from "../core/failure.ts";
import { RemoveSignIn } from "../ui/remove-sign-in.tsx";
import { server } from "../api/server.ts";
import { useSession } from "../api/session-provider.tsx";
import { contextualDate, zoneName } from "../core/dates.ts";
import { storedCounts } from "../core/write-presentation.ts";
import {
  Avatar,
  Band,
  Button,
  Content,
  Empty,
  Header,
  Icon,
  Screen,
  Sheet,
  Skeleton,
  T,
} from "../ui/pieces.tsx";
import type { IconName } from "../ui/pieces.tsx";
import { useTheme } from "../ui/theme.ts";
export function AccountScreen() {
  const c = useTheme();
  const session = useSession();
  const options = useReadOptions();
  const profile = useQuery(options.profile);
  const queue = useQuery({ ...options.queue, enabled: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await session.signOut();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  function infoRow(icon: IconName, title: string, caption?: string) {
    return (
      <View
        key={title}
        style={{
          minHeight: 56,
          padding: 14,
          borderBottomWidth: 1,
          borderBottomColor: c.rule,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Icon name={icon} color={c.text2} />
        <View style={{ flex: 1, gap: 2 }}>
          <T>{title}</T>
          {caption && (
            <T variant="caption" color={c.text3}>
              {caption}
            </T>
          )}
        </View>
      </View>
    );
  }
  const zone = queue.data?.timeZone;
  return (
    <Screen>
      <Header title="Account" back />
      <Sheet>
        {!profile.data ? (
          profile.isPending ? (
            <Skeleton lead />
          ) : (
            <Empty
              title="Account could not be loaded"
              text={readFailureText(failureFrom(profile.error))}
              icon="offline"
              action="Try again"
              onPress={() => {
                void profile.refetch({ cancelRefetch: false });
              }}
            />
          )
        ) : (
          <Content>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              <Avatar name={profile.data.name} size={52} />
              <View style={{ flex: 1, gap: 4 }}>
                <T variant="title2">{profile.data.name}</T>
                <T variant="small" color={c.text2}>
                  Agent · {profile.data.email}
                </T>
              </View>
            </View>
            {(profile.data.teams ?? []).length > 0 && (
              <View style={{ gap: 8 }}>
                <T variant="small" color={c.text2}>
                  {(profile.data.teams ?? []).length === 1 ? "Team" : "Teams"}
                </T>
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: c.rule,
                    borderRadius: 12,
                    overflow: "hidden",
                  }}
                >
                  {(profile.data.teams ?? []).map((team) => infoRow("users", team.name))}
                </View>
                {(profile.data.teams ?? []).length > 1 && (
                  <T variant="caption" color={c.text3}>
                    Your queue holds your own leads{" "}
                    {(profile.data.teams ?? []).length === 2 ? "from both." : "from all of them."}
                  </T>
                )}
              </View>
            )}
            <View style={{ gap: 8 }}>
              <T variant="small" color={c.text2}>
                Server
              </T>
              <View
                style={{
                  borderWidth: 1,
                  borderColor: c.rule,
                  borderRadius: 12,
                  overflow: "hidden",
                }}
              >
                {infoRow("server", new URL(server).host)}
                {profile.data.demoRole && infoRow("eye", "Invented data", "It resets every night.")}
                {session.state.kind === "signedIn" &&
                  infoRow(
                    "clock",
                    `Session ends ${contextualDate(new Date(session.state.credential.expiresAt), new Date(), zone, "session")}`,
                    "Sessions last up to 24 hours.",
                  )}
                {zone &&
                  infoRow("globe", `${zoneName(zone)} time`, "Callbacks and the queue use it.")}
              </View>
            </View>
            {failed ? (
              <Band
                kind="wait"
                icon="help"
                title="Sign-out could not be confirmed"
                text="Nothing was deleted here, and the session may still be open."
              >
                <Button
                  small
                  outline
                  icon="refresh"
                  label={busy ? "Signing out…" : "Try again"}
                  busy={busy}
                  onPress={() => {
                    void signOut();
                  }}
                />
                <RemoveSignIn />
              </Band>
            ) : (
              <Button
                outline
                icon="logout"
                label={busy ? "Signing out…" : "Sign out"}
                busy={busy}
                onPress={() => {
                  const counts = storedCounts(
                    session.phoneReady && !session.phoneError && session.phone
                      ? session.phone.counts()
                      : null,
                  );
                  Alert.alert(
                    counts ? "Delete what is kept and sign out?" : "Sign out?",
                    `${counts ? `${counts} will be deleted from this phone. ` : ""}Coming back needs a new code from your email.`,
                    [
                      {
                        text: counts ? "Delete and sign out" : "Sign out",
                        style: "destructive",
                        onPress: () => {
                          void signOut();
                        },
                      },
                      { text: "Cancel", style: "cancel" },
                    ],
                  );
                }}
              />
            )}
            <T variant="caption" color={c.text3} style={{ textAlign: "center", marginTop: -8 }}>
              Relay CRM 0.1.0
            </T>
          </Content>
        )}
      </Sheet>
    </Screen>
  );
}
