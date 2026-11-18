import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSession } from "../api/session-provider.tsx";
import { sessionDisplay, sessionSurface } from "../core/session-display.ts";
import { failureWording } from "../core/failure.ts";
import { Empty, Header, Screen, Sheet, Skeleton } from "../ui/pieces.tsx";
import { RemoveSignIn } from "../ui/remove-sign-in.tsx";
import { SignIn } from "./sign-in.tsx";

export function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const opened = useRef(false);
  const surface = sessionSurface(pathname);
  const display = sessionDisplay(session.state, surface);
  useEffect(() => {
    if (session.state.kind !== "ended") opened.current = false;
    if (display === "modal" && !opened.current) {
      opened.current = true;
      router.push({ pathname: "/sign-in", params: { surface } });
    }
  }, [display, surface, session.state.kind, router]);
  let replacement: ReactNode = null;
  if (pathname !== "/sign-in" && display === "replacement") {
    if (session.state.kind === "restoring" || session.state.kind === "checking")
      replacement = (
        <Screen>
          <Header title="Relay CRM" />
          <Sheet>
            <Skeleton />
          </Sheet>
        </Screen>
      );
    else if (session.state.kind === "unavailable")
      replacement = (
        <Screen>
          <Header title="Relay CRM" />
          <Sheet>
            <Empty
              title={failureWording(session.state.failure).title}
              text={`${failureWording(session.state.failure).text} Your session has not been checked.`}
              icon={failureWording(session.state.failure).icon}
              action="Try again"
              onPress={() => {
                void session.verify();
              }}
            />
            <View style={{ padding: 16 }}>
              <RemoveSignIn />
            </View>
          </Sheet>
        </Screen>
      );
    else replacement = <SignIn key={session.state.kind} />;
  }
  if (session.state.kind === "signedIn" && session.state.credential.user.role !== "agent")
    replacement = (
      <Screen>
        <Header title="Relay CRM" />
        <Sheet>
          <Empty
            title="This app is for agents"
            text="Use Relay CRM on the web for the pool, payments and accounts."
            icon="users"
            action="Sign out"
            onPress={() => {
              void session.signOut().catch(() => undefined);
            }}
          />
          <View style={{ padding: 16 }}>
            <RemoveSignIn />
          </View>
        </Sheet>
      </Screen>
    );
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1, display: replacement ? "none" : "flex" }}
        accessibilityElementsHidden={!!replacement}
        importantForAccessibility={replacement ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {replacement && <View style={{ flex: 1 }}>{replacement}</View>}
    </View>
  );
}
