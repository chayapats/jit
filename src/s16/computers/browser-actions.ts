import { AppError } from "../../errors";

/** Guest positively refused the atomic batch before any input (unlike a lost/uncertain CDP response). */
export class BrowserDispatchRefused extends AppError {}

export type BrowserInput = { kind: "click" | "submit"; target: string; generation: number; tab?: string } | { kind: "type" | "select"; target: string; value: string; generation: number; tab?: string };
export interface BrowserActionFacts { url: string; ref: string; name: string; tag: string; type: string; formNames: string[]; fields: { name: string; htmlName?: string; value: string }[]; revision: string }
export type HumanBrowserRow = "a" | "b" | "c" | "d" | "e" | "f";
const vocabulary: [HumanBrowserRow, RegExp][] = [
  ["a", /\b(pay|buy|purchase|checkout|order|transfer|subscribe)\b|จ่าย|ชำระ|ซื้อ|สั่งซื้อ|โอน|สมัครสมาชิก/iu],
  ["b", /\bsend\b|ส่งข้อความ|ส่งอีเมล|ส่งเมล/iu],
  ["c", /\b(post|publish|share publicly)\b|โพสต์|เผยแพร่|แชร์สาธารณะ/iu],
  ["d", /\b(deploy|release|promote to production)\b|ดีพลอย|นำขึ้นใช้งานจริง|ปล่อยรุ่น/iu],
  ["e", /\b(delete|remove|cancel account|close account)\b|ลบ|ยกเลิกบัญชี|ปิดบัญชี/iu],
  ["f", /\b(password|account settings|security|permissions)\b|รหัสผ่าน|ตั้งค่าบัญชี|ความปลอดภัย|สิทธิ์/iu],
];
/** ADR 0092 D6: not exec.browser's blanket submit/newline rule. This is a tool heuristic, not a sandbox. */
export function humanBrowserRow(op: BrowserInput, facts: BrowserActionFacts): HumanBrowserRow | null {
  if (op.kind === "type" && !/[\r\n]/u.test(op.value)) return null;
  let path = new URL(facts.url).pathname; try { path = decodeURIComponent(path); } catch { /* literal invalid escape */ }
  const text = [facts.name, ...facts.formNames, path.replace(/[_/-]+/gu, " ")].join(" ");
  return vocabulary.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** Fixed page programs. The private node registry carries no selectors or callable handles across the tool boundary. */
export const browserDomHelpers = `
 const secret=e=>['password','file','hidden'].includes((e.getAttribute('type')||'').toLowerCase()) || (e.getAttribute('autocomplete')||'').toLowerCase().split(/\\s+/).includes('one-time-code');
 const excluded='script,style,noscript,input,textarea,select,[contenteditable]';
 const safeText=root=>{const parts=[];const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const p=n.parentElement;if(!p||p.closest(excluded))continue;const s=getComputedStyle(p);if(s.display!=='none'&&s.visibility!=='hidden')parts.push(n.textContent||'');}return parts.join(' ').trim();};
 const name=(e,inputButtons=false)=>{if(e.closest('[contenteditable]'))return '';const labelled=(e.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean).map(safeText).join(' ');
 const labels=Array.from(e.labels||document.querySelectorAll('label')).filter(l=>l.control===e||(e.id&&l.getAttribute('for')===e.id)||l.contains(e)).map(safeText).join(' ');
 const content=(e.tagName==='BUTTON'||e.tagName==='A'||e.getAttribute('role')==='button')?safeText(e):(inputButtons&&e.tagName==='INPUT'&&['submit','button','reset'].includes((e.getAttribute('type')||'').toLowerCase()))?String(e.value||''):'';
 return labelled||e.getAttribute('aria-label')||labels||content||e.getAttribute('title')||e.getAttribute('name')||'';};
 if(globalThis.__jitComputerNodes?.document!==document)globalThis.__jitComputerNodes={document,nodes:new Map(),ids:new WeakMap()};
 const registry=globalThis.__jitComputerNodes;
 for(const [id,node] of registry.nodes)if(!node.deref()?.isConnected)registry.nodes.delete(id);
 const ref=e=>{let id=registry.ids.get(e);if(!id||!registry.nodes.has(id)){if(registry.nodes.size>=1024)registry.nodes.delete(registry.nodes.keys().next().value);id=crypto.randomUUID();registry.ids.set(e,id);registry.nodes.set(id,new WeakRef(e));}return id;};
 const setValue=(e,value)=>{const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set;if(set)set.call(e,value);else e.value=value;};
 const facts=e=>{const all=Array.from((e.form||e.closest('form'))?.elements||[e]);const fields=all.filter(f=>!secret(f)).map(f=>({name:name(f,true),htmlName:f.getAttribute('name')||'',value:String(f.value||''),type:(f.getAttribute('type')||'').toLowerCase(),disabled:!!f.disabled,checked:['checkbox','radio'].includes((f.getAttribute('type')||'').toLowerCase())?!!f.checked:undefined,selected:f.tagName==='SELECT'?Array.from(f.options).filter(o=>o.selected).map(o=>o.value):undefined}));
  if(fields.length>100||fields.some(f=>f.value.length>12000))return {code:'computer_browser_snapshot_limit'};
  const target={ref:ref(e),name:name(e,true),tag:e.tagName.toLowerCase(),type:(e.getAttribute('type')||'').toLowerCase(),href:e.getAttribute('href'),formaction:e.getAttribute('formaction'),formmethod:e.getAttribute('formmethod'),disabled:!!e.disabled,readOnly:!!e.readOnly};
  const form=e.form||e.closest('form');const data={url:location.href,...target,formAction:form?.getAttribute('action'),formMethod:form?.getAttribute('method'),formNames:all.flatMap(f=>[f.getAttribute('name')||'',name(f,true)]),fields};
  return {...data,revision:JSON.stringify(data)};};
`;
export const computerBrowserObservation = `(() => {${browserDomHelpers}
 const text=[];const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);let node,length=0;
 while((node=walker.nextNode())&&length<12000){const p=node.parentElement;if(!p||p.closest(excluded))continue;const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')continue;const t=(node.textContent||'').trim().slice(0,12000-length);if(t){text.push(t);length+=t.length;}}
 const elements=Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[contenteditable]')).slice(0,100).map(e=>({ref:ref(e),tag:e.tagName.toLowerCase(),type:(e.getAttribute('type')||'').toLowerCase(),name:name(e).slice(0,128)}));
 return {url:location.href,text:text.join('\\n'),truncated:length>=12000,elements};
})()`;
export function inspectBrowserTarget(ref: string): string {
  return `(() => {${browserDomHelpers}const e=registry.nodes.get(${JSON.stringify(ref)})?.deref();if(!e||!e.isConnected||e.ownerDocument!==document)return {code:'computer_browser_stale'};if(secret(e))return {code:'computer_browser_secret_field'};return facts(e);})()`;
}
/** Revision and secret-field recheck are in the same synchronous task as input: no awaited DOM TOCTOU gap. */
export function dispatchBrowserTarget(ref: string, revision: string, op: BrowserInput): string {
  const payload = JSON.stringify({ kind: op.kind, value: "value" in op ? op.value : undefined });
  return `(() => {${browserDomHelpers}
 const e=registry.nodes.get(${JSON.stringify(ref)})?.deref();if(!e||!e.isConnected||e.ownerDocument!==document)return {code:'computer_browser_stale'};
 if(secret(e))return {code:'computer_browser_secret_field'};
 const live=facts(e);if(live.code)return live;if(live.revision!==${JSON.stringify(revision)})return {code:'computer_browser_stale'};
 const op=${payload};if(e.disabled)return {code:'computer_browser_target_invalid'};
 if(op.kind==='click')e.click();
 else if(op.kind==='submit'){const form=e.form||e.closest('form');if(!form)return {code:'computer_browser_target_invalid'};form.requestSubmit(e.matches('button:not([type]),button[type=submit],input[type=submit]')?e:undefined);}
 else if(op.kind==='select'){if(e.tagName!=='SELECT'||!Array.from(e.options).some(o=>o.value===op.value&&!o.disabled))return {code:'computer_browser_target_invalid'};setValue(e,op.value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
 else {if(!['INPUT','TEXTAREA'].includes(e.tagName)||e.readOnly)return {code:'computer_browser_target_invalid'};e.focus();const enter=/[\\r\\n]/.test(op.value);setValue(e,op.value.replace(/[\\r\\n]/g,''));e.dispatchEvent(new Event('input',{bubbles:true}));if(enter){e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));if(e.form)e.form.requestSubmit();}}
 return {state:'sent'};
})()`;
}
export function actionFacts(value: unknown): BrowserActionFacts {
  if (!value || typeof value !== "object") throw new AppError("computer_browser_unavailable", 409);
  const v = value as Record<string, unknown>;
  if (typeof v.code === "string") throw new AppError(v.code, 409);
  if (typeof v.url !== "string" || typeof v.ref !== "string" || typeof v.revision !== "string" || !Array.isArray(v.fields) || !Array.isArray(v.formNames) || Buffer.byteLength(JSON.stringify(v)) > 32768) throw new AppError("computer_browser_snapshot_limit", 409);
  return v as unknown as BrowserActionFacts;
}
