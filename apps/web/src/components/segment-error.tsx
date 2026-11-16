"use client";
import type { ErrorInfo } from "next/error";
import { useQueryClient } from "@tanstack/react-query";
import { Refusal } from "./pieces";
import { failureMessage } from "@/lib/failures";
export function SegmentError({ retry }: ErrorInfo) {
  const client = useQueryClient();
  return (
    <div className="p-6">
      <Refusal
        title="This screen could not be opened"
        retry={() => {
          void client.resetQueries().then(retry);
        }}
      >
        {failureMessage({ data: { code: "INTERNAL_SERVER_ERROR" } }, "read")}
      </Refusal>
    </div>
  );
}
