import { agentRequest, hasSitePassword, hasValidSitePassword } from "./_lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let password;

  try {
    ({ password } = await request.json());
  } catch {
    return Response.json({ error: "Please enter the site password." }, { status: 400 });
  }

  if (!hasSitePassword()) {
    return Response.json(
      { error: "Opportunity refresh is not configured: SITE_PASSWORD is missing." },
      { status: 503 },
    );
  }

  if (!hasValidSitePassword(password)) {
    return Response.json({ error: "That site password is not correct." }, { status: 401 });
  }

  try {
    const job = await agentRequest("/jobs", { method: "POST" });
    return Response.json({ id: job.id }, { status: 202 });
  } catch (error) {
    return Response.json(
      { error: error.message || "Could not start opportunity research." },
      { status: 502 },
    );
  }
}
