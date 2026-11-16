"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Refusal } from "./pieces";
import { failureMessage } from "@/lib/failures";
export function SegmentError({ error, reset }: { error: Error; reset: () => void }) {
  const client = useQueryClient();
  return (
    <div className="p-6">
      <Refusal
        title="This screen could not be opened"
        retry={() => {
          void client.resetQueries().then(reset);
        }}
      >
        {failureMessage(
          { data: { code: "INTERNAL_SERVER_ERROR" }, message: error.message },
          "read",
        )}
      </Refusal>
    </div>
  );
}
