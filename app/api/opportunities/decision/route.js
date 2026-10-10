import { hasSitePassword, hasValidSitePassword } from "../_lib/agent";
import { decideOpportunity } from "../_lib/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let id;
  let password;
  let status;
  try {
    ({ id, password, status } = await request.json());
  } catch {
    return Response.json({ error: "Please enter the site password." }, { status: 400 });
  }
  if (!hasSitePassword() || !hasValidSitePassword(password)) {
    return Response.json({ error: "That site password is not correct." }, { status: 401 });
  }
  if (!/^\d+$/.test(String(id)) || !["approved", "rejected"].includes(status)) {
    return Response.json({ error: "That decision is not valid." }, { status: 400 });
  }
  try {
    return Response.json(await decideOpportunity(id, status));
  } catch (error) {
    return Response.json({ error: error.message || "Could not save that decision." }, { status: 502 });
  }
}
