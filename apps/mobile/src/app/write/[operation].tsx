import { useLocalSearchParams } from "expo-router";
import { WriteScreen } from "../../screens/write.tsx";

export default function WriteRoute() {
  const params = useLocalSearchParams<{
    id: string;
    operation: string;
    channel?: string;
    phone?: string;
  }>();
  const operation = params.operation;
  if (
    operation !== "attempt" &&
    operation !== "note" &&
    operation !== "callback" &&
    operation !== "close"
  )
    throw new Error("Unknown operation.");
  return (
    <WriteScreen
      id={params.id}
      operation={operation}
      channel={params.channel === "whatsApp" ? "whatsApp" : "call"}
      phone={params.phone}
    />
  );
}
