import { agentRequest, hasSitePassword, hasValidSitePassword, isValidJobId } from "../_lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidJob() {
  return Response.json({ error: "That research job could not be found." }, { status: 404 });
}

function authorized(request) {
  return hasSitePassword() && hasValidSitePassword(request.headers.get("x-site-password"));
}

export async function GET(request, { params }) {
  if (!authorized(request)) return Response.json({ error: "That site password is not correct." }, { status: 401 });
  const { jobId } = await params;
  if (!isValidJobId(jobId)) return invalidJob();

  try {
    return Response.json(await agentRequest(`/jobs/${jobId}`));
  } catch (error) {
    return Response.json({ error: error.message || "Could not check research progress." }, { status: 502 });
  }
}

export async function DELETE(request, { params }) {
  if (!authorized(request)) return Response.json({ error: "That site password is not correct." }, { status: 401 });
  const { jobId } = await params;
  if (!isValidJobId(jobId)) return invalidJob();

  try {
    return Response.json(await agentRequest(`/jobs/${jobId}/cancel`, { method: "POST" }));
  } catch (error) {
    return Response.json({ error: error.message || "Could not cancel research." }, { status: 502 });
  }
}
