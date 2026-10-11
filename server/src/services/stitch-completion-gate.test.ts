import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyStitchCompletion, verifyStitchScreen, rejectInitialStitchDone, stitchGateConfig, shouldCheckStitchTransition, fallbackWorkProductIds } from "./stitch-completion-gate.js";

const companyId="company-test";
const designerId="design-agent-test";
const issue={id:"issue-test",companyId,assigneeAgentId:designerId,status:"in_review",isDesignIssue:true};
const config={companyId,designerId};
const proof={authorAgentId:designerId,body:'STITCH_EVIDENCE: {"project_id":"projects/12","screen_id":"screens/34"}'};

describe("precommit Stitch status gate",()=>{
  it("passes a verified design screen",async()=>{
    const verify=vi.fn(async()=>true);
    await expect(verifyStitchCompletion({...config,issue,comments:[proof],verify})).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith("projects/12","screens/34");
  });
  it("uses the newest valid Stitch proof instead of an older stale proof",async()=>{
    const newer={...proof,body:'STITCH_EVIDENCE: {"project_id":"projects/new","screen_id":"screens/new"}'};
    const older={...proof,body:'STITCH_EVIDENCE: {"project_id":"projects/old","screen_id":"screens/old"}'};
    const verify=vi.fn(async(p:string,s:string)=>p==="projects/new" && s==="screens/new");
    await expect(verifyStitchCompletion({...config,issue,comments:[newer,older],verify})).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith("projects/new","screens/new");
  });
  it("blocks absent evidence, without calling the network",async()=>{
    const verify=vi.fn(async()=>true);
    await expect(verifyStitchCompletion({...config,issue,comments:[],verify})).rejects.toThrow(/stitch/i);
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects a forged receipt posted by another agent",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[{...proof,authorAgentId:"other"}],verify:async()=>true})).rejects.toThrow();
  });
  it("rejects a nonexistent screen and Stitch outage",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[proof],verify:async()=>false})).rejects.toThrow();
    await expect(verifyStitchCompletion({...config,issue,comments:[proof],verify:async()=>{throw Error("timeout")}})).rejects.toThrow();
  });
  it("does not gate other agents or companies",async()=>{
    const verify=vi.fn(async()=>false);
    await verifyStitchCompletion({...config,issue:{...issue,assigneeAgentId:"other"},comments:[],verify});
    await verifyStitchCompletion({...config,issue:{...issue,companyId:"other"},comments:[],verify});
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects an untrusted resource name",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[{...proof,body:'STITCH_EVIDENCE: {"project_id":"https://evil.test","screen_id":"screens/34"}'}],verify:async()=>true})).rejects.toThrow();
  });
});

describe("create-time completion guard",()=>{
  it("rejects creating a design issue directly in Done",()=>{
    expect(()=>rejectInitialStitchDone({
      companyId,designerId,issue:{...issue,status:"done"},
    })).toThrow(/Stitch/i);
  });
  it("allows initial design issues in review and non-design Done",()=>{
    expect(()=>rejectInitialStitchDone({companyId,designerId,issue})).not.toThrow();
    expect(()=>rejectInitialStitchDone({companyId,designerId,
      issue:{...issue,status:"done",assigneeAgentId:"other"}})).not.toThrow();
  });
});

describe("Stitch MCP integration",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("uses the canonical Stitch get_screen resource path",async()=>{
    const calls: any[]=[];
    vi.stubGlobal("fetch",vi.fn(async (_url: string, init: any)=>{
      const body=JSON.parse(init.body);
      calls.push(body);
      const response={jsonrpc:"2.0",id:body.id,result:
        body.method==="initialize" ? {serverInfo:{name:"stitch-proxy"}} :
        {content:[{type:"text",text:"screen found"}]}
      };
      return new Response("event: message\ndata: "+JSON.stringify(response)+"\n\n",
        {status:200,headers:{"Mcp-Session-Id":"s-123"}});
    }));
    await expect(verifyStitchScreen("projects/12","screens/34")).resolves.toBe(true);
    expect(calls[2].params.arguments.name).toBe("projects/12/screens/34");
    expect(calls.map(x=>x.method)).toEqual(["initialize","notifications/initialized","tools/call"]);
  });
  it("performs MCP initialize notification with negotiated protocol version",async()=>{
    const calls:any[]=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init:any)=>{
      const body=JSON.parse(init.body);
      calls.push({body,headers:init.headers});
      if(body.method==="notifications/initialized"){
        return new Response(null,{status:202});
      }
      const result=body.method==="initialize"
        ? {protocolVersion:"2025-03-26",serverInfo:{name:"stitch-proxy"}}
        : {content:[{type:"text",text:"screen found"}]};
      return new Response("data: "+JSON.stringify({jsonrpc:"2.0",id:body.id,result})+"\n\n",
        {status:200,headers:{"Mcp-Session-Id":"s-123"}});
    }));
    await expect(verifyStitchScreen("projects/12","screens/34")).resolves.toBe(true);
    expect(calls.map(x=>x.body.method)).toEqual(["initialize","notifications/initialized","tools/call"]);
    expect(calls[2].headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });
  it("accepts a standards-compliant multiline SSE JSON result",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init:any)=>{
      const msg=JSON.parse(init.body);
      if(msg.method==="notifications/initialized")return new Response(null,{status:202});
      const data={jsonrpc:"2.0",id:msg.id,result:msg.method==="initialize" ?
        {protocolVersion:"2025-03-26"} : {content:[{type:"text",text:"screen"}]}};
      const json=JSON.stringify(data);
      const idx=json.indexOf(',"result"')+1;
      const body="event: message\ndata: "+json.slice(0,idx)+"\ndata: "+json.slice(idx)+"\n\n";
      return new Response(body,{status:200});
    }));
    await expect(verifyStitchScreen("projects/12","screens/34")).resolves.toBe(true);
  });
  it("uses one overall MCP deadline across all requests",async()=>{
    const signals:AbortSignal[]=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init:any)=>{
      signals.push(init.signal);
      const body=JSON.parse(init.body);
      if(body.method==="notifications/initialized")return new Response(null,{status:202});
      const result=body.method==="initialize"?{protocolVersion:"2025-03-26"}:{content:[{type:"text",text:"screen"}]};
      return new Response("data: "+JSON.stringify({jsonrpc:"2.0",id:body.id,result})+"\n\n",{status:200});
    }));
    await expect(verifyStitchScreen("projects/12","screens/34")).resolves.toBe(true);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]).toBe(signals[2]);
  });
  it("fails closed when Stitch MCP returns an error",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(_url: string,init: any)=>{
      const body=JSON.parse(init.body);
      const r={jsonrpc:"2.0",id:body.id,result:body.method==="initialize" ?
        {serverInfo:{name:"stitch-proxy"}} :
        {isError:true,content:[{type:"text",text:"not found"}]}};
      return new Response("event: message\ndata: "+JSON.stringify(r)+"\n\n",
        {status:200,headers:{"Mcp-Session-Id":"s-123"}});
    }));
    await expect(verifyStitchScreen("projects/12","screens/unknown")).resolves.toBe(false);
  });
});


describe("scope normalization",()=>{
  it("normalizes uppercase config UUIDs to match database IDs",()=>{
    const company="16cfee44-52ba-4fb8-bc24-d4a2edfd00db";
    const designer="4b21d3b2-9d11-4b1c-884e-292742b7894a";
    const designLabel="88888888-8888-4888-8888-888888888888";
    expect(stitchGateConfig({
      PAPERCLIP_STITCH_GATE_COMPANY_ID:company.toUpperCase(),
      PAPERCLIP_STITCH_GATE_AGENT_ID:designer.toUpperCase(),
      PAPERCLIP_STITCH_GATE_LABEL_ID:designLabel.toUpperCase(),
    })).toEqual({companyId:company,designerId:designer,labelId:designLabel});
    expect(stitchGateConfig({
      PAPERCLIP_STITCH_GATE_COMPANY_ID:company,
      PAPERCLIP_STITCH_GATE_AGENT_ID:designer,
    })).toBeNull();
    expect(stitchGateConfig({
      PAPERCLIP_STITCH_GATE_COMPANY_ID:"invalid",
      PAPERCLIP_STITCH_GATE_AGENT_ID:designer,
    })).toBeNull();
  });
});

describe("scope and update transitions",()=>{
  const scope={companyId,designerId,labelId:"88888888-8888-4888-8888-888888888888"};
  it("requires design label even for a design-agent Done",async()=>{
    const verify=vi.fn(async()=>true);
    await expect(verifyStitchCompletion({...scope,issue:{...issue,isDesignIssue:false},comments:[],verify})).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    expect(()=>rejectInitialStitchDone({...scope,issue:{...issue,status:"done",isDesignIssue:false}})).not.toThrow();
  });
  it("gates reassigning a completed labeled issue to the designer without a status patch",()=>{
    expect(shouldCheckStitchTransition({
      existingStatus:"done",nextStatus:undefined,
      previousAssignee:"other",nextAssignee:designerId,
      isDesignIssue:true,designerId,
    })).toBe(true);
  });
  it("checks adding a design label to an already Done issue",()=>{
    expect(shouldCheckStitchTransition({
      existingStatus:"done",nextStatus:undefined,
      previousAssignee:designerId,nextAssignee:undefined,
      isDesignIssue:true,designLabelAdded:true,designerId,
    })).toBe(true);
  });
  it("does not gate unrelated assignment changes",()=>{
    expect(shouldCheckStitchTransition({
      existingStatus:"done",nextStatus:undefined,
      previousAssignee:"other",nextAssignee:designerId,
      isDesignIssue:false,designerId,
    })).toBe(false);
  });
  it("gates direct Done transition for labeled issues assigned to designer",()=>{
    expect(shouldCheckStitchTransition({
      existingStatus:"in_review",nextStatus:"done",
      previousAssignee:designerId,nextAssignee:undefined,
      isDesignIssue:true,designerId,
    })).toBe(true);
  });
});
describe("indexed work product evidence",()=>{
  it("extracts only a designer-authored UUID from latest fallback receipt",()=>{
    const good='11111111-1111-4111-8111-111111111111';
    const body='DESIGN_FALLBACK_EVIDENCE: {"reason":"stitch_unavailable","method":"agy-carine","work_product_id":"'+good+'"}';
    expect(fallbackWorkProductIds([{authorAgentId:designerId,body},
      {authorAgentId:"other",body:body.replace(good,"22222222-2222-4222-8222-222222222222")}],designerId)).toEqual([good]);
  });
});
describe("reviewed design fallback",()=>{
  const fallback={authorAgentId:designerId,
    body:'DESIGN_FALLBACK_EVIDENCE: {"reason":"stitch_unavailable","method":"agy-carine","work_product_id":"11111111-1111-4111-8111-111111111111"}'};
  const product={id:"11111111-1111-4111-8111-111111111111",
    issueId:issue.id,companyId,reviewState:"approved",status:"approved",
    type:"preview_url",provider:"agy-carine",url:"https://example.org/design-preview"};
  it("accepts an approved real work product when Stitch is unavailable",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[fallback],
      workProducts:[product],verify:async()=>{throw Error("Stitch offline")}})).resolves.toBeUndefined();
  });
  it("rejects malformed HTTPS URLs despite artifact review approval",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[fallback],
      workProducts:[{...product,url:"https://?"}],verify:async()=>false})).rejects.toThrow();
    await expect(verifyStitchCompletion({...config,issue,comments:[fallback],
      workProducts:[{...product,url:"https://"}],verify:async()=>false})).rejects.toThrow();
  });
  it("uses an already approved alternative without waiting for Stitch",async()=>{
    const verify=vi.fn(async()=>{throw Error("Stitch offline")});
    await expect(verifyStitchCompletion({...config,issue,
      comments:[proof,fallback],workProducts:[product],verify})).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects an unapproved fallback work product",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[fallback],
      workProducts:[{...product,reviewState:"none"}],verify:async()=>false})).rejects.toThrow();
  });
  it("rejects work products from another issue or a forged fallback comment",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[fallback],
      workProducts:[{...product,issueId:"other"}],verify:async()=>false})).rejects.toThrow();
    await expect(verifyStitchCompletion({...config,issue,comments:[{...fallback,authorAgentId:"other"}],
      workProducts:[product],verify:async()=>false})).rejects.toThrow();
  });
  it("accepts deliberate alternative design only with reviewed artifact",async()=>{
    await expect(verifyStitchCompletion({...config,issue,comments:[{
      ...fallback,body:fallback.body.replace("stitch_unavailable","user_choice").replace("agy-carine","figma"),
    }],workProducts:[{...product,provider:"figma"}],verify:async()=>false})).resolves.toBeUndefined();
  });
});
