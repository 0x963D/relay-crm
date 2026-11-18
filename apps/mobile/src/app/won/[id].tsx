import { Redirect, useLocalSearchParams } from "expo-router";
import { WonScreen } from "../../screens/won.tsx";
import { useWriteFeedback } from "../../api/write-feedback.tsx";
export default function WonRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { notice } = useWriteFeedback();
  if (
    notice?.entry.command.payload.id !== id ||
    !notice.accountId ||
    notice.entry.command.operation !== "close" ||
    notice.entry.command.payload.closing.kind !== "won"
  )
    return <Redirect href="/" />;
  return <WonScreen id={id} name={notice.entry.draft.leadName} />;
}
