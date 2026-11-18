import { useState } from "react";
import { Alert } from "react-native";
import { useSession } from "../api/session-provider.tsx";
import { Band, Button } from "./pieces.tsx";
import { storedCounts } from "../core/write-presentation.ts";

export function RemoveSignIn() {
  const session = useSession();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    setFailed(false);
    try {
      await session.removeSignIn();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {failed && <Band title="This phone could not remove the sign-in." text="Try again." />}
      <Button
        small
        outline
        label="Remove sign-in from this phone"
        busy={busy}
        onPress={() => {
          const counts = storedCounts(session.phone?.counts() ?? { entries: 0, drafts: 0 });
          Alert.alert(
            "Remove sign-in from this phone?",
            `${counts ? `${counts} will be deleted with it. ` : ""}The server may keep the session open until it ends on its own, within 24 hours.`,
            [
              {
                text: "Remove",
                style: "destructive",
                onPress: () => {
                  void remove();
                },
              },
              { text: "Cancel", style: "cancel" },
            ],
          );
        }}
      />
    </>
  );
}
