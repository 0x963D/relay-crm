import { useCallback, useEffect, useRef } from "react";
import type { ComponentRef } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import type { SectionList, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { Queue, QueueRow } from "../core/api-types.ts";
import type { GroupKey } from "../core/queue.ts";
import { queueSections } from "../core/queue.ts";
import { queueFocus } from "../core/queue-focus.ts";

type Node = ComponentRef<typeof View>;
export function useQueueFocus(queue: Queue | undefined, folded: ReadonlySet<GroupKey>) {
  const list = useRef<SectionList<QueueRow, ReturnType<typeof queueSections>[number]>>(null);
  const nodes = useRef(new Map<string, Node>());
  const previous = useRef(queue);
  const latest = useRef(queue);
  latest.current = queue;
  const focused = useRef<string | null>(null);
  const returning = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const announcement = useRef<string | null>(null);
  const active = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function focus(target: string) {
    pending.current = target;
    const node = nodes.current.get(target);
    if (node) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (!active.current) return;
        AccessibilityInfo.sendAccessibilityEvent(node, "focus");
        pending.current = null;
        focused.current = target.startsWith("row:") ? target.slice(4) : null;
        if (announcement.current) {
          if (Platform.OS === "ios")
            AccessibilityInfo.announceForAccessibilityWithOptions(announcement.current, {
              queue: true,
            });
          else AccessibilityInfo.announceForAccessibility(announcement.current);
        }
        announcement.current = null;
      }, 250);
    } else if (latest.current && target !== "state") {
      const sections = queueSections(latest.current);
      const sectionIndex = sections.findIndex(
        (section) =>
          target === `group:${section.key}` ||
          section.rows.some((row) => target === `row:${row.id}`),
      );
      const itemIndex = Math.max(
        0,
        sections[sectionIndex]?.rows.findIndex((row) => target === `row:${row.id}`) ?? 0,
      );
      if (sectionIndex >= 0)
        list.current?.scrollToLocation({ sectionIndex, itemIndex, animated: false });
    }
  }
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      const target = pending.current ?? returning.current;
      if (target) focus(target);
      returning.current = null;
      return () => {
        active.current = false;
        clearTimeout(timer.current);
      };
    }, []),
  );
  useEffect(() => {
    if (previous.current && queue && focused.current) {
      const change = queueFocus(previous.current, queue, focused.current, folded);
      if (change) {
        announcement.current = change.announcement;
        pending.current = change.target;
        if (active.current) focus(change.target);
      }
    }
    previous.current = queue;
  }, [queue, folded]);
  return {
    list,
    register(target: string, node: Node | null) {
      if (node) nodes.current.set(target, node);
      else nodes.current.delete(target);
      if (node && active.current && pending.current === target) focus(target);
    },
    focused(id: string) {
      focused.current = id;
    },
    opened(id: string) {
      focused.current = id;
      returning.current = `row:${id}`;
    },
    scrollFailed(info: { averageItemLength: number; index: number }) {
      list.current
        ?.getScrollResponder()
        ?.scrollTo({ y: info.averageItemLength * info.index, animated: false });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (pending.current) focus(pending.current);
      }, 250);
    },
  };
}
