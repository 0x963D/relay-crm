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
  await actions.erase().catch(() => undefined);
  await actions.forget();
}
