import { hasSitePassword, hasValidSitePassword } from "../_lib/agent";
import { listOpportunities } from "../_lib/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let password;
  try {
    ({ password } = await request.json());
  } catch {
    return Response.json({ error: "Please enter the site password." }, { status: 400 });
  }
  if (!hasSitePassword() || !hasValidSitePassword(password)) {
    return Response.json({ error: "That site password is not correct." }, { status: 401 });
  }
  try {
    return Response.json(await listOpportunities("new"));
  } catch (error) {
    return Response.json({ error: error.message || "Could not load review opportunities." }, { status: 502 });
  }
}
