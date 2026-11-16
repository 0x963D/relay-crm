import { NextResponse } from "next/server";
import { composition } from "./server/composition.ts";

export async function proxy() {
  const { env, store } = composition();
  if (env.demo) {
    try {
      if ((await store.databaseReady()) && (await store.demoReady())) return NextResponse.next();
    } catch {
      return unavailable();
    }
    return unavailable();
  }
  return NextResponse.next();
}
function unavailable() {
  return new NextResponse("The demo is being restored. Try again shortly.", {
    status: 503,
    headers: { "Retry-After": "1" },
  });
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
