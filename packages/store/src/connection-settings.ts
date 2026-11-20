import ConnectionParameters from "pg/lib/connection-parameters";

export function postgresStartupIdentity(connectionString: string) {
  try {
    const { user, options } = new ConnectionParameters(connectionString);
    return { user, options };
  } catch {
    return null;
  }
}
