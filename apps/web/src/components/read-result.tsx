import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { isAccessError } from "@relay/store";
import { HydrateClient } from "@/lib/trpc/server";
import { failureCode, failureMessages } from "@/lib/failures";
import { Empty } from "./pieces";
import { Button } from "./ui/button";

export async function ReadResult<T>({
  query,
  children,
  back,
  title,
  accessMessage,
  missingIsNotFound = false,
}: {
  query: Promise<T>;
  children: ReactNode | ((value: T) => ReactNode);
  back: string;
  title: string;
  accessMessage?: string;
  missingIsNotFound?: boolean;
}) {
  let value: T;
  try {
    value = await query;
  } catch (error) {
    const code =
      error instanceof TRPCError && isAccessError(error.cause)
        ? error.cause.code
        : error instanceof TRPCError && (error.code === "BAD_REQUEST" || error.code === "NOT_FOUND")
          ? "accessDenied"
          : failureCode(error);
    if (!code) throw error;
    if (missingIsNotFound && code === "accessDenied") notFound();
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
        {code === "accessDenied" && accessMessage ? accessMessage : failureMessages[code]}
      </Empty>
    );
  }
  return (
    <HydrateClient>{typeof children === "function" ? children(value) : children}</HydrateClient>
  );
}
