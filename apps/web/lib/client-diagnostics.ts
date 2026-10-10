import type { Api } from "./api";
const kinds = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"]);
const views: Record<string, string> = {dashboard:"dashboard", clients:"crm", tracker:"tracker", scheduling:"scheduling", learning:"learning", planning:"planning"};
export function portalDiagnosticView(tab: string): string {
  return ({homework:"learning",resources:"learning",sessions:"scheduling",planning:"planning"} as Record<string,string>)[tab] ?? "other";
}
export type ClientDiagnostic = {kind:string; source:"window"|"promise"; view:string};
/** Never copy arbitrary error properties, messages, stacks or URL context. */
export function diagnosticEvent(error: unknown, source: "window"|"promise", view: string): ClientDiagnostic {
  let name = "";
  try { if (error instanceof Error || error instanceof DOMException) name = error.name; } catch { /* hostile getter */ }
  return {kind:kinds.has(name) ? name : "UnknownError",source,view:views[view] ?? "other"};
}
export function installClientDiagnostics(api: Api, view: () => string, target: Window = window) {
  let disposed=false, timer:ReturnType<typeof setTimeout>|undefined, sending=false, sent=0;
  const queue:ClientDiagnostic[]=[];
  const controller=new AbortController();
  const schedule=()=>{if(!disposed && !timer && !sending && queue.length && sent<50) timer=setTimeout(()=>{timer=undefined;void flush();},5000);};
  async function flush() {
    if(disposed || sending || !queue.length || sent>=50) return;
    sending=true;
    const events=queue.splice(0,Math.min(10,50-sent));
    // One attempt per batch. A failed report must never generate another error report.
    sent+=events.length;
    try {await api("platform/v1/client-diagnostics","POST",{events},undefined,{signal:controller.signal});} catch { /* best effort */ }
    sending=false;schedule();
  }
  const record=(error:unknown,source:"window"|"promise")=>{
    if(disposed || sent+queue.length>=50 || queue.length>=10) return;
    queue.push(diagnosticEvent(error,source,view()));schedule();
  };
  const onError=(event:ErrorEvent)=>record(event.error,"window");
  const onRejection=(event:PromiseRejectionEvent)=>record(event.reason,"promise");
  target.addEventListener("error",onError);
  target.addEventListener("unhandledrejection",onRejection);
  return ()=>{
    disposed=true;controller.abort();queue.length=0;if(timer)clearTimeout(timer);
    target.removeEventListener("error",onError);target.removeEventListener("unhandledrejection",onRejection);
  };
}
