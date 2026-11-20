import { useRef, useState } from "react";
import { Redirect, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useSession } from "../api/session-provider.tsx";
import { signInOptions } from "../core/session-display.ts";
import { SignIn } from "../screens/sign-in.tsx";
export default function SignInRoute() {
  const { surface } = useLocalSearchParams<{ surface?: string }>();
  const { state } = useSession();
  const allowed = useRef(signInOptions(state, true).allowed);
  const [busy, setBusy] = useState(false);
  const disable = usePreventRemove(busy);
  if (!allowed.current) return <Redirect href="/" />;
  return (
    <SignIn
      modal={surface === "form" ? "form" : "kept"}
      onBusyChange={setBusy}
      onAuthenticated={disable}
    />
  );
}
