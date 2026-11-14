import type { LeadState } from "@relay/domain";
import { connection } from "next/server";
import { composition } from "@/server/composition.ts";
import { devActor } from "@/server/dev-actor.ts";

const PAGE_SIZE = 100;

const received = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function describeState(state: LeadState): string {
  switch (state.status) {
    case "new":
    case "assigned":
    case "won":
      return state.status;
    case "working":
      return `working, ${state.stage.kind}`;
    case "lost":
    case "dead":
      return `${state.status}, ${state.reason}`;
  }
}

export default async function LeadsPage() {
  // The list reads the database, so it renders per request and never at build time.
  await connection();
  const leads = await composition().store.listLeads(devActor(), { limit: PAGE_SIZE });

  return (
    <main>
      <h1>Leads</h1>
      {leads.length === 0 ? (
        <p>No leads yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th scope="col">Campaign</th>
              <th scope="col">Received (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>{lead.email.asTyped}</td>
                <td>{lead.name}</td>
                <td>{describeState(lead.lifecycle.state)}</td>
                <td>{lead.origin?.source}</td>
                <td>{lead.origin?.campaign}</td>
                <td>{received.format(lead.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
