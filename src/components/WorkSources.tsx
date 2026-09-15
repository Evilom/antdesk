import {useState} from 'react';
import {linkedSources,type LinkedSource,type WorkPackage} from '../lib/cockpit';
const KINDS:Record<string,string>={spec:'Spec / 需求',design:'设计文档',decision:'决策记录',code:'代码'};
export function SourceEditor({draft,onChange}:{draft:WorkPackage;onChange:(value:WorkPackage)=>void}) {
  const links=draft.links||[];
  return <section><h4>关联文档、决策与代码</h4><p className="muted-copy">填项目内的相对路径。首次保存保留资料快照；以后可核对原计划与当前文件。不会修改资料。</p>
    {links.map((l,i)=><fieldset className="cockpit-node-editor" key={l.id}><legend>资料 {i+1}</legend>
      <label>标题<input className="input-field" required maxLength={120} value={l.title} onChange={e=>onChange({...draft,links:links.map(x=>x.id===l.id?{...x,title:e.target.value}:x)})}/></label>
      <label>类型<select className="input-field" value={l.kind} onChange={e=>onChange({...draft,links:links.map(x=>x.id===l.id?{...x,kind:e.target.value}:x)})}>{Object.entries(KINDS).map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></label>
      <label>文件路径<input className="input-field" required value={l.path} placeholder="docs/spec.md 或 src/App.tsx" onChange={e=>onChange({...draft,links:links.map(x=>x.id===l.id?{...x,path:e.target.value}:x)})}/></label>
      <div className="cockpit-fields"><label>起始行<input type="number" min={1} required className="input-field" value={l.line} onChange={e=>onChange({...draft,links:links.map(x=>x.id===l.id?{...x,line:Number(e.target.value)}:x)})}/></label>
      <label>对应节点<select className="input-field" value={l.nodeId} onChange={e=>onChange({...draft,links:links.map(x=>x.id===l.id?{...x,nodeId:e.target.value}:x)})}><option value="">整个工作包</option>{draft.nodes.map(n=><option key={n.id} value={n.id}>{n.title||'未命名节点'}</option>)}</select></label></div>
      <label>关联原因 / 决策说明<textarea className="input-field" maxLength={1000} rows={2} value={l.reason} onChange={e=>onChange({...draft,links:links.map(x=>x.id===l.id?{...x,reason:e.target.value}:x)})}/></label>
    </fieldset>)}
    <button className="text-button" type="button" disabled={links.length>=12} onClick={()=>onChange({...draft,links:[...links,{id:crypto.randomUUID(),title:'',kind:'spec',path:'',line:1,nodeId:'',reason:''}]})}>＋ 关联资料</button>
  </section>;
}
export function WorkSources({pack}:{pack:WorkPackage}) {
  const [rows,setRows]=useState<LinkedSource[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  if(!pack.links?.length)return <p className="muted-copy">尚未关联 Spec、决策或代码；编辑工作包可登记来源。</p>;
  return <section><button className="text-button" disabled={busy} onClick={async()=>{setBusy(true);try{setRows(await linkedSources(pack.id));setError('');}catch(e){setError(String(e));}finally{setBusy(false);}}}>{busy?'读取资料…':`核对关联资料（${pack.links.length}）`}</button>
    {error&&<p role="alert" className="inline-notice">{error}</p>}
    {rows.map(r=><details key={r.id}><summary>{r.title} · {r.error?'不可访问':r.changed?'文件已变化，需核对':'与登记快照一致'}</summary><p className="cockpit-path">{r.path}:{r.current?.line||1}</p><p>{r.reason}</p>{r.error&&<p className="inline-notice">{r.error}</p>}
      {r.baseline&&<><h5>登记时的资料</h5><small>{new Date(r.baseline.observedAt*1000).toLocaleString()}</small><pre className="source-excerpt">{r.baseline.excerpt}</pre></>}
      {r.current&&<><h5>当前文件</h5><small>{new Date(r.current.observedAt*1000).toLocaleString()} · {r.current.hash.slice(0,10)}</small><pre className="source-excerpt">{r.current.excerpt}</pre></>}
      <p className="muted-copy">文件变化只表示需要核对，不能自动认定实现偏离了计划。</p>
    </details>)}
  </section>;
}
