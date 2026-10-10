import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyStitchCompletion, verifyStitchScreen, rejectInitialStitchDone } from "./stitch-completion-gate.js";

const companyId="company-test";
const designerId="design-agent-test";
const issue={id:"issue-test",companyId,assigneeAgentId:designerId,status:"in_review"};
const config={companyId,designerId};
const proof={authorAgentId:designerId,body:'STITCH_EVIDENCE: {"project_id":"projects/12","screen_id":"screens/34"}'};

describe("precommit Stitch status gate",()=>{
  it("passes a verified design screen",async()=>{
    const verify=vi.fn(async()=>true);
    await expect(verifyStitchCompletion({...config,issue,comments:[proof],verify})).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith("projects/12","screens/34");
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
    expect(calls[1].params.arguments.name).toBe("projects/12/screens/34");
    expect(calls.map(x=>x.method)).toEqual(["initialize","tools/call"]);
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
