import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated } from "react-native";
import type { Queue } from "../core/api-types.ts";
import { queueSections } from "../core/queue.ts";

export function useQueueDisplay(queue: Queue | undefined, person: string | null) {
  const [shown, setShown] = useState({ data: queue, person });
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const current = useRef(shown);
  useEffect(() => {
    const before = current.current.person === person ? current.current.data : undefined;
    const positions = (data: Queue) =>
      new Map(
        queueSections(data).flatMap((group) =>
          group.rows.map((row) => [row.id, group.key] as const),
        ),
      );
    const after = queue ? positions(queue) : new Map<string, string>();
    const removed =
      before && queue
        ? new Set(
            [...positions(before)]
              .filter(([id, group]) => after.get(id) !== group)
              .map(([id]) => id),
          )
        : new Set<string>();
    const apply = () => {
      current.current = { data: queue, person };
      setShown(current.current);
      setLeaving(new Set());
    };
    if (removed.size === 0) {
      apply();
      return;
    }
    setLeaving(removed);
    const timer = setTimeout(apply, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [queue, person]);
  return { data: shown.person === person ? shown.data : undefined, leaving };
}
export function QueueRowMotion({ children, leaving }: { children: ReactNode; leaving: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: leaving ? 0 : 1,
      duration: 150,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
    };
  }, [leaving, opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}
