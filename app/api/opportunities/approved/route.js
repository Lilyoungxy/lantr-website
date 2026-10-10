import { listOpportunities } from "../_lib/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await listOpportunities("approved"));
  } catch (error) {
    return Response.json({ error: error.message || "Could not load opportunities." }, { status: 502 });
  }
}
