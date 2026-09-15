import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function versions(root) {
  const cargo=fs.readFileSync(path.join(root,'src-tauri/Cargo.toml'),'utf8');
  const lock=fs.readFileSync(path.join(root,'src-tauri/Cargo.lock'),'utf8');
  return {
    app:JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8')).version,
    frontend:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,
    rust:cargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1],
    lock:lock.match(/\[\[package\]\]\nname = "antdesk"\nversion = "([^"]+)"/)?.[1],
  };
}
export function validateVersions(values,tag) {
  if(!/^\d+\.\d+\.\d+$/.test(values.app)||Object.values(values).some(v=>v!==values.app))throw new Error(`版本不一致：${JSON.stringify(values)}`);
  if(tag&&tag!==`v${values.app}`)throw new Error(`标签 ${tag} 与应用版本 v${values.app} 不一致`);
  return values.app;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const values=versions(process.cwd());
  const tag=process.env.GITHUB_REF_TYPE==='tag'?process.env.GITHUB_REF_NAME:undefined;
  const version=validateVersions(values,tag);
  if(process.argv.includes('--release')) {
    const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const tagged=execFileSync('git',['rev-parse',`v${version}^{}`],{encoding:'utf8'}).trim();
    if(head!==tagged)throw new Error(`v${version} 未指向当前构建提交`);
  }
  console.log(`版本校验通过：v${version}`);
}
