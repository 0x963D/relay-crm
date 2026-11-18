import { expectTypeOf, it } from "vitest";
import type { ComponentProps } from "react";
import type { Icon } from "../src/ui/pieces.tsx";
import type { IconName } from "../src/core/icons.ts";

it("accepts only the known icon names", () => {
  expectTypeOf<ComponentProps<typeof Icon>["name"]>().toEqualTypeOf<IconName>();
  expectTypeOf<"unknown-icon">().not.toExtend<IconName>();
});
