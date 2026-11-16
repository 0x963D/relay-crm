import { LeadRoute } from "@/components/lead-route";
export default async function LeadPage({ params }: { params: Promise<{ leadId: string }> }) {
  return <LeadRoute id={(await params).leadId} />;
}
