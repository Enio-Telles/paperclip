/**
 * Optional, company-scoped Stitch evidence gate: checked before the status
 * write in the issue row's locked transaction. Inactive until both IDs set.
 * The network endpoint is pinned to loopback.
 */
export interface StitchComment { authorAgentId?: string | null; body: string }
export interface StitchIssue { id: string; companyId: string; assigneeAgentId?: string | null; status: string }
export type StitchVerify = (projectId: string, screenId: string) => Promise<boolean>;
export interface DesignWorkProduct {
  id: string; companyId: string; issueId: string; type: string;
  provider: string; status: string; reviewState: string; url?: string | null;
}
export interface StitchDoneGateOptions {
  companyId: string; designerId: string; issue: StitchIssue;
  comments: StitchComment[]; verify: StitchVerify;
  workProducts?: DesignWorkProduct[];
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

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const FALLBACK_REASONS = new Set([
  "stitch_unavailable","quota_exceeded","integration_error","unsupported_request","user_choice",
]);
const FALLBACK_METHODS = new Set(["figma","agy-carine","frontend-code","manual"]);
function fallbackEvidence(comment: StitchComment, author: string):
    {reason:string;method:string;workProductId:string}|null {
  if(comment.authorAgentId!==author)return null;
  for(const line of comment.body.split(/\r?\n/)){
    if(!line.startsWith("DESIGN_FALLBACK_EVIDENCE:") || line.length>550)continue;
    try {
      const raw:unknown=JSON.parse(line.slice("DESIGN_FALLBACK_EVIDENCE:".length).trim());
      if(!raw || typeof raw!=="object" || Array.isArray(raw))continue;
      const data=raw as Record<string,unknown>;
      if(Object.keys(data).sort().join(",")!=="method,reason,work_product_id")continue;
      if(typeof data.reason!=="string" || !FALLBACK_REASONS.has(data.reason))continue;
      if(typeof data.method!=="string" || !FALLBACK_METHODS.has(data.method))continue;
      if(typeof data.work_product_id!=="string" || !UUID.test(data.work_product_id))continue;
      return {reason:data.reason,method:data.method,workProductId:data.work_product_id};
    }catch{/*invalid fallback evidence*/}
  }
  return null;
}
function validReviewedFallback(options:StitchDoneGateOptions): boolean {
  const {issue,comments,workProducts=[],designerId}=options;
  for(const comment of comments){
    const proof=fallbackEvidence(comment,designerId);
    if(!proof)continue;
    const product=workProducts.find(x=>x.id.toLowerCase()===proof.workProductId.toLowerCase() &&
      x.companyId===issue.companyId && x.issueId===issue.id &&
      x.reviewState==="approved" && x.status==="approved" &&
      (x.type==="artifact" || x.type==="preview_url" || x.type==="document") &&
      x.provider===proof.method &&
      typeof x.url==="string" &&
      (/^https:\/\/[^\s]+$/i.test(x.url) || /^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(x.url)));
    if(product)return true;
  }
  return false;
}

export async function verifyStitchCompletion(options: StitchDoneGateOptions): Promise<void> {
  const {companyId, designerId, issue, comments, verify} = options;
  if (issue.companyId !== companyId || issue.assigneeAgentId !== designerId) return;
  const pair=comments.map((x)=>parseEvidence(x,designerId)).find((x)=>x!==null);
  if(pair){
    try{if(await verify(...pair))return;}catch{/* try a reviewed alternate design */}
  }
  if(validReviewedFallback(options))return;
  throw Error("Design completion needs verified Stitch screen or an approved alternative work product");
}

function parseSse(body: string, requestId: number): Record<string,any> {
  if(body.trimStart().startsWith("{")){
    const data=JSON.parse(body);
    if(data.id===requestId && data.result)return data.result as Record<string,any>;
  }
  const events:string[]=[];
  let lines:string[]=[];
  for(const line of body.split(/\r?\n/)){
    if(line.startsWith("data:"))lines.push(line.slice(5).trimStart());
    else if(line===""){
      if(lines.length)events.push(lines.join("\n"));
      lines=[];
    }
  }
  if(lines.length)events.push(lines.join("\n"));
  for(const item of events){
    try{
      const data=JSON.parse(item);
      if(data.id===requestId && data.result)return data.result as Record<string,any>;
    }catch{/* SSE heartbeat or non-JSON event */}
  }
  throw Error("Missing MCP response");
}

export async function verifyStitchScreen(projectId: string, screenId: string): Promise<boolean> {
  const canonical="projects/"+projectId.replace(/^projects\//,"")+
    "/screens/"+screenId.replace(/^screens\//,"");
  let sessionId:string|null=null;
  let version:string|null=null;
  const exchange=async(id:number|null,method:string,params:Record<string,unknown>)=>{
    const headers:Record<string,string>={
      "Content-Type":"application/json",Accept:"application/json, text/event-stream",
    };
    if(sessionId)headers["Mcp-Session-Id"]=sessionId;
    if(version)headers["MCP-Protocol-Version"]=version;
    const payload:Record<string,unknown>={jsonrpc:"2.0",method,params};
    if(id!==null)payload.id=id;
    const response=await fetch(STITCH_MCP_URL,{
      method:"POST",headers,signal:AbortSignal.timeout(3500),
      body:JSON.stringify(payload),
    });
    if(!response.ok)throw Error("Stitch MCP unavailable");
    sessionId=response.headers.get("mcp-session-id") ?? sessionId;
    if(id===null){
      await response.body?.cancel();
      return {};
    }
    const maxBytes=12_000_000;
    const declared=Number(response.headers.get("content-length") ?? 0);
    if(declared>maxBytes)throw Error("Stitch MCP oversized response");
    if(!response.body)throw Error("Stitch MCP empty response");
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let body="";
    let count=0;
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        count+=value.byteLength;
        if(count>maxBytes){
          await reader.cancel("MCP size cap");
          throw Error("Stitch MCP oversized response");
        }
        body+=decoder.decode(value,{stream:true});
      }
      body+=decoder.decode();
    }finally{reader.releaseLock();}
    return parseSse(body,id);
  };
  const init=await exchange(1,"initialize",{
    protocolVersion:"2025-03-26",capabilities:{},
    clientInfo:{name:"paperclip-stitch-gate",version:"1"},
  });
  version=typeof init.protocolVersion==="string" ? init.protocolVersion : "2025-03-26";
  await exchange(null,"notifications/initialized",{});
  const result=await exchange(2,"tools/call",{name:"get_screen",arguments:{name:canonical}});
  return result.isError!==true &&
    ((Array.isArray(result.content) && result.content.length>0) || !!result.structuredContent);
}

export function stitchGateConfig(env:NodeJS.ProcessEnv=process.env):
  {companyId:string;designerId:string}|null {
  const companyId=env.PAPERCLIP_STITCH_GATE_COMPANY_ID?.trim().toLowerCase();
  const designerId=env.PAPERCLIP_STITCH_GATE_AGENT_ID?.trim().toLowerCase();
  if(!companyId||!designerId || !UUID.test(companyId) || !UUID.test(designerId))return null;
  return {companyId,designerId};
}
