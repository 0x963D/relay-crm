import { expectTypeOf, it } from "vitest";
import type { LeadId, Money } from "@relay/domain";
import type { Prisma } from "../../../packages/store/src/generated/client.ts";
import type { z } from "zod";
import type { queueReadShape, leadReadShape } from "../src/core/read-shapes.ts";
import type { Lead, Queue, Outputs } from "../src/core/api-types.ts";

it("preserves JSON, money and branded identities through the app's API import", () => {
  expectTypeOf<Queue>().toExtend<z.input<typeof queueReadShape>>();
  expectTypeOf<Omit<Lead, "timeline">>().toExtend<
    Omit<z.input<typeof leadReadShape>, "timeline">
  >();
  expectTypeOf<Lead["timeline"][number]["summary"]>().toExtend<
    z.input<typeof leadReadShape>["timeline"][number]["summary"]
  >();
  expectTypeOf<Lead["timeline"][number]["detail"]>().not.toBeAny();
  expectTypeOf<Lead["timeline"][number]["detail"]>().toEqualTypeOf<Prisma.JsonValue>();
  expectTypeOf<Lead["id"]>().not.toBeAny();
  expectTypeOf<Lead["id"]>().toEqualTypeOf<LeadId>();
  expectTypeOf<Outputs["payments"]["get"]["money"]>().not.toBeAny();
  expectTypeOf<Outputs["payments"]["get"]["money"]>().toEqualTypeOf<Money>();
  expectTypeOf<Outputs["payments"]["get"]["money"]["minor"]>().not.toBeAny();
});
