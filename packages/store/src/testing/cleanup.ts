import { testServer } from "./server.ts";

const runId = process.env.RELAY_TEST_RUN;
if (!runId || !/^[a-f0-9]{16}$/.test(runId))
  throw new Error("A cleanup process needs its test run ID.");
let cleaning: Promise<void> | undefined;
const cleanup = () => {
  cleaning ??= testServer().dropTestDatabases(runId);
  void cleaning.then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("disconnect", cleanup);
process.on("message", (message) => {
  if (message === "close") cleanup();
});
process.send?.("ready");
