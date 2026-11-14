export default function NotSignedIn() {
  return (
    <main>
      <h1>You are not signed in</h1>
      <p>Relay CRM has no sign-in yet, so this page shows no leads.</p>
      <p>
        To work on the app locally, run <code>pnpm dev</code> with <code>RELAY_DEV_ACTOR=1</code> in{" "}
        <code>.env</code>.
      </p>
    </main>
  );
}
