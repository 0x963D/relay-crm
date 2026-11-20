import { useCallback, useEffectEvent, useEffect } from "react";
import { BackHandler, View, useWindowDimensions } from "react-native";
import { Stack, useFocusEffect, usePreventRemove, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReadOptions } from "../api/use-read-options.ts";
import { useSession } from "../api/session-provider.tsx";
import { clock } from "../core/dates.ts";
import { sessionPerson } from "../core/session.ts";
import { Band, Button, Content, Screen, Sheet, Skeleton, T } from "../ui/pieces.tsx";
import { useTheme } from "../ui/theme.ts";

export function WonScreen({ id, name }: { id: string; name: string }) {
  const c = useTheme();
  const { fontScale } = useWindowDimensions();
  const inset = useSafeAreaInsets();
  const router = useRouter();
  const session = useSession();
  const person = sessionPerson(session.state);
  const options = useReadOptions();
  const lead = useQuery(options.lead(id));
  const queue = useQuery({ ...options.queue, enabled: false });
  const disable = usePreventRemove(true, () => {
    back();
  });
  function back() {
    disable();
    router.dismissTo("/");
  }
  const goBack = useEffectEvent(back);
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        goBack();
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, []),
  );
  const { refetch } = lead;
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const closure = lead.data?.timeline.find((entry) => entry.kind === "closure");
  return (
    <Screen>
      <Stack.Screen options={{ gestureEnabled: false, presentation: "modal" }} />
      <View style={{ height: inset.top }} />
      <Sheet>
        <Content>
          <Band
            kind="done"
            icon="done"
            title="Lead won"
            titleVariant="display"
            iconSize={32}
            text="An account is open and keeps this history."
          />
          <View style={{ flexDirection: fontScale >= 1.3 ? "column" : "row", gap: 16 }}>
            <View style={{ flex: 1, gap: 5 }}>
              <View
                style={{
                  minHeight: 32,
                  borderBottomWidth: 1,
                  borderBottomColor: c.text,
                  paddingBottom: 7,
                }}
              >
                <T variant="bodyStrong">{name}</T>
              </View>
              <T variant="caption" color={c.text3}>
                Account opened for
              </T>
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              {lead.isFetching && !closure ? (
                <Skeleton signoff />
              ) : (
                <>
                  <View
                    style={{
                      minHeight: 32,
                      borderBottomWidth: 1,
                      borderBottomColor: c.text,
                      paddingBottom: 7,
                    }}
                  >
                    <T
                      variant={closure?.actor ? "bodyStrong" : "body"}
                      color={closure?.actor ? c.text : c.text3}
                    >
                      {closure?.actor
                        ? closure.actor.id === person
                          ? "You"
                          : closure.actor.name
                        : "Closed"}
                    </T>
                  </View>
                  <T variant="caption" color={c.text3}>
                    {lead.isError || !closure
                      ? "Who and when did not load"
                      : `${closure.actor ? "Closed by" : ""}${queue.data?.timeZone ? `${closure.actor ? " · " : ""}${clock(closure.at, queue.data.timeZone)}` : ""}`}
                  </T>
                </>
              )}
            </View>
          </View>
          <T variant="small" color={c.text2}>
            Take the payment in Relay CRM on the web.
          </T>
        </Content>
        <View style={{ padding: 16, paddingBottom: inset.bottom + 12 }}>
          <Button label="Back to queue" onPress={back} />
        </View>
      </Sheet>
    </Screen>
  );
}
