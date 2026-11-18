import { confirmStorage } from "./phone-entries.ts";
import type { PhoneEntries, PhoneStorage } from "./phone-entries.ts";
import type { Scope } from "./write-model.ts";

export async function erasePhone(owner: PhoneEntries | null, storage: PhoneStorage, scope: Scope) {
  owner?.retire();
  await confirmStorage(storage.remove(scope));
}

export async function signOutFromPhone(
  actions: {
    revoke: () => Promise<void>;
    remove: () => Promise<boolean>;
    erase: () => Promise<void>;
    forget: () => void | Promise<void>;
  },
  local = false,
) {
  if (!local) await actions.revoke();
  if (!(await actions.remove())) return;
  let erased = true;
  try {
    await actions.erase();
  } catch {
    erased = false;
  }
  await actions.forget();
  return erased ? "erased" : "kept";
}

export const keptPhoneWarning =
  "Items are still on this phone. Sign in as the same person, then sign out or remove sign-in again to retry removal.";
