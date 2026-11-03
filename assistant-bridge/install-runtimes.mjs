#!/usr/bin/env node
/** Reproducible project-local install. Never starts an account login or changes PATH. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(project,'.antdesk/runtime-tools');
const MUSE={version:'1.4.14-R7309.1',url:'https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.14-R7309.1&file=muse-x86-windows.exe',sha256:'20d18c426cc26e9e4b3cc07008ec07ec97e12e466a2be8cd2797b2e0e2018382',size:435429624,mspSchemaFingerprint:'sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6'};
const DEEPSEEK='0.2.1rc2';
const dependencies=['deepseek-harness-sdk=='+DEEPSEEK,'deepseek-harness-runtime-bin=='+DEEPSEEK,'pydantic==2.14.2','pydantic-core==2.50.2','annotated-types==0.8.0','typing-extensions==4.16.0','typing-inspection==0.4.4'];
const MUSE_PERSONAL='0.3.10';
const musePersonalDependencies=['muse-cli=='+MUSE_PERSONAL,'curl-cffi==0.17.0','noiseprotocol==0.3.1','protobuf==7.36.2','cffi==2.1.1','certifi==2026.10.23','cryptography==50.0.2','pycparser==3.12'];
const PLAYWRIGHT_CORE='1.64.1';
const NOTION_WEB={repository:'https://github.com/maverickxone/notion2api.git',commit:'cc7fcf4dc78af245f4ce961c5951384c7b78b005'};
const notionWebDependencies=['requests==2.32.5','cloudscraper==1.2.71','curl_cffi==0.17.0','certifi==2026.10.23','cffi==2.1.1','charset-normalizer==3.5.2','idna==3.20','pycparser==3.12','pyparsing==3.3.3','requests-toolbelt==1.0.0','urllib3==2.8.0'];
const CODEX={version:'0.166.0-alpha.5.1',sha256:'3097c909fb6d5cd63510d44aceb1d42df9f6e85722a3e447e477def1ecf60e16',size:368970544};
const DOTS_TUNNEL={version:'0.0.19',url:'https://github.com/openai/tunnel-client/releases/download/v0.0.19/tunnel-client-v0.0.19-windows-amd64.zip',archiveSha256:'1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25',sha256:'7e93a39a567c87154a0aef2091b81100d78f9093c4603412cc2b55bed3dfe5ea'};
const args=new Set(process.argv.slice(2));
const selectors=['--muse','--deepseek','--muse-personal','--codex','--dots-tunnel','--notion'];
for(const arg of args)if(!['--check',...selectors].includes(arg))throw new Error('Unknown option: '+arg);
const selected=name=>selectors.some(flag=>args.has(flag))?args.has('--'+name):['muse-personal','codex','dots-tunnel','notion'].includes(name);

async function sha256(file){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function command(exe,args,{capture=false,...options}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd:project,windowsHide:true,stdio:capture?['ignore','pipe','pipe']:'inherit',...options});
    let text='',error='';if(capture){child.stdout.on('data',chunk=>{text+=chunk;if(text.length>1024*1024)child.kill();});child.stderr.on('data',chunk=>{error+=chunk;if(error.length>1024*1024)child.kill();});}
    const timer=setTimeout(()=>{child.kill();reject(new Error('Runtime installation timed out.'));},300000);
    child.once('error',err=>{clearTimeout(timer);reject(err);});
    child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve(text);else reject(new Error('Runtime command failed ('+code+'). '+error.slice(0,1000)));});
  });
}
async function muse(){
  const dir=path.join(root,'muse'),target=path.join(dir,'muse.exe');fs.mkdirSync(dir,{recursive:true});
  if(fs.existsSync(target)){
    if(fs.statSync(target).size!==MUSE.size||await sha256(target)!==MUSE.sha256)throw new Error('Existing Muse binary differs from the pinned release; preserve it and choose an explicit upgrade.');
    console.log('Muse '+MUSE.version+' verified.');return;
  }
  if(args.has('--check'))throw new Error('Muse is not installed. Run npm run bridge:install -- --muse.');
  console.log('Downloading official Muse '+MUSE.version+'…');
  const response=await fetch(MUSE.url,{signal:AbortSignal.timeout(480000)});
  if(!response.ok)throw new Error('Official Muse download returned HTTP '+response.status+'. No account login was attempted.');
  const temp=target+'.download-'+process.pid,hash=createHash('sha256');let bytes=0;
  try{
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,next){hash.update(chunk);bytes+=chunk.length;next(null,chunk);}}),fs.createWriteStream(temp,{flags:'wx'}));
    if(bytes!==MUSE.size||hash.digest('hex')!==MUSE.sha256)throw new Error('Official Muse checksum or size did not match.');
    fs.renameSync(temp,target);fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({...MUSE,installedAt:new Date().toISOString()},null,2));
    console.log('Muse '+MUSE.version+' installed and verified.');
  }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
async function deepseek(){
  const dir=path.join(root,'deepseek'),venv=path.join(dir,'venv'),python=path.join(venv,'Scripts/python.exe');fs.mkdirSync(dir,{recursive:true});
  const check='import importlib.metadata as m; assert m.version("deepseek-harness-sdk")=="'+DEEPSEEK+'"; assert m.version("deepseek-harness-runtime-bin")=="'+DEEPSEEK+'"; from deepseek_harness import DeepSeekHarness; print("DeepSeek Harness '+DEEPSEEK+' verified.")';
  if(args.has('--check')){if(!fs.existsSync(python))throw new Error('DeepSeek Harness is not installed.');console.log((await command(python,['-c',check],{capture:true})).trim());return;}
  if(!fs.existsSync(python))await command('py',['-3','-m','venv',venv]);
  await command(python,['-m','pip','install','--disable-pip-version-check','--no-input','--index-url','https://pypi.org/simple','--cache-dir',path.join(dir,'wheel-cache'),'--only-binary=:all:','--report',path.join(dir,'install-report.json'),...dependencies],{env:{...process.env,PYTHONNOUSERSITE:'1',PIP_REQUIRE_VIRTUALENV:'1',PIP_EXTRA_INDEX_URL:''}});
  console.log((await command(python,['-c',check],{capture:true})).trim());
}

async function musePersonal(){
  const dir=path.join(root,'muse-personal'),venv=path.join(dir,'venv'),python=path.join(venv,'Scripts/python.exe');fs.mkdirSync(dir,{recursive:true});
  const expected=Object.fromEntries(musePersonalDependencies.map(requirement=>requirement.split('==')));
  const check=[
    'import importlib.metadata as m',
    'expected='+JSON.stringify(expected),
    'for package, version in expected.items():\n    assert m.version(package)==version, package+" version differs from the pinned release"',
    'from muse_cli.gateway import Gateway',
    'import curl_cffi, cffi, certifi, cryptography, pycparser',
    'from noise.connection import NoiseConnection',
    'import google.protobuf',
    'print("Original Muse community gateway '+MUSE_PERSONAL+' and pinned dependencies verified.")',
  ].join('\n');
  if(args.has('--check')){
    if(!fs.existsSync(python))throw new Error('Original Muse is not installed. Run npm run bridge:install -- --muse-personal.');
    console.log((await command(python,['-I','-X','utf8','-c',check],{capture:true})).trim());return;
  }
  if(!fs.existsSync(python))await command('py',['-3','-m','venv',venv]);
  await command(python,['-I','-X','utf8','-m','pip','install','--disable-pip-version-check','--no-input','--index-url','https://pypi.org/simple','--cache-dir',path.join(dir,'wheel-cache'),'--only-binary=:all:','--report',path.join(dir,'install-report.json'),...musePersonalDependencies],{env:{...process.env,PIP_REQUIRE_VIRTUALENV:'1',PIP_EXTRA_INDEX_URL:'',PIP_CONFIG_FILE:'NUL'}});
  console.log((await command(python,['-I','-X','utf8','-c',check],{capture:true})).trim());
  fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({package:'muse-cli',version:MUSE_PERSONAL,official:false,dependencies:expected,installedAt:new Date().toISOString()},null,2));
}

async function notionWeb(){
  const dir=path.join(root,'notion2api'),source=path.join(dir,'source'),venv=path.join(dir,'venv'),python=path.join(venv,'Scripts/python.exe');
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(source)){
    if(args.has('--check'))throw new Error('Notion webpage runtime is not installed. Run npm run bridge:install -- --notion.');
    await command('git',['clone','--no-checkout','--',NOTION_WEB.repository,source]);
    await command('git',['-C',source,'checkout','--detach',NOTION_WEB.commit]);
  }
  const head=(await command('git',['-C',source,'rev-parse','HEAD'],{capture:true})).trim();
  const changes=(await command('git',['-C',source,'status','--porcelain','--untracked-files=normal'],{capture:true})).trim();
  if(head!==NOTION_WEB.commit||changes)throw new Error('Existing notion2api source differs from the pinned revision; it has been preserved.');
  const expected=Object.fromEntries(notionWebDependencies.map(requirement=>requirement.split('==')));
  const check=[
    'import importlib.metadata as m, sys',
    'expected='+JSON.stringify(expected),
    'for package, version in expected.items():\n    assert m.version(package)==version, package+" version differs from the pinned release"',
    'sys.path.insert(0, sys.argv[1])',
    'from app.notion_client import NotionOpusAPI',
    'assert callable(NotionOpusAPI)',
    'print("Pinned notion2api account transport and dependencies verified; no login or AI request was sent.")',
  ].join('\n');
  if(args.has('--check')){
    if(!fs.existsSync(python))throw new Error('Notion webpage Python runtime is missing. Run npm run bridge:install -- --notion.');
    console.log((await command(python,['-I','-X','utf8','-c',check,source],{capture:true})).trim());return;
  }
  if(!fs.existsSync(python))await command('py',['-3','-m','venv',venv]);
  await command(python,['-I','-X','utf8','-m','pip','install','--disable-pip-version-check','--no-input','--index-url','https://pypi.org/simple','--cache-dir',path.join(dir,'wheel-cache'),'--only-binary=:all:','--report',path.join(dir,'install-report.json'),...notionWebDependencies],{env:{...process.env,PIP_REQUIRE_VIRTUALENV:'1',PIP_EXTRA_INDEX_URL:'',PIP_CONFIG_FILE:'NUL'}});
  console.log((await command(python,['-I','-X','utf8','-c',check,source],{capture:true})).trim());
  fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({...NOTION_WEB,official:false,mode:'single-user-web-membership',dependencies:expected,installedAt:new Date().toISOString()},null,2));
}

function existingBrowser(){
  const locations=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean);
  for(const relative of ['Microsoft/Edge/Application/msedge.exe','Google/Chrome/Application/chrome.exe']){
    for(const base of locations){
      const executable=path.join(base,relative);
      if(fs.existsSync(executable)&&fs.statSync(executable).isFile())return {name:relative.startsWith('Microsoft/')?'Microsoft Edge':'Google Chrome',executable};
    }
  }
  return null;
}

function verifyBrowserControl(dir){
  const metadata=path.join(dir,'node_modules/playwright-core/package.json');
  if(!fs.existsSync(metadata))throw new Error('Browser control is not installed. Run npm run bridge:install -- --muse-personal.');
  const manifest=JSON.parse(fs.readFileSync(metadata,'utf8'));
  if(manifest.version!==PLAYWRIGHT_CORE)throw new Error('Installed playwright-core differs from the pinned version '+PLAYWRIGHT_CORE+'.');
  const browserRequire=createRequire(path.join(dir,'package.json'));
  const playwright=browserRequire('playwright-core');
  if(typeof playwright.chromium?.launchPersistentContext!=='function')throw new Error('Installed browser control cannot load its Chromium API.');
  const browser=existingBrowser();
  if(!browser)throw new Error('Microsoft Edge or Google Chrome was not found. No browser has been downloaded or installed.');
  console.log('playwright-core '+PLAYWRIGHT_CORE+' verified; existing '+browser.name+' is available.');
  return browser;
}

async function browserControl(){
  const dir=path.join(root,'browser');fs.mkdirSync(dir,{recursive:true});
  if(args.has('--check')){verifyBrowserControl(dir);return;}
  // Invoke npm through Node directly: no .cmd shell expansion and no lifecycle scripts.
  const npmCli=[process.env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')]
    .find(file=>typeof file==='string'&&/\.js$/i.test(file)&&fs.existsSync(file));
  if(!npmCli)throw new Error('Cannot locate the npm CLI. Run this installer through npm run bridge:install.');
  await command(process.execPath,[npmCli,'install','--prefix',dir,'--registry','https://registry.npmjs.org','--ignore-scripts','--no-audit','--no-fund','--save-exact','--workspaces=false','playwright-core@'+PLAYWRIGHT_CORE],
    {env:{...process.env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',npm_config_ignore_scripts:'true'}});
  const browser=verifyBrowserControl(dir);
  fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({package:'playwright-core',version:PLAYWRIGHT_CORE,browser:browser.name,browserDownloaded:false,installedAt:new Date().toISOString()},null,2));
}

async function codex(){
  const dir=path.join(root,'codex'),target=path.join(dir,'codex.exe');
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(target)){
    if(args.has('--check'))throw new Error('The official Codex login component is not installed.');
    const source=process.env.ANTDESK_CODEX_BINARY;
    if(!source||!path.isAbsolute(source)||!fs.existsSync(source))throw new Error('Set ANTDESK_CODEX_BINARY to the installed official Codex executable, then run --codex. No account profile is imported.');
    if(fs.statSync(source).size!==CODEX.size||await sha256(source)!==CODEX.sha256)throw new Error('The supplied Codex executable does not match the verified login release.');
    fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  }
  if(fs.statSync(target).size!==CODEX.size||await sha256(target)!==CODEX.sha256)throw new Error('The existing Codex executable differs from the verified login release; it has been preserved.');
  const version=(await command(target,['--version'],{capture:true})).trim();
  if(version!=='codex-cli '+CODEX.version)throw new Error('Codex login component version does not match.');
  if(!args.has('--check'))fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({...CODEX,source:'installed-official-Codex',installedAt:new Date().toISOString()},null,2));
  console.log('Official Codex '+CODEX.version+' login component verified.');
}

async function dotsTunnel(){
  const dir=path.join(root,'dots-tunnel'),target=path.join(dir,'tunnel-client.exe');fs.mkdirSync(dir,{recursive:true});
  if(fs.existsSync(target)){
    if(await sha256(target)!==DOTS_TUNNEL.sha256)throw new Error('Existing Tunnel binary differs from the pinned official release; it has been preserved.');
    console.log('Official OpenAI Tunnel '+DOTS_TUNNEL.version+' verified.');return;
  }
  if(args.has('--check'))throw new Error('The official Tunnel client is not installed. Run npm run bridge:install -- --dots-tunnel.');
  const temp=path.join(dir,'install-'+process.pid),archive=path.join(temp,'release.zip'),unpacked=path.join(temp,'unpacked');
  fs.mkdirSync(temp,{recursive:false});
  try{
    const response=await fetch(DOTS_TUNNEL.url,{signal:AbortSignal.timeout(240000)});
    if(!response.ok)throw new Error('Official Tunnel download returned HTTP '+response.status+'.');
    const digest=createHash('sha256');let bytes=0;
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,next){bytes+=chunk.length;if(bytes>256*1024*1024){next(new Error('Tunnel archive exceeds its download limit.'));return;}digest.update(chunk);next(null,chunk);}}),fs.createWriteStream(archive,{flags:'wx'}));
    if(digest.digest('hex')!==DOTS_TUNNEL.archiveSha256)throw new Error('Official Tunnel archive checksum did not match.');
    await command('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:ANTDESK_TUNNEL_ARCHIVE -DestinationPath $env:ANTDESK_TUNNEL_EXTRACT -ErrorAction Stop'],
      {env:{...process.env,ANTDESK_TUNNEL_ARCHIVE:archive,ANTDESK_TUNNEL_EXTRACT:unpacked},capture:true});
    const candidates=[];
    const collect=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())collect(file);else if(entry.isFile()&&entry.name==='tunnel-client.exe')candidates.push(file);}};
    collect(unpacked);
    if(candidates.length!==1||await sha256(candidates[0])!==DOTS_TUNNEL.sha256)throw new Error('Official Tunnel executable checksum did not match.');
    fs.copyFileSync(candidates[0],target,fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({...DOTS_TUNNEL,official:true,installedAt:new Date().toISOString()},null,2));
    console.log('Official OpenAI Tunnel '+DOTS_TUNNEL.version+' installed and verified.');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This pinned installer targets the current AntDesk Windows x64 deployment.');
try {if(selected('muse'))await muse();if(selected('deepseek'))await deepseek();if(selected('muse-personal'))await musePersonal();if(selected('codex'))await codex();if(selected('dots-tunnel'))await dotsTunnel();if(selected('notion'))await notionWeb();if(selected('muse-personal')||selected('notion'))await browserControl();}
catch(error){console.error('AntDesk runtime: '+error.message);process.exitCode=1;}
