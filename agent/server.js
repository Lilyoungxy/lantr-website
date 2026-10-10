import { Agent, run, tool, webSearchTool } from '@openai/agents';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 8080);
const MAX_SEARCHES = 10;
const MAX_PAGE_READS = 15;
const JOB_TIMEOUT_MS = 4 * 60 * 1000;
const jobs = new Map();

function parseEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

let fileEnv = {};
try {
  fileEnv = parseEnv(await readFile(new URL('./.env', import.meta.url), 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const env = { ...process.env, ...fileEnv };

if (!env.OPENAI_API_KEY || !env.AGENT_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
  throw new Error('OPENAI_API_KEY, AGENT_SECRET, SUPABASE_URL, and SUPABASE_SERVICE_KEY must be set in agent/.env.');
}

process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;

function logToolCall(job, name, detail) {
  const call = { name, detail, at: new Date().toISOString() };
  job.toolCalls.push(call);
  console.log(`[job ${job.id}] ${name}: ${detail}`);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    searches: job.searches,
    pageReads: job.pageReads,
    elapsedMs: Math.round(performance.now() - job.startedAtMonotonic),
    toolCalls: job.toolCalls,
    result: job.status === 'completed' ? job.result : undefined,
    error: job.status === 'error' ? job.error : undefined,
  };
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 9_000);
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const link = new URL(match[1], baseUrl);
      if (['http:', 'https:'].includes(link.protocol)) links.add(link.href);
    } catch {
      // Ignore malformed links.
    }
    if (links.size >= 40) break;
  }
  return [...links];
}

function assertHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only public http(s) pages can be opened.');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error('Private-network pages cannot be opened.');
  }
  return url;
}

function captureHostedSearch(job, event) {
  if (event.type !== 'raw_model_stream_event') return;
  const rawEvent = event.data?.event || event.data;
  const item = rawEvent?.item;
  const isWebSearch =
    item?.type === 'web_search_call' ||
    String(rawEvent?.type || '').includes('web_search_call');
  const searchId = item?.id || rawEvent?.item_id;
  if (!isWebSearch || !searchId || job.searchIds.has(searchId)) return;

  job.searchIds.add(searchId);
  job.searches += 1;
  logToolCall(job, 'web_search', item?.action?.query || 'hosted web search');
  if (job.searches > MAX_SEARCHES) {
    job.controller.abort(new Error(`Search limit of ${MAX_SEARCHES} reached.`));
  }
}

const searchLeadsSchema = z.object({
  leads: z.array(z.object({
    name: z.string(),
    url: z.string(),
    reason: z.string(),
  })).max(10),
});

const researchResultSchema = z.object({
  opportunities: z.array(z.object({
    name: z.string(),
    description: z.string(),
    officialSourceUrl: z.string(),
    sourceExcerpt: z.string().min(1),
    ageEvidence: z.string().min(1),
    locationEvidence: z.string().min(1),
    availabilityEvidence: z.string().min(1),
  })).max(5),
  ruledOut: z.array(z.object({
    name: z.string(),
    reason: z.string(),
  })),
});

async function runStreaming(agent, input, job, maxTurns) {
  const stream = await run(agent, input, {
    stream: true,
    maxTurns,
    signal: job.controller.signal,
  });
  for await (const event of stream) captureHostedSearch(job, event);
  await stream.completed;
  return stream.finalOutput;
}

function makeOpenPageTool(job) {
  return tool({
    name: 'open_page',
    description: 'Read one public webpage. Use only after web search identifies a candidate official source.',
    parameters: z.object({ url: z.string() }),
    timeoutMs: 20_000,
    async execute({ url }) {
      if (job.controller.signal.aborted) throw job.controller.signal.reason || new Error('Job cancelled.');
      if (job.pageReads >= MAX_PAGE_READS) {
        throw new Error(`Page-read limit of ${MAX_PAGE_READS} reached.`);
      }

      const target = assertHttpUrl(url);
      job.pageReads += 1;
      logToolCall(job, 'open_page', target.href);

      const pageController = new AbortController();
      const timeout = setTimeout(() => pageController.abort(new Error('Page-read timeout.')), 15_000);
      const stop = () => pageController.abort(job.controller.signal.reason || new Error('Job cancelled.'));
      job.controller.signal.addEventListener('abort', stop, { once: true });

      try {
        const response = await fetch(target, {
          signal: pageController.signal,
          redirect: 'follow',
          headers: { 'user-agent': 'OpportunityResearchAgent/1.0' },
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) throw new Error(`Page returned HTTP ${response.status}.`);
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
          throw new Error(`Unsupported page type: ${contentType || 'unknown'}.`);
        }

        const body = await response.text();
        const finalUrl = response.url;
        job.openedUrls.add(finalUrl);
        job.openedUrls.add(target.href);
        return JSON.stringify({
          url: finalUrl,
          text: htmlToText(body),
          links: extractLinks(body, finalUrl),
        });
      } finally {
        clearTimeout(timeout);
        job.controller.signal.removeEventListener('abort', stop);
      }
    },
  });
}

function makeUpdateSiteTool(job) {
  return tool({
    name: 'update_site',
    description: 'Save one verified opportunity to the site. Existing URLs are left unchanged.',
    parameters: z.object({
      title: z.string().min(1),
      url: z.string().url(),
      source_excerpt: z.string().optional(),
      why_it_fits: z.string().optional(),
    }),
    timeoutMs: 20_000,
    async execute({ title, url, source_excerpt, why_it_fits }) {
      const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/opportunities`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'content-type': 'application/json',
          prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify({
          title,
          url,
          source_excerpt,
          why_it_fits,
          status: 'new',
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `Supabase returned HTTP ${response.status}.`);

      const saved = body[0];
      const detail = saved ? `saved ${url}` : `skipped existing ${url}`;
      logToolCall(job, 'update_site', detail);
      return JSON.stringify({ saved: Boolean(saved), url });
    },
  });
}

function makeAgents(job) {
  const searchAgent = new Agent({
    name: 'Opportunity searcher',
    model: 'gpt-6-astra',
    modelSettings: { parallelToolCalls: false, maxTokens: 1_200 },
    outputType: searchLeadsSchema,
    tools: [webSearchTool({ searchContextSize: 'medium' })],
    instructions: `Search for current opportunities matching this person. Search before evaluating any page. You may use web_search only. Find competitions, programs, or events that could suit a 15-year-old in Auckland interested in chiikawa, insects, baking, and cooking. Return up to ten leads with the most likely official URLs. Do not claim eligibility or availability yet. Make no more than ${MAX_SEARCHES} searches.`,
  });

  const researchAgent = new Agent({
    name: 'Opportunity verifier',
    model: 'gpt-6-astra',
    modelSettings: { parallelToolCalls: false, maxTokens: 1_800 },
    outputType: researchResultSchema,
    tools: [makeOpenPageTool(job)],
    instructions: `You verify opportunity leads for a 15-year-old in Auckland who likes chiikawa, insects, baking, and cooking. You have already searched; now use open_page to read an official organiser source for each possible item. For every accepted opportunity, you MUST verify on a page you opened: age limits, Auckland/New Zealand or remote location suitability, and that applications or registration are open now. Include a short exact excerpt supporting eligibility and availability. Never assume school, experience, parental permission, or travel ability. If a page cannot be read or evidence is missing, investigate another official source first, including related links returned by open_page; only then reject it if evidence remains unavailable. Stop reading as soon as the evidence supports the best available answer. Return at most five accepted opportunities, fewer when necessary, and explain every rejected lead. Use no more than ${MAX_PAGE_READS} page reads.`,
  });

  return { searchAgent, researchAgent, updateSite: makeUpdateSiteTool(job) };
}

function filterVerifiedResult(result, job) {
  const ruledOut = [...result.ruledOut];
  const opportunities = [];

  for (const item of result.opportunities) {
    let sourceUrl;
    try {
      sourceUrl = assertHttpUrl(item.officialSourceUrl).href;
    } catch {
      ruledOut.push({ name: item.name, reason: 'Excluded because its official source URL is invalid.' });
      continue;
    }
    if (!job.openedUrls.has(sourceUrl)) {
      ruledOut.push({ name: item.name, reason: 'Excluded because its stated official source was not read by open_page.' });
      continue;
    }
    opportunities.push(item);
  }

  return { opportunities, ruledOut };
}

async function runJob(job) {
  job.status = 'running';
  job.phase = 'searching';
  const timeout = setTimeout(() => job.controller.abort(new Error('Four-minute job limit reached.')), JOB_TIMEOUT_MS);

  try {
    const interests = await readFile(new URL('./interests.txt', import.meta.url), 'utf8');
    const { searchAgent, researchAgent, updateSite } = makeAgents(job);
    const leads = await runStreaming(searchAgent, `Research profile:\n${interests}`, job, MAX_SEARCHES);

    if (job.controller.signal.aborted) throw job.controller.signal.reason || new Error('Job cancelled.');
    job.phase = 'verifying_sources';
    const result = await runStreaming(researchAgent, `Search leads to verify:\n${JSON.stringify(leads)}`, job, MAX_PAGE_READS + 1);

    job.result = filterVerifiedResult(result, job);
    for (const opportunity of job.result.opportunities) {
      await updateSite.invoke(undefined, JSON.stringify({
        title: opportunity.name,
        url: opportunity.officialSourceUrl,
        source_excerpt: opportunity.sourceExcerpt,
        why_it_fits: opportunity.description,
      }));
    }
    job.status = 'completed';
    job.phase = 'complete';
  } catch (error) {
    if (job.controller.signal.aborted) {
      job.status = 'cancelled';
      job.phase = 'cancelled';
      job.error = 'Job cancelled or timed out.';
    } else {
      job.status = 'error';
      job.phase = 'error';
      job.error = error instanceof Error ? error.message : 'Unknown job error.';
    }
  } finally {
    clearTimeout(timeout);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  const supplied = request.headers.agent_secret;
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(env.AGENT_SECRET);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('agent is running');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/jobs') {
    if (!authorized(request)) return sendJson(response, 401, { error: 'Unauthorized' });
    const job = {
      id: randomUUID(),
      status: 'queued',
      phase: 'queued',
      startedAt: Date.now(),
      startedAtMonotonic: performance.now(),
      searches: 0,
      pageReads: 0,
      toolCalls: [],
      searchIds: new Set(),
      openedUrls: new Set(),
      controller: new AbortController(),
      result: undefined,
      error: undefined,
    };
    jobs.set(job.id, job);
    void runJob(job);
    return sendJson(response, 202, { id: job.id });
  }

  const match = url.pathname.match(/^\/jobs\/([0-9a-f-]+)(?:\/cancel)?$/i);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return sendJson(response, 404, { error: 'Job not found' });

    if (request.method === 'GET' && !url.pathname.endsWith('/cancel')) {
      return sendJson(response, 200, publicJob(job));
    }
    if (request.method === 'POST' && url.pathname.endsWith('/cancel')) {
      if (!authorized(request)) return sendJson(response, 401, { error: 'Unauthorized' });
      if (job.status === 'queued' || job.status === 'running') job.controller.abort(new Error('Cancelled by client.'));
      return sendJson(response, 202, publicJob(job));
    }
  }

  return sendJson(response, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Opportunity agent listening on port ${PORT}`));
