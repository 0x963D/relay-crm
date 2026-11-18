import { useEffect, useEffectEvent, useState } from "react";
import {
  AppState,
  Pressable,
  RefreshControl,
  SectionList,
  View,
  useWindowDimensions,
} from "react-native";
import { useNetworkState } from "expo-network";
import { useQueueFocus } from "../ui/queue-focus.ts";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { failureFrom } from "../api/client.ts";
import { useReadOptions, useReadOnReturn } from "../api/use-read-options.ts";
import { readFailureText } from "../core/failure.ts";
import { useSession } from "../api/session-provider.tsx";
import type { QueueRow } from "../core/api-types.ts";
import { clock, contextualDate, dayHeading, nextQueueRefresh } from "../core/dates.ts";
import { families } from "../core/theme.ts";
import { queueSections, rowPresentation } from "../core/queue.ts";
import type { GroupKey } from "../core/queue.ts";
import {
  Avatar,
  RefreshStrip,
  Empty,
  Header,
  Icon,
  IconButton,
  Screen,
  Sheet,
  Skeleton,
  Slips,
  Slip,
  T,
} from "../ui/pieces.tsx";
import { useTheme } from "../ui/theme.ts";
import { useHandoff } from "../ui/handoff.tsx";
import { EntriesStrip, openWrite, WriteNotice } from "../ui/write-controls.tsx";
import { canOfferCall } from "../core/handoff.ts";
import { sessionPerson } from "../core/session.ts";
import { QueueRowMotion, useQueueDisplay } from "../ui/queue-motion.tsx";

export function QueueScreen() {
  const c = useTheme();
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const session = useSession();
  const { fontScale } = useWindowDimensions();
  const [folded, setFolded] = useState<ReadonlySet<GroupKey>>(new Set());
  const [scrolled, setScrolled] = useState(false);
  const [now, setNow] = useState(new Date());
  const handoff = useHandoff();
  const options = useReadOptions();
  const profile = useQuery(options.profile);
  const queue = useQuery(options.queue);
  const display = useQueueDisplay(queue.data, sessionPerson(session.state));
  const focus = useQueueFocus(display.data, folded);
  const network = useNetworkState();
  useReadOnReturn(queue.refetch);
  const rememberEmail = useEffectEvent((email: string) => {
    void session.rememberEmail(email).catch(() => undefined);
  });
  useEffect(() => {
    if (profile.data?.email) rememberEmail(profile.data.email);
  }, [profile.data?.email]);
  const refreshQueue = useEffectEvent(() => {
    void queue.refetch({ cancelRefetch: false });
  });
  useEffect(() => {
    if (!display.data || session.state.kind !== "signedIn") return;
    const timer = setTimeout(
      () => {
        setNow(new Date());
        refreshQueue();
      },
      nextQueueRefresh(new Date(), display.data.timeZone, display.data.nextCallbackAt),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [display.data, session.state.kind]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(new Date());
      }
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, []);
  const name =
    profile.data?.name ??
    (session.state.kind === "signedIn" ? session.state.credential.user.name : "");
  const total = display.data
    ? Object.values(display.data.counts).reduce((sum, count) => sum + count, 0)
    : 0;
  const zone = display.data?.timeZone;
  const refresh = () => {
    void queue.refetch({ cancelRefetch: false });
  };
  const summary = zone
    ? `${dayHeading(now, zone)}${display.data && !queue.isError ? ` · ${String(total)} open leads${display.data.nextCallbackAt ? ` · next callback ${clock(display.data.nextCallbackAt, zone)}` : ""}` : ""}`
    : "";
  function row(item: QueueRow, key: GroupKey) {
    const p = rowPresentation(item, key, now, zone ?? "UTC");
    const held = session.phone?.entries().some((entry) => entry.command.payload.id === item.id);
    const callAvailable = canOfferCall(item.phone);
    function open(channel: "call" | "whatsApp") {
      if (!item.phone) return;
      if (held) void handoff.open(channel === "call" ? "call" : "whatsapp", item.phone);
      else openWrite(router, "attempt", item.id, channel, item.phone);
    }
    return (
      <QueueRowMotion leaving={display.leaving.has(item.id)}>
        <View
          style={{
            flexDirection: fontScale >= 1.3 ? "column" : "row",
            alignItems: fontScale >= 1.3 ? "stretch" : "center",
            paddingVertical: 12,
            paddingHorizontal: 16,
            gap: 8,
          }}
        >
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              bottom: 0,
              start: 16,
              end: 16,
              height: 1,
              backgroundColor: c.rule,
            }}
          />
          <Pressable
            ref={(node) => {
              focus.register(`row:${item.id}`, node);
            }}
            onFocus={() => {
              focus.focused(item.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${p.label}${held ? " Entry to review." : ""}`}
            accessibilityHint="Opens the lead"
            onPress={() => {
              focus.opened(item.id);
              router.push({
                pathname: "/lead/[id]",
                params: { id: item.id },
              });
            }}
            style={({ pressed }) => ({
              flex: fontScale < 1.3 ? 1 : undefined,
              minHeight: 76,
              justifyContent: "center",
              gap: 6,
              backgroundColor: pressed ? c.mute : c.sheet,
            })}
          >
            <T variant="rowTitle" numberOfLines={2}>
              {p.name}
            </T>
            <Slips items={p.slips} />
            {held && <Slip kind="wait" icon="hourglass" text="Entry to review" />}
            <T variant="secondary" color={c.text2} numberOfLines={fontScale >= 1.3 ? 4 : 2}>
              {p.line}
            </T>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <IconButton
              icon="phone"
              label={`Call ${p.name}, ${item.phone ?? "No phone number"}`}
              disabled={!callAvailable}
              onPress={() => {
                open("call");
              }}
            />
            <IconButton
              icon="whatsapp"
              outline
              label={`WhatsApp ${p.name}`}
              disabled={!item.phone}
              onPress={() => {
                open("whatsApp");
              }}
            />
          </View>
        </View>
      </QueueRowMotion>
    );
  }
  return (
    <Screen>
      <Header title="My queue" summary={scrolled ? undefined : summary}>
        {profile.data?.demoRole && (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel="Demo server, invented data"
            style={{
              borderRadius: 4,
              backgroundColor: c.carbonDeep,
              paddingHorizontal: 8,
              paddingVertical: 4,
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
            }}
          >
            <Icon name="eye" size={14} color={c.onCarbon} />
            <T variant="slip" color={c.onCarbon}>
              Demo
            </T>
          </View>
        )}
        <IconButton
          header
          icon="refresh"
          label={queue.isFetching ? "Refreshing" : "Refresh"}
          onPress={refresh}
          disabled={queue.isFetching}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Account, ${name}`}
          onPress={() => {
            router.push("/account");
          }}
          style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
        >
          <Avatar carbon name={name} />
        </Pressable>
      </Header>
      <Sheet>
        <EntriesStrip />
        <View style={{ paddingHorizontal: 16 }}>
          <WriteNotice zone={zone} />
        </View>
        {handoff.band && <View style={{ margin: 16 }}>{handoff.band}</View>}
        {queue.isError && display.data && (
          <RefreshStrip
            offline={network.isConnected === false || network.isInternetReachable === false}
            updated={contextualDate(display.data.at, now, display.data.timeZone, "checked")}
            onPress={refresh}
          />
        )}
        {!display.data ? (
          queue.isPending ? (
            <Skeleton />
          ) : (
            <Empty
              icon="offline"
              title="The queue could not be loaded"
              titleRef={(node) => {
                focus.register("state", node);
              }}
              text={readFailureText(failureFrom(queue.error))}
              action="Try again"
              onPress={refresh}
            />
          )
        ) : total === 0 ? (
          <>
            <Empty
              icon="list"
              title="You have no open leads"
              titleRef={(node) => {
                focus.register("state", node);
              }}
              text="They appear here when a manager assigns them to you."
              action="Check again"
              onPress={refresh}
            />
            <T variant="caption" color={c.text3} style={{ textAlign: "center", marginTop: 12 }}>
              Checked at {clock(display.data.at, display.data.timeZone)}
            </T>
          </>
        ) : (
          <SectionList<QueueRow, ReturnType<typeof queueSections>[number]>
            ref={focus.list}
            onScrollToIndexFailed={(info) => {
              focus.scrollFailed(info);
            }}
            accessibilityRole="list"
            accessibilityLabel="My callback queue"
            accessibilityActions={[{ name: "refresh", label: "Refresh" }]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "refresh") refresh();
            }}
            sections={queueSections(display.data).map((section) => ({
              ...section,
              data: folded.has(section.key) ? [] : section.rows,
            }))}
            keyExtractor={(item) => item.id}
            stickySectionHeadersEnabled
            contentContainerStyle={{ paddingBottom: inset.bottom + 12 }}
            onScroll={(event) => {
              setScrolled(event.nativeEvent.contentOffset.y > 8);
            }}
            scrollEventThrottle={100}
            refreshControl={
              <RefreshControl
                refreshing={queue.isFetching}
                onRefresh={refresh}
                tintColor={c.text3}
                colors={[c.ink]}
                progressBackgroundColor={c.sheet}
              />
            }
            renderSectionHeader={({ section }) => (
              <Pressable
                ref={(node) => {
                  focus.register(`group:${section.key}`, node);
                }}
                accessibilityRole={section.count ? "button" : "text"}
                accessibilityState={section.count ? { expanded: !folded.has(section.key) } : {}}
                accessibilityLabel={`${section.title}, ${String(section.count)} leads`}
                accessibilityHint={section.caption}
                onPress={() => {
                  if (section.count)
                    setFolded((previous) => {
                      const next = new Set(previous);
                      if (next.has(section.key)) next.delete(section.key);
                      else next.add(section.key);
                      return next;
                    });
                }}
                style={{
                  minHeight: 48,
                  paddingVertical: 2,
                  paddingHorizontal: 16,
                  backgroundColor: c.sheet,
                  borderBottomWidth: section.count ? 0 : 1,
                  borderBottomColor: c.rule,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <T variant="secondary" style={{ fontFamily: families.semibold }}>
                    {section.title}{" "}
                    <T variant="secondary" color={c.text2}>
                      {section.count}
                    </T>
                  </T>
                  {section.count === 0 || (!folded.has(section.key) && section.caption) ? (
                    <T variant="caption" color={c.text3}>
                      {section.count === 0 ? section.empty : section.caption}
                    </T>
                  ) : null}
                </View>
                {section.count > 0 && (
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon
                      name={folded.has(section.key) ? "right" : "down"}
                      size={18}
                      color={c.text3}
                    />
                  </View>
                )}
              </Pressable>
            )}
            renderItem={({ item, section }) => row(item, section.key)}
            renderSectionFooter={({ section }) =>
              !folded.has(section.key) && section.count > section.rows.length ? (
                <T
                  variant="caption"
                  color={c.text3}
                  accessibilityLabel={`Showing the first 100 of ${String(section.count)} leads`}
                  style={{ padding: 16 }}
                >
                  Showing the first 100 of {section.count}. The others appear as these leave the
                  group.
                </T>
              ) : null
            }
          />
        )}
      </Sheet>
    </Screen>
  );
}
