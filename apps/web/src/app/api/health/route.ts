import { composition } from "@/server/composition.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { env, store } = composition();
    if ((await store.databaseReady()) && (!env.demo || (await store.demoReady())))
      return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    // A health probe reveals neither database errors nor deployment settings.
  }
  return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
}
