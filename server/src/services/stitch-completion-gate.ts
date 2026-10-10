/**
 * Optional, company-scoped Stitch evidence gate: checked before the status
 * write in the issue row's locked transaction. Inactive until both IDs set.
 * The network endpoint is pinned to loopback.
 */
export interface StitchComment { authorAgentId?: string | null; body: string }
export interface StitchIssue { id: string; companyId: string; assigneeAgentId?: string | null; status: string }
export type StitchVerify = (projectId: string, screenId: string) => Promise<boolean>;
export interface StitchDoneGateOptions {
  companyId: string; designerId: string; issue: StitchIssue;
  comments: StitchComment[]; verify: StitchVerify;
}

const PREFIX = "STITCH_EVIDENCE:";
const PROJECT_NAME = /^(?:projects\/)?[a-zA-Z0-9_-]{1,100}$/;
const SCREEN_NAME = /^(?:screens\/)?[a-zA-Z0-9_-]{1,100}$/;
const STITCH_MCP_URL = "http://127.0.0.1:9215/mcp";

function parseEvidence(comment: StitchComment, author: string): [string,string] | null {
  if (comment.authorAgentId !== author) return null;
  for (const line of comment.body.split(/\r?\n/)) {
    if (!line.startsWith(PREFIX) || line.length > 550) continue;
    try {
      const value: unknown = JSON.parse(line.slice(PREFIX.length).trim());
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const data = value as Record<string,unknown>;
      if (Object.keys(data).sort().join(",") !== "project_id,screen_id") continue;
      if (typeof data.project_id !== "string" || typeof data.screen_id !== "string") continue;
      if (!PROJECT_NAME.test(data.project_id) || !SCREEN_NAME.test(data.screen_id)) continue;
      return [data.project_id,data.screen_id];
    } catch { /* invalid proof */ }
  }
  return null;
}

export function rejectInitialStitchDone({
  companyId,designerId,issue,
}: Pick<StitchDoneGateOptions,"companyId"|"designerId"|"issue">): void {
  if (issue.companyId===companyId && issue.assigneeAgentId===designerId
    && issue.status==="done")
    throw Error("Stitch proof required before initial design Done");
}

export async function verifyStitchCompletion(options: StitchDoneGateOptions): Promise<void> {
  const {companyId, designerId, issue, comments, verify} = options;
  if (issue.companyId !== companyId || issue.assigneeAgentId !== designerId) return;
  const pair = [...comments].reverse().map((x)=>parseEvidence(x,designerId)).find((x)=>x !== null);
  if (!pair) throw Error("Stitch proof required: add STITCH_EVIDENCE before Done");
  let accepted=false;
  try { accepted=await verify(...pair); } catch { /* fail closed on outages */ }
  if (!accepted) throw Error("Stitch screen verification failed; keep issue in_review");
}

function parseSse(body: string, requestId: number): Record<string,any> {
  const candidates=body.trimStart().startsWith("{") ? [body] :
    body.split(/\r?\n/).filter((line)=>line.startsWith("data:")).map((line)=>line.slice(5).trim());
  for (const candidate of candidates) {
    try {
      const data=JSON.parse(candidate);
      if (data.id===requestId && data.result) return data.result as Record<string,any>;
    } catch { /* SSE heartbeat */ }
  }
  throw Error("Missing MCP response");
}

export async function verifyStitchScreen(projectId: string, screenId: string): Promise<boolean> {
  const canonical="projects/"+projectId.replace(/^projects\//,"")+
    "/screens/"+screenId.replace(/^screens\//,"");
  let sessionId: string|null=null;
  const exchange=async(id:number,method:string,params:Record<string,unknown>)=>{
    const headers:Record<string,string>={
      "Content-Type":"application/json",Accept:"application/json, text/event-stream",
    };
    if(sessionId) headers["Mcp-Session-Id"]=sessionId;
    const response=await fetch(STITCH_MCP_URL,{
      method:"POST",headers,signal:AbortSignal.timeout(3500),
      body:JSON.stringify({jsonrpc:"2.0",id,method,params}),
    });
    if(!response.ok) throw Error("Stitch MCP unavailable");
    sessionId=response.headers.get("mcp-session-id") ?? sessionId;
    const body=await response.text();
    if(body.length>12_000_000) throw Error("Stitch MCP oversized response");
    return parseSse(body,id);
  };
  await exchange(1,"initialize",{
    protocolVersion:"2025-03-26",capabilities:{},
    clientInfo:{name:"paperclip-stitch-gate",version:"1"},
  });
  const result=await exchange(2,"tools/call",{name:"get_screen",arguments:{name:canonical}});
  return result.isError!==true &&
    ((Array.isArray(result.content) && result.content.length>0) || !!result.structuredContent);
}

export function stitchGateConfig(env:NodeJS.ProcessEnv=process.env):
  {companyId:string;designerId:string}|null {
  const companyId=env.PAPERCLIP_STITCH_GATE_COMPANY_ID;
  const designerId=env.PAPERCLIP_STITCH_GATE_AGENT_ID;
  if(!companyId||!designerId) return null;
  return {companyId,designerId};
}
