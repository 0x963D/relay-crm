import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import { credentialSchema } from "../core/session.ts";
import { server } from "./server.ts";
import type { Credential } from "../core/session.ts";

const key = `relay.${encodeURIComponent(server).replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
let current: Credential | null = null;
export const bearer = () => current?.token ?? null;
export const bearerPerson = () => current?.user.id ?? null;
let pending: Promise<unknown> = Promise.resolve();
const addressSchema = z.object({ person: z.string(), email: z.string() });
function rememberedEmail(raw: string | null, person: string | null) {
  try {
    const parsed = addressSchema.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success && parsed.data.person === person ? parsed.data.email : "";
  } catch {
    return "";
  }
}
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export const tokenStore = {
  restore() {
    return serialize(async () => {
      const raw = await SecureStore.getItemAsync(key);
      current = raw ? credentialSchema.parse(JSON.parse(raw)) : null;
      const email = rememberedEmail(
        await SecureStore.getItemAsync(`${key}.email`),
        current?.user.id ?? null,
      );
      return { credential: current, email: current ? email : "" };
    });
  },
  save(credential: Credential, email: string) {
    return serialize(async () => {
      await SecureStore.setItemAsync(key, JSON.stringify(credential), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      current = credential;
      await SecureStore.setItemAsync(
        `${key}.email`,
        JSON.stringify({ person: credential.user.id, email }),
      ).catch(() => undefined);
    });
  },
  rememberEmail(email: string, expectedToken = bearer()) {
    return serialize(async () => {
      if (expectedToken === null || expectedToken !== bearer()) return;
      await SecureStore.setItemAsync(
        `${key}.email`,
        JSON.stringify({ person: current?.user.id, email }),
      );
    });
  },
  clear(expectedToken = bearer()) {
    return serialize(async () => {
      if (expectedToken !== bearer()) return false;
      await SecureStore.deleteItemAsync(key);
      current = null;
      await SecureStore.deleteItemAsync(`${key}.email`).catch(() => undefined);
      return true;
    });
  },
};
