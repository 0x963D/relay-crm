import { DEMO_PEOPLE, DEMO_ROLES } from "@relay/store";
import { composition } from "@/server/composition.ts";

export default function NotSignedIn() {
  return (
    <main>
      <h1>Sign in to Relay CRM</h1>
      {composition().env.demo ? (
        <>
          <p>Choose an invented staff member to try the demo.</p>
          {DEMO_ROLES.map((role) => (
            <form action="/api/auth/demo" method="post" key={role}>
              <button type="submit" name="role" value={role}>
                {DEMO_PEOPLE[role].name}, {role}
              </button>
            </form>
          ))}
        </>
      ) : (
        <>
          <p>
            Enter your staff email to receive a sign-in code. Then enter that email and code below.
          </p>
          <form action="/api/auth/email-otp/send-verification-otp" method="post">
            <label>
              Work email <input name="email" type="email" required autoComplete="email" />
            </label>
            <input type="hidden" name="type" value="sign-in" />
            <button type="submit">Email me a code</button>
          </form>
          <form action="/api/auth/sign-in/email-otp" method="post">
            <label>
              Work email <input name="email" type="email" required autoComplete="email" />
            </label>
            <label>
              Sign-in code{" "}
              <input
                name="otp"
                required
                pattern="[0-9]{6}"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </label>
            <button type="submit">Sign in</button>
          </form>
        </>
      )}
    </main>
  );
}
