import { beforeEach, expect, it, vi } from "vitest";
import { bearer, bearerPerson, tokenStore } from "../src/api/token.ts";
import * as SecureStore from "expo-secure-store";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device",
  getItemAsync: (key: string) => Promise.resolve(storage.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    storage.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    storage.delete(key);
    return Promise.resolve();
  },
}));
beforeEach(async () => {
  storage.clear();
  await tokenStore.restore();
});
it("removes both the credential and the previous person's email", async () => {
  await tokenStore.save(
    {
      token: "one",
      expiresAt: "2026-11-18T00:00:00Z",
      user: { id: "one", name: "One", role: "agent" },
    },
    "one@example.com",
  );
  expect(bearer()).toBe("one");
  await tokenStore.clear();
  expect(bearer()).toBeNull();
  expect(storage.size).toBe(0);
  await expect(tokenStore.restore()).resolves.toEqual({ credential: null, email: "" });
});
it("does not remove a newer credential when an older sign-out finishes", async () => {
  const credential = {
    token: "one",
    expiresAt: "2026-11-18T00:00:00Z",
    user: { id: "one", name: "One", role: "agent" },
  };
  await tokenStore.save(credential, "one@example.com");
  const old = bearer();
  await tokenStore.save({ ...credential, token: "two" }, "two@example.com");
  expect(await tokenStore.clear(old)).toBe(false);
  expect(bearer()).toBe("two");
  expect((await tokenStore.restore()).email).toBe("two@example.com");
});
it("serializes credential writes while native storage is still busy", async () => {
  const held = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const write = vi.spyOn(SecureStore, "setItemAsync").mockImplementationOnce((key, value) => {
    storage.set(key, value);
    started.resolve(undefined);
    return held.promise;
  });
  const credential = {
    token: "one",
    expiresAt: "2026-11-18T00:00:00Z",
    user: { id: "one", name: "One", role: "agent" },
  };
  try {
    const first = tokenStore.save(credential, "one@example.com");
    await started.promise;
    const second = tokenStore.save({ ...credential, token: "two" }, "two@example.com");
    expect(write).toHaveBeenCalledTimes(1);
    held.resolve(undefined);
    await Promise.all([first, second]);
    expect(bearer()).toBe("two");
    expect((await tokenStore.restore()).email).toBe("two@example.com");
  } finally {
    held.resolve(undefined);
    write.mockRestore();
  }
});
it("switches the answer owner when the credential is stored, before optional email storage finishes", async () => {
  const held = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const write = vi.spyOn(SecureStore, "setItemAsync").mockImplementation((key, value) => {
    if (key.endsWith(".email")) {
      started.resolve(undefined);
      return held.promise;
    }
    storage.set(key, value);
    return Promise.resolve();
  });
  try {
    const saving = tokenStore.save(
      {
        token: "new-token",
        expiresAt: "2026-11-18T00:00:00Z",
        user: { id: "new-person", name: "Person", role: "agent" },
      },
      "person@example.com",
    );
    await started.promise;
    expect(bearerPerson()).toBe("new-person");
    held.resolve(undefined);
    await saving;
  } finally {
    held.resolve(undefined);
    write.mockRestore();
  }
});
it("does not reject an already stored credential when its optional remembered address cannot be written", async () => {
  const write = vi.spyOn(SecureStore, "setItemAsync").mockImplementation((key, value) => {
    if (key.endsWith(".email")) return Promise.reject(new Error("Address storage failed."));
    storage.set(key, value);
    return Promise.resolve();
  });
  try {
    await tokenStore.save(
      {
        token: "new-token",
        expiresAt: "2026-11-18T00:00:00Z",
        user: { id: "new-person", name: "Person", role: "agent" },
      },
      "person@example.com",
    );
    expect(bearerPerson()).toBe("new-person");
  } finally {
    write.mockRestore();
  }
});
it("never restores an address belonging to a different person", async () => {
  const credential = {
    token: "token",
    expiresAt: "2026-11-18T00:00:00Z",
    user: { id: "person", name: "Person", role: "agent" },
  };
  await tokenStore.save(credential, "person@example.com");
  const addressKey = [...storage.keys()].find((key) => key.endsWith(".email"));
  if (!addressKey) throw new Error("Expected an address record.");
  storage.set(
    addressKey,
    JSON.stringify({ person: "previous-person", email: "previous@example.com" }),
  );
  expect((await tokenStore.restore()).email).toBe("");
});
