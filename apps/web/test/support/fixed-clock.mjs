import { mock } from "node:test";
import { commandEnvironment } from "../../src/server/env.ts";
const at = commandEnvironment({}).RELAY_CAPTURE_DAY;
if (!at) throw new Error("The capture clock needs a fixed day.");
mock.timers.enable({ apis: ["Date"], now: new Date(at) });
