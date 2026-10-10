const fields = "id,title,url,source_excerpt,why_it_fits,status,found_at,decided_at";

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Opportunities are not configured.");
  return { url, key };
}

async function request(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Could not read opportunities.");
  return body;
}

export async function listOpportunities(status) {
  return request(`opportunities?status=eq.${status}&order=found_at.desc&select=${fields}`);
}

export async function decideOpportunity(id, status) {
  const rows = await request(`opportunities?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify({ status, decided_at: new Date().toISOString() }),
  });
  if (!rows[0]) throw new Error("That opportunity could not be found.");
  return rows[0];
}
