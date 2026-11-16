import type { ReactNode } from "react";
import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { isAccessError } from "@relay/store";
import { HydrateClient } from "@/lib/trpc/server";
import { failureCode, failureMessages } from "@/lib/failures";
import { Empty } from "./pieces";
import { Button } from "./ui/button";

export async function ReadResult({
  query,
  children,
  back,
  title,
}: {
  query: Promise<unknown>;
  children: ReactNode;
  back: string;
  title: string;
}) {
  try {
    await query;
  } catch (error) {
    const code =
      error instanceof TRPCError && isAccessError(error.cause)
        ? error.cause.code
        : failureCode(error);
    if (!code) throw error;
    return (
      <Empty
        icon="lock"
        title={title}
        action={
          <Button asChild variant="outline">
            <Link href={back}>Back to my list</Link>
          </Button>
        }
      >
        {failureMessages[code]}
      </Empty>
    );
  }
  return <HydrateClient>{children}</HydrateClient>;
}
