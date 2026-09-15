//! Project facts and append-only work-package revisions. Never executes project scripts.
use crate::pm;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_package_revisions (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL, project TEXT NOT NULL,
      payload TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS work_package_revision_id ON work_package_revisions(id,seq);",
    )
    .map_err(error)
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkNode {
    id: String,
    title: String,
    status: String,
    next_step: String,
    due_date: String,
    blocker: String,
    depends_on: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackage {
    id: String,
    project: String,
    title: String,
    goal: String,
    revision: i64,
    nodes: Vec<WorkNode>,
    #[serde(default)]
    links: Vec<WorkLink>,
}
fn validate(p: &WorkPackage) -> Result<(), String> {
    if p.id.is_empty()
        || p.id.len() > 100
        || p.title.trim().is_empty()
        || p.title.chars().count() > 120
        || p.goal.chars().count() > 1000
        || p.nodes.is_empty()
        || p.nodes.len() > 60
        || p.links.len() > 12
    {
        return Err("工作包需要标题、目标和 1–60 个节点，内容不能过长".into());
    }
    let ids: HashSet<_> = p.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != p.nodes.len() {
        return Err("节点编号重复".into());
    }
    let link_ids:HashSet<_>=p.links.iter().map(|l|&l.id).collect();
    if link_ids.len()!=p.links.len() || p.links.iter().any(|l|l.id.is_empty()||l.id.len()>100||l.path.len()>1000) {return Err("关联资料编号重复或路径过长".into());}
    for n in &p.nodes {
        if n.id.is_empty()
            || n.id.len() > 100
            || n.title.trim().is_empty()
            || n.title.chars().count() > 120
            || n.next_step.chars().count() > 1000
            || n.blocker.chars().count() > 1000
            || !["todo", "doing", "blocked", "done"].contains(&n.status.as_str())
            || n.depends_on.len() > 60
            || n.depends_on
                .iter()
                .any(|id| id == &n.id || !ids.contains(id.as_str()))
        {
            return Err("节点标题、状态或依赖无效".into());
        }
        if !n.due_date.is_empty() {
            let parts: Vec<_> = n.due_date.split('-').collect();
            let valid = parts.len() == 3
                && parts[0].len() == 4
                && parts[1].len() == 2
                && parts[2].len() == 2
                && parts.iter().all(|s| s.bytes().all(|b| b.is_ascii_digit()));
            if !valid {
                return Err("日期需要 YYYY-MM-DD 格式".into());
            }
            let y = parts[0].parse::<u32>().unwrap_or(0);
            let m = parts[1].parse::<u32>().unwrap_or(0);
            let d = parts[2].parse::<u32>().unwrap_or(0);
            let max = match m {
                2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
                2 => 28,
                4 | 6 | 9 | 11 => 30,
                1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                _ => 0,
            };
            if y == 0 || d == 0 || d > max {
                return Err("节点日期无效".into());
            }
        }
    }
    let mut resolved = HashSet::new();
    for _ in 0..p.nodes.len() {
        for n in &p.nodes {
            if n.depends_on.iter().all(|id| resolved.contains(id)) {
                resolved.insert(n.id.clone());
            }
        }
    }
    if resolved.len() != p.nodes.len() {
        return Err("节点依赖形成了循环".into());
    }
    Ok(())
}
fn save(c: &mut Connection, p: &WorkPackage, allowed: &[String]) -> Result<i64, String> {
    validate(p)?;
    if !allowed.contains(&p.project) {
        return Err("请先在助理设置中连接该项目目录".into());
    }
    schema(c)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(error)?;
    let previous: Option<(i64, String)> = tx
        .query_row(
            "SELECT seq,project FROM work_package_revisions WHERE id=?1 ORDER BY seq DESC LIMIT 1",
            [&p.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(error)?;
    if previous.as_ref().map(|x| x.0).unwrap_or(0) != p.revision {
        return Err("工作包已被其他窗口更新，请重新打开后编辑".into());
    }
    if previous.is_some_and(|x| x.1 != p.project) {
        return Err("已有工作包不能更换项目".into());
    }
    tx.execute(
        "INSERT INTO work_package_revisions(id,project,payload,created) VALUES(?1,?2,?3,?4)",
        params![
            p.id,
            p.project,
            serde_json::to_string(p).map_err(error)?,
            pm::now()
        ],
    )
    .map_err(error)?;
    let seq = tx.last_insert_rowid();
    tx.commit().map_err(error)?;
    Ok(seq)
}
fn packages(c: &Connection, allowed: &[String]) -> Result<Value, String> {
    schema(c)?;
    let mut query=c.prepare("SELECT seq,payload,created FROM work_package_revisions WHERE seq IN (SELECT MAX(seq) FROM work_package_revisions GROUP BY id) ORDER BY seq DESC").map_err(error)?;
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(error)?;
    let mut out = vec![];
    for row in rows {
        let (seq, payload, created) = row.map_err(error)?;
        let mut p: WorkPackage = serde_json::from_str(&payload).map_err(error)?;
        if !allowed.contains(&p.project) {
            continue;
        }
        p.revision = seq;
        let mut value = serde_json::to_value(p).map_err(error)?;
        value["updatedAt"] = json!(created);
        out.push(value);
    }
    Ok(json!(out))
}
#[tauri::command]
pub fn pm_save_work_package(app: tauri::AppHandle, mut package: WorkPackage) -> Result<i64, String> {
    let mut c = pm::open(&app)?;
    let allowed = pm::roots(&c)?;
    if !allowed.contains(&package.project) {return Err("请先连接项目目录".into());}
    schema(&c)?;
    let old:Option<String>=c.query_row("SELECT payload FROM work_package_revisions WHERE id=?1 ORDER BY seq DESC LIMIT 1",[&package.id],|r|r.get(0)).optional().map_err(error)?;
    let previous:Option<WorkPackage>=old.map(|s|serde_json::from_str(&s)).transpose().map_err(error)?;
    for link in &mut package.links {
        if link.title.trim().is_empty() || link.title.chars().count()>120 || link.reason.chars().count()>1000 || !["spec","design","decision","code"].contains(&link.kind.as_str()) || (!link.node_id.is_empty()&&!package.nodes.iter().any(|n|n.id==link.node_id)) {return Err("资料标题、类型或关联节点无效".into());}
        let old=previous.as_ref().and_then(|p|p.links.iter().find(|l|l.id==link.id && l.path==link.path && l.line==link.line));
        if let Some(old)=old {link.baseline=old.baseline.clone();}
        else {link.baseline=Some(read_evidence(Path::new(&package.project),link)?);}
    }
    save(&mut c, &package, &allowed)
}
#[tauri::command]
pub fn pm_work_packages(app: tauri::AppHandle) -> Result<Value, String> {
    let c = pm::open(&app)?;
    packages(&c, &pm::roots(&c)?)
}
#[tauri::command]
pub fn pm_work_timeline(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let c = pm::open(&app)?;
    schema(&c)?;
    let allowed = pm::roots(&c)?;
    let mut s=c.prepare("SELECT seq,project,payload,created FROM work_package_revisions WHERE id=?1 ORDER BY seq DESC LIMIT 40").map_err(error)?;
    let rows = s
        .query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(error)?;
    let mut out = vec![];
    for row in rows {
        let (seq, project, payload, created) = row.map_err(error)?;
        if allowed.contains(&project) {
            out.push(json!({"revision":seq,"created":created,"source":"用户在 AntDesk 保存","package":serde_json::from_str::<Value>(&payload).map_err(error)?}));
        }
    }
    Ok(json!(out))
}

fn executable(name: &str) -> PathBuf {
    #[cfg(unix)]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = Path::new(dir).join(name);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(name)
}
async fn command(root: &Path, name: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(executable(name));
    if name == "git" {
        cmd.args(["-c", "core.fsmonitor=false"]);
    }
    cmd.args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    #[cfg(target_os="macos")]
    cmd.env("PATH",format!("/opt/homebrew/bin:/usr/local/bin:{}",std::env::var("PATH").unwrap_or_default()));
    let mut child = cmd
        .spawn()
        .map_err(|_| format!("未找到或无法启动 {name}"))?;
    let mut stdout = child.stdout.take().ok_or("无法读取命令输出")?.take(262145);
    let run = async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map_err(error)?;
        if bytes.len() > 262144 {
            return Err("状态输出过大，已停止采集".into());
        }
        let status = child.wait().await.map_err(error)?;
        if !status.success() {
            return Err(format!("{name} 查询失败，请检查仓库或本机登录状态"));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(8), run)
        .await
        .map_err(|_| format!("{name} 查询超时"))?
}
fn parse_status(raw: &str) -> Value {
    let mut staged = 0;
    let mut modified = 0;
    let mut untracked = 0;
    let mut conflicts = 0;
    let mut files = vec![];
    let mut branch = String::new();
    let mut parts = raw.split('\0');
    while let Some(line) = parts.next() {
        if line.starts_with("## ") {
            branch = line[3..].to_string();
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let path = &line[3..];
        if code == "??" {
            untracked += 1;
        } else {
            if line.as_bytes()[0] != b' ' {
                staged += 1;
            }
            if line.as_bytes()[1] != b' ' {
                modified += 1;
            }
            if ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].contains(&code) {
                conflicts += 1;
            }
        }
        if files.len() < 12 {
            files.push(json!({"path":path,"status":code}));
        }
        if code.contains('R') || code.contains('C') {
            parts.next();
        }
    }
    json!({"branch":branch,"staged":staged,"modified":modified,"untracked":untracked,"conflicts":conflicts,"dirty":staged+modified+untracked>0,"files":files})
}
fn github_repo(remote: &str) -> Option<String> {
    let s = remote
        .trim()
        .strip_prefix("https://github.com/")
        .or_else(|| remote.trim().strip_prefix("git@github.com:"))?
        .trim_end_matches(".git");
    let parts: Vec<_> = s.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || p.starts_with('.')
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return None;
    }
    Some(s.into())
}
type CiCache = Mutex<HashMap<String, (i64, Value)>>;
async fn ci(root: &Path, repo: &str) -> Value {
    static CACHE: OnceLock<CiCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, v)) = cache.lock().unwrap().get(repo) {
        if pm::now() - at < 60 {
            return v.clone();
        }
    }
    let result = command(
        root,
        "gh",
        &[
            "run",
            "list",
            "--repo",
            repo,
            "--limit",
            "5",
            "--json",
            "databaseId,displayTitle,headSha,headBranch,status,conclusion,updatedAt,url,workflowName",
        ],
    )
    .await;
    let mut value = match result {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(runs) if runs.is_array() => {
                json!({"observedAt":pm::now(),"source":"GitHub Actions","runs":runs})
            }
            _ => json!({"error":"GitHub 返回的构建记录格式无效"}),
        },
        Err(e) => json!({"error":e,"source":"GitHub Actions"}),
    };
    if let Ok(raw)=command(root,"gh",&["release","view","--repo",repo,"--json","tagName,url,assets,publishedAt"]).await {
        if let Ok(release)=serde_json::from_str::<Value>(&raw) {
            value["release"]=json!({"tagName":release["tagName"],"url":release["url"],"publishedAt":release["publishedAt"],"assets":release["assets"].as_array().map(|rows|rows.iter().map(|r|json!({"name":r["name"],"size":r["size"]})).collect::<Vec<_>>()).unwrap_or_default()});
        }
    }
    cache
        .lock()
        .unwrap()
        .insert(repo.into(), (pm::now(), value.clone()));
    value
}
fn local_checks(root: &Path) -> Value {
    use std::io::{Read, Seek, SeekFrom};
    let path = root.join(".antdesk/checks.jsonl");
    let Ok(real) = std::fs::canonicalize(&path) else {
        return json!({"runs":[],"source":"本机检查记录","notice":"尚未接入本机构建与测试记录"});
    };
    if !real.starts_with(root) || real != path {
        return json!({"error":"检查记录不可指向项目外部或符号链接"});
    }
    let read = || -> Result<Vec<Value>, String> {
        let mut f = std::fs::File::open(&real).map_err(error)?;
        let start = f.metadata().map_err(error)?.len().saturating_sub(65536);
        f.seek(SeekFrom::Start(start)).map_err(error)?;
        let mut bytes = vec![];
        f.take(65536).read_to_end(&mut bytes).map_err(error)?;
        let text = String::from_utf8_lossy(&bytes);
        let mut lines = text.lines();
        if start > 0 {
            lines.next();
        }
        let mut seen = HashSet::new();
        Ok(lines.filter_map(|l|serde_json::from_str::<Value>(l).ok()).filter(|v| v["schema"]==1 && ["build","test"].contains(&v["kind"].as_str().unwrap_or("")) && v["project"].as_str()==root.to_str()).collect::<Vec<_>>().into_iter().rev().filter(|v|v["id"].as_str().is_some_and(|id|seen.insert(id.to_string()))).take(6).map(|v|json!({"id":v["id"],"kind":v["kind"],"label":v["label"].as_str().unwrap_or("").chars().take(120).collect::<String>(),"status":v["status"],"exitCode":v["exitCode"],"head":v["head"],"clean":v["clean"],"startedAt":v["startedAt"],"completedAt":v["completedAt"],"source":path})).collect())
    };
    match read() {
        Ok(runs) => json!({"runs":runs,"source":path}),
        Err(e) => json!({"error":e}),
    }
}
async fn project_snapshot(path: String) -> Value {
    let observed = pm::now();
    let root = PathBuf::from(&path);
    let result=async {
        let real=std::fs::canonicalize(&root).map_err(error)?;
        if real!=root{return Err("项目路径已改变，请重新连接目录".into());}
        if !root.join(".git").exists(){return Ok(json!({"path":path,"observedAt":observed,"kind":"reference","notice":"参考文件夹已连接；按问题只读检索，不要求 Git 仓库"}));}
        let top=command(&root,"git",&["rev-parse","--show-toplevel"]).await?;
        if std::fs::canonicalize(top.trim()).map_err(error)?!=root{return Err("连接的目录不是 Git 仓库根目录，未读取上级仓库".into());}
        let before=command(&root,"git",&["rev-parse","--verify","HEAD"]).await.unwrap_or_default().trim().to_string();
        let raw=command(&root,"git",&["status","--porcelain=v1","--branch","-z","--untracked-files=normal","--",".",":(exclude).antdesk"]).await?;
        let mut git=parse_status(&raw);git["head"]=json!(before);
        let after=command(&root,"git",&["rev-parse","--verify","HEAD"]).await.unwrap_or_default();
        git["consistent"]=json!(before==after.trim());
        let remote=command(&root,"git",&["config","--get","remote.origin.url"]).await.unwrap_or_default();
        let ci=if let Some(repo)=github_repo(&remote){ci(&root,&repo).await}else{json!({"runs":[],"notice":"未连接 GitHub origin，暂无 CI 数据"})};
        Ok::<_,String>(json!({"path":path,"observedAt":observed,"git":git,"ci":ci,"localChecks":local_checks(&root)}))
    }.await;
    result.unwrap_or_else(|e| json!({"path":path,"observedAt":observed,"error":e}))
}
#[tauri::command]
pub async fn pm_engineering(app: tauri::AppHandle) -> Result<Value, String> {
    let allowed = {
        let c = pm::open(&app)?;
        pm::roots(&c)?
    };
    let mut jobs = tokio::task::JoinSet::new();
    for path in allowed.iter().take(12) {
        jobs.spawn(project_snapshot(path.clone()));
    }
    let mut projects = vec![];
    while let Some(r) = jobs.join_next().await {
        projects.push(r.map_err(error)?);
    }
    let still_allowed = {
        let c = pm::open(&app)?;
        pm::roots(&c)?
    };
    projects.retain(|v| {
        v["path"]
            .as_str()
            .is_some_and(|p| still_allowed.iter().any(|root| root == p))
    });
    projects.sort_by_key(|v| v["path"].as_str().unwrap_or("").to_string());
    Ok(json!({"observedAt":pm::now(),"projects":projects,"truncated":allowed.len()>12}))
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct WorkLink {
    id:String, title:String, kind:String, path:String,
    #[serde(default="first_line")] line:usize,
    #[serde(default)] node_id:String,
    #[serde(default)] reason:String,
    #[serde(default)] baseline:Option<Value>,
}
fn first_line()->usize {1}
fn read_evidence(root:&Path,link:&WorkLink)->Result<Value,String> {
    use sha2::{Digest,Sha256};
    use std::io::Read;
    let relative=Path::new(&link.path);
    if relative.as_os_str().is_empty() || relative.components().any(|c|!matches!(c,std::path::Component::Normal(_))) || pm::excluded(relative) || link.line==0 {return Err("请选择项目内的普通文本文件，不能包含隐藏配置或上级路径".into());}
    let joined=root.join(relative);let real=std::fs::canonicalize(&joined).map_err(|_|"关联文件不存在或不可访问")?;
    if !real.starts_with(root) || real!=joined {return Err("资料路径不能经过符号链接或离开已连接目录".into());}
    let file=std::fs::File::open(&real).map_err(error)?;
    let mut bytes=Vec::new();file.take(131073).read_to_end(&mut bytes).map_err(error)?;
    if bytes.len()>131072 || bytes.contains(&0) {return Err("仅支持不超过 128 KB 的文本资料".into());}
    let hash=format!("{:x}",Sha256::digest(&bytes));
    let text=String::from_utf8(bytes).map_err(|_|"资料不是 UTF-8 文本")?;
    let count=text.lines().count();if link.line>count.max(1) {return Err("资料行号超出文件范围".into());}
    let excerpt=text.lines().skip(link.line-1).take(24).collect::<Vec<_>>().join("\n").chars().take(2400).collect::<String>();
    Ok(json!({"hash":hash,"excerpt":excerpt,"line":link.line,"observedAt":pm::now(),"source":real}))
}
#[tauri::command]
pub fn pm_linked_sources(app:tauri::AppHandle,id:String)->Result<Value,String> {
    let c=pm::open(&app)?;schema(&c)?;
    let raw:String=c.query_row("SELECT payload FROM work_package_revisions WHERE id=?1 ORDER BY seq DESC LIMIT 1",[id],|r|r.get(0)).map_err(error)?;
    let p:WorkPackage=serde_json::from_str(&raw).map_err(error)?;
    if !pm::roots(&c)?.contains(&p.project) {return Err("项目已断开，停止读取资料".into());}
    Ok(json!(p.links.iter().map(|l|match read_evidence(Path::new(&p.project),l) {
        Ok(current)=>json!({"id":l.id,"title":l.title,"kind":l.kind,"path":l.path,"nodeId":l.node_id,"reason":l.reason,"changed":l.baseline.as_ref().map(|b|b["hash"]!=current["hash"]),"baseline":l.baseline,"current":current}),
        Err(e)=>json!({"id":l.id,"title":l.title,"path":l.path,"error":e,"baseline":l.baseline}),
    }).collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn package() -> WorkPackage {
        WorkPackage {
            id: "p".into(),
            project: "/project".into(),
            title: "软著申请".into(),
            goal: "材料齐全后提交".into(),
            revision: 0,
            links: vec![],
            nodes: vec![WorkNode {
                id: "n1".into(),
                title: "准备材料".into(),
                status: "todo".into(),
                next_step: "整理源代码".into(),
                due_date: "2026-09-30".into(),
                blocker: "".into(),
                depends_on: vec![],
            }],
        }
    }
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "antdesk-cockpit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(p).unwrap()
    }
    #[test]
    fn linked_evidence_keeps_baseline_and_detects_file_changes() {
        let dir=temp();let path=dir.join("spec.md");
        std::fs::write(&path,"original plan\nsecond line").unwrap();
        let link=WorkLink{id:"l".into(),title:"Spec".into(),kind:"spec".into(),path:"spec.md".into(),line:1,node_id:"".into(),reason:"acceptance".into(),baseline:None};
        let baseline=read_evidence(&dir,&link).unwrap();
        std::fs::write(&path,"updated plan").unwrap();
        let current=read_evidence(&dir,&link).unwrap();
        assert_ne!(baseline["hash"],current["hash"]);
        assert_eq!(baseline["excerpt"],"original plan\nsecond line");
        let mut invalid=link.clone();invalid.path="../outside.md".into();assert!(read_evidence(&dir,&invalid).is_err());
        invalid.path=".env".into();assert!(read_evidence(&dir,&invalid).is_err());
        invalid.path="spec.md".into();invalid.line=99;assert!(read_evidence(&dir,&invalid).is_err());
    }
    #[test]
    fn older_packages_still_load_without_link_fields() {
        let mut value=serde_json::to_value(package()).unwrap();value.as_object_mut().unwrap().remove("links");
        let older:WorkPackage=serde_json::from_value(value).unwrap();assert!(older.links.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn linked_evidence_rejects_symlinks_and_binary_files() {
        let dir=temp();std::fs::write(dir.join("real.md"),"public text").unwrap();
        std::os::unix::fs::symlink(dir.join("real.md"),dir.join("link.md")).unwrap();
        let mut link=WorkLink{id:"l".into(),title:"Spec".into(),kind:"spec".into(),path:"link.md".into(),line:1,node_id:"".into(),reason:"".into(),baseline:None};
        assert!(read_evidence(&dir,&link).is_err());
        std::fs::write(dir.join("binary.bin"),[1,0,2]).unwrap();link.path="binary.bin".into();assert!(read_evidence(&dir,&link).is_err());
    }
    #[test]
    fn revisions_survive_restart_and_do_not_modify_memories() {
        let dir = temp();
        let path = dir.join("pm.sqlite3");
        let allowed = vec!["/project".into()];
        let mut c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE memories(text TEXT);INSERT INTO memories VALUES('keep me');")
            .unwrap();
        let mut p = package();
        p.revision = save(&mut c, &p, &allowed).unwrap();
        p.nodes[0].status = "done".into();
        save(&mut c, &p, &allowed).unwrap();
        drop(c);
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            packages(&c, &allowed).unwrap()[0]["nodes"][0]["status"],
            "done"
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM work_package_revisions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(c
            .query_row(
                "SELECT payload FROM work_package_revisions ORDER BY seq LIMIT 1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap()
            .contains("todo"));
        assert_eq!(
            c.query_row("SELECT text FROM memories", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep me"
        );
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(packages(&c, &[]).unwrap().as_array().unwrap().is_empty());
        drop(c);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_conflicting_edits_and_unconnected_projects() {
        let mut c = Connection::open_in_memory().unwrap();
        let allowed = vec!["/project".into()];
        let p = package();
        assert!(save(&mut c, &p, &[]).is_err());
        save(&mut c, &p, &allowed).unwrap();
        assert!(save(&mut c, &p, &allowed).unwrap_err().contains("其他窗口"));
        assert_eq!(packages(&c, &allowed).unwrap().as_array().unwrap().len(), 1);
    }
    #[test]
    fn dependencies_and_calendar_dates_are_validated() {
        let mut p = package();
        p.nodes[0].due_date = "2026-02-29".into();
        assert!(validate(&p).is_err());
        p.nodes[0].due_date = "2028-02-29".into();
        assert!(validate(&p).is_ok());
        let mut n = p.nodes[0].clone();
        n.id = "n2".into();
        n.depends_on = vec!["n1".into()];
        p.nodes.push(n);
        assert!(validate(&p).is_ok());
        p.nodes[0].depends_on = vec!["n2".into()];
        assert!(validate(&p).unwrap_err().contains("循环"));
        p.nodes[0].depends_on = vec!["missing".into()];
        assert!(validate(&p).is_err());
    }
    #[test]
    fn git_status_handles_renames_conflicts_and_unicode_paths() {
        let v=parse_status("## main...origin/main [ahead 1]\0R  新名字.md\0旧名字.md\0 M changed.ts\0?? new.md\0UU conflict.md\0");
        assert_eq!(v["files"].as_array().unwrap().len(), 4);
        assert_eq!(v["staged"], 2);
        assert_eq!(v["modified"], 2);
        assert_eq!(v["untracked"], 1);
        assert_eq!(v["conflicts"], 1);
    }
    #[test]
    fn github_remote_never_passes_embedded_credentials_or_options() {
        assert_eq!(
            github_repo("git@github.com:Evilom/antdesk.git"),
            Some("Evilom/antdesk".into())
        );
        assert!(github_repo("https://token@github.com/Evilom/antdesk.git").is_none());
        assert!(github_repo("https://example.com/Evilom/antdesk").is_none());
        assert!(github_repo("https://github.com/a/b/../../evil").is_none());
    }
    #[tokio::test]
    async fn live_git_snapshot_observes_changes_without_modifying_repository() {
        let root = temp();
        command(&root, "git", &["init", "-q"]).await.unwrap();
        std::fs::write(root.join("真实变更.md"), "hello").unwrap();
        let before = command(&root, "git", &["status", "--porcelain"])
            .await
            .unwrap();
        let v = project_snapshot(root.to_string_lossy().into_owned()).await;
        assert_eq!(v["git"]["untracked"], 1);
        assert_eq!(v["git"]["dirty"], true);
        assert_eq!(
            before,
            command(&root, "git", &["status", "--porcelain"])
                .await
                .unwrap()
        );
        let child = root.join("child");
        std::fs::create_dir(&child).unwrap();
        assert_eq!(project_snapshot(child.to_string_lossy().into_owned()).await["kind"],"reference");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn check_records_use_latest_event_and_reject_symlinks() {
        let root = temp();
        std::fs::create_dir(root.join(".antdesk")).unwrap();
        let first = json!({"schema":1,"id":"run","project":root,"kind":"test","status":"running"});
        let mut last = first.clone();
        last["status"] = json!("failed");
        last["exitCode"] = json!(1);
        std::fs::write(
            root.join(".antdesk/checks.jsonl"),
            format!("{first}\n{last}\n"),
        )
        .unwrap();
        let v = local_checks(&root);
        assert_eq!(v["runs"].as_array().unwrap().len(), 1);
        assert_eq!(v["runs"][0]["status"], "failed");
        #[cfg(unix)]
        {
            let other = temp();
            std::os::unix::fs::symlink(root.join(".antdesk"), other.join(".antdesk")).unwrap();
            assert!(local_checks(&other)["error"].is_string());
            std::fs::remove_dir_all(other).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
