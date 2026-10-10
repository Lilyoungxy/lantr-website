import { timingSafeEqual } from "node:crypto";

const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function isValidJobId(jobId) {
  return typeof jobId === "string" && JOB_ID_PATTERN.test(jobId);
}

export function hasValidSitePassword(password) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected || typeof password !== "string") return false;

  const expectedBuffer = Buffer.from(expected);
  const passwordBuffer = Buffer.from(password);
  return (
    expectedBuffer.length === passwordBuffer.length &&
    timingSafeEqual(expectedBuffer, passwordBuffer)
  );
}

export function hasSitePassword() {
  return Boolean(process.env.SITE_PASSWORD);
}

function getAgentConfig() {
  const agentUrl = process.env.AGENT_URL?.replace(/\/$/, "");
  const agentSecret = process.env.AGENT_SECRET;

  if (!agentUrl || !agentSecret) {
    throw new Error("Opportunity research is not configured yet.");
  }

  return { agentUrl, agentSecret };
}

export async function agentRequest(path, options = {}) {
  const { agentUrl, agentSecret } = getAgentConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${agentUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        agent_secret: agentSecret,
        ...options.headers,
      },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(body.error || "The opportunity agent could not complete that request.");
    }

    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The opportunity agent took too long to respond. Please try again.");
    }
    if (error.message === "fetch failed") {
      throw new Error("The opportunity agent is unavailable right now. Please try again soon.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
