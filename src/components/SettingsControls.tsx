import type {ReactNode} from 'react';

export function SettingsGroup({title, description, children}: {title:string; description?:string; children:ReactNode}) {
  return <section className="settings-group"><header><h3>{title}</h3>{description && <p>{description}</p>}</header><div className="settings-group-body">{children}</div></section>;
}
export function SettingToggle({title, description, checked, onChange}: {title:string; description?:string; checked:boolean; onChange:(checked:boolean)=>void}) {
  return <label className="setting-row"><span><strong>{title}</strong>{description && <small>{description}</small>}</span><input type="checkbox" role="switch" aria-label={title} checked={checked} onChange={e=>onChange(e.target.checked)}/></label>;
}
