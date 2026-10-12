import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { challengeSummary } from './platform-store.ts';
import { getUser, parseBundle, saveBundle, userByToken } from './store.ts';
import { currentWorkflowScore, publicWorkflowScore } from './workflow-view.ts';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

const drillBySkill: Record<string, { id: string; title: string }> = {
  framing: { id: 'frame-expense-tracker', title: 'Turn an idea into a build brief' },
  context: { id: 'context-select-evidence', title: 'Build a useful context packet' },
  debugging: { id: 'debug-retry-loop', title: 'Stop an unproductive fix loop' },
  verification: { id: 'verify-pagination', title: 'Test what the demo missed' },
  review: { id: 'review-ai-patch', title: 'Review a patch that weakens a test' },
  efficiency: { id: 'efficiency-context-budget', title: 'Spend context where it helps' },
};

function authenticatedHandle(extra: any): string {
  const handle = extra?.authInfo?.extra?.handle;
  if (typeof handle !== 'string') throw new Error('Authenticate with a VibeScore collector token to publish workflow evidence.');
  return handle;
}

function createRemoteServer() {
  const remote = new McpServer({ name: 'vibescore-scoring-agent', version: '0.3.0' });
  remote.registerTool('describe_scoring', {
    description: 'Explain what VibeScore measures, which evidence is provisional, and what can affect a public rating.', inputSchema: {},
  }, async () => text({
    workflow: 'Local Claude Code and Codex sessions are reduced to numeric workflow signals. Imported evidence is provisional and user-controlled.',
    challenge: 'Controlled JavaScript interview ratings use the first completed rated attempt for each task and objective server-side tests.',
    separation: 'Workflow and challenge ratings remain separate on profiles and leaderboards.',
    privacy: 'Raw prompts, source code, commands, paths, and filenames are not accepted by this hosted scoring tool.',
  }));
  remote.registerTool('recommend_drill', {
    description: 'Return one focused VibeScore drill for an observed AI-building skill gap.',
    inputSchema: { skill: z.enum(['framing', 'context', 'debugging', 'verification', 'review', 'efficiency']) },
  }, async ({ skill }) => {
    const drill = drillBySkill[skill];
    return text({ skill, ...drill, path: `/challenge/${drill.id}`, note: 'A practice recommendation is coaching, not rated evidence.' });
  });
  remote.registerTool('publish_workflow_report', {
    description: 'Publish an exact privacy-reduced workflow bundle after preview. Requires its matching SHA-256, confirm=true, and a VibeScore collector token.',
    inputSchema: { bundle: z.unknown(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) },
  }, async ({ bundle, expected_sha256 }, extra) => {
    const handle = authenticatedHandle(extra);
    const clean = parseBundle(bundle);
    const digest = createHash('sha256').update(JSON.stringify(clean)).digest('hex');
    if(digest!==expected_sha256)throw new Error('The bundle does not match the approved preview digest.');
    saveBundle(handle, clean);
    return text({ published: true, handle, score: currentWorkflowScore(handle) });
  });
  remote.registerTool('preview_workflow_report', {
    description: 'Validate and preview the exact aggregate workflow bundle before publication. Returns the SHA-256 required by publish_workflow_report.',
    inputSchema: { bundle: z.unknown() },
  }, async ({ bundle }) => {
    const clean=parseBundle(bundle),sha256=createHash('sha256').update(JSON.stringify(clean)).digest('hex');
    return text({sha256,upload:clean,privacy:'Only validated aggregate metrics are included; no prompts, code, repository paths, or filenames.'});
  });
  remote.registerTool('verify_public_profile', {
    description: 'Return the public evidence summary for a VibeScore handle without exposing private attempts or raw workflow data.',
    inputSchema: { handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,23}$/) },
  }, async ({ handle }) => {
    const user = getUser(handle);
    if (!user?.isPublic) throw new Error('Public VibeScore profile not found.');
    return text({ handle, challenge: challengeSummary(handle), workflow: publicWorkflowScore(handle), profilePath: `/profile/${handle}` });
  });
  return remote;
}

export function remoteMcpMetadata(origin: string) {
  return {
    name: 'VibeScore Scoring Agent', version: '0.3.0', protocol: 'MCP', transport: 'STREAMABLE-HTTP',
    endpoint: `${origin.replace(/\/$/, '')}/mcp`,
    tools: ['describe_scoring', 'recommend_drill', 'preview_workflow_report', 'publish_workflow_report', 'verify_public_profile'],
    privacy: 'Project collection stays local. The hosted agent accepts only validated aggregate workflow bundles.',
  };
}

export async function handleRemoteMcp(req: IncomingMessage & { auth?: any }, res: ServerResponse, parsedBody?: unknown) {
  const authorization = String(req.headers.authorization ?? '');
  const raw = authorization.startsWith('Bearer ') ? authorization.slice(7) : String(req.headers['x-token'] ?? '');
  const user = raw ? userByToken(raw, 'api') : null;
  if (user) req.auth = { token: 'validated', clientId: 'vibescore-local-collector', scopes: ['workflow:publish'], extra: { handle: user.handle } };
  // Stateless Streamable HTTP requires a fresh protocol instance per request;
  // initialization, notifications, and calls may arrive on separate requests.
  const remote = createRemoteServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await remote.connect(transport);
  try { await transport.handleRequest(req, res, parsedBody); }
  finally { await transport.close(); await remote.close(); }
}
