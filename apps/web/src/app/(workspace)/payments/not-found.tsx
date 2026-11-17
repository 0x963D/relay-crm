import Link from "next/link";
import { Empty } from "@/components/pieces";
import { Button } from "@/components/ui/button";
export default function MissingPayment() {
  return (
    <Empty
      icon="lock"
      title="This payment is unavailable"
      action={
        <Button asChild variant="outline">
          <Link href="/payments">Back to my list</Link>
        </Button>
      }
    >
      The payment does not exist or you do not have access to it.
    </Empty>
  );
}
