//! Local PM context. Own append-only journal; Codex is opened read-only.
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn err(e: impl std::fmt::Display) -> String {
    format!("PM 本地存储：{e}")
}
fn database(path: &Path) -> Result<Connection, String> {
    let c = Connection::open(path).map_err(err)?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(conversation,message_id,text));
      CREATE INDEX IF NOT EXISTS journal_message ON journal(conversation,message_id,seq);
      CREATE TABLE IF NOT EXISTS memories (seq INTEGER PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(text,source));
      CREATE TABLE IF NOT EXISTS directories (path TEXT PRIMARY KEY);").map_err(err)?;
    Ok(c)
}
fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("assistant");
    fs::create_dir_all(&dir).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    database(&dir.join("pm.sqlite3"))
}
#[derive(Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
}
fn append(c: &Connection, conversation: &str, messages: &[Message]) -> Result<(), String> {
    if conversation.is_empty() || conversation.len() > 100 || messages.len() > 200 {
        return Err("对话记录格式无效".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    for m in messages {
        if !["user", "assistant"].contains(&m.role.as_str())
            || m.id.len() > 200
            || m.text.len() > 64000
        {
            return Err("对话记录过大或角色无效".into());
        }
        if !m.text.trim().is_empty() {
            tx.execute("INSERT OR IGNORE INTO journal(conversation,message_id,role,text,created) VALUES(?1,?2,?3,?4,?5)", params![conversation,m.id,m.role,m.text,now()]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}
#[tauri::command]
pub fn pm_save_messages(
    app: tauri::AppHandle,
    conversation: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    append(&open(&app)?, &conversation, &messages)
}
#[tauri::command]
pub fn pm_history(app: tauri::AppHandle) -> Result<Value, String> {
    let c = open(&app)?;
    let conversation: String = c
        .query_row(
            "SELECT conversation FROM journal ORDER BY seq DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .unwrap_or_default();
    let mut s = c.prepare("SELECT message_id,role,text FROM journal WHERE seq IN (SELECT MAX(seq) FROM journal WHERE conversation=?1 GROUP BY message_id) ORDER BY seq DESC LIMIT 100").map_err(err)?;
    let mut messages = s.query_map([&conversation], |r| Ok(json!({"id":r.get::<_,String>(0)?,"role":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?}))).map_err(err)?.collect::<Result<Vec<_>,_>>().map_err(err)?;
    messages.reverse();
    Ok(json!({"conversation":conversation,"messages":messages}))
}
#[tauri::command]
pub fn pm_remember(app: tauri::AppHandle, text: String, source: String) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > 2000 || source.len() > 300 {
        return Err("记忆需要 1–2000 字".into());
    }
    open(&app)?
        .execute(
            "INSERT OR IGNORE INTO memories(text,source,created) VALUES(?1,?2,?3)",
            params![text.trim(), source, now()],
        )
        .map_err(err)?;
    Ok(())
}
fn roots(c: &Connection) -> Result<Vec<String>, String> {
    c.prepare("SELECT path FROM directories ORDER BY path")
        .map_err(err)?
        .query_map([], |r| r.get(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)
}
#[tauri::command]
pub fn pm_directories(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    roots(&open(&app)?)
}
fn excluded(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy().to_lowercase();
        s.starts_with('.')
            || [
                "node_modules",
                "target",
                "dist",
                "build",
                "library",
                "keychains",
                "accounts.json",
                "credentials.json",
                "secrets.json",
            ]
            .contains(&s.as_str())
            || s.ends_with(".pem")
            || s.ends_with(".key")
            || s.ends_with(".p12")
    })
}
#[tauri::command]
pub fn pm_add_directory(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let p = fs::canonicalize(path.trim()).map_err(|_| "目录不存在或无法读取")?;
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if !p.is_dir() || p.parent().is_none() || p == Path::new(&home) || excluded(&p) {
        return Err("请选择具体的项目或文档目录，不能开放整个磁盘、主目录或隐藏配置目录".into());
    }
    open(&app)?
        .execute(
            "INSERT OR IGNORE INTO directories(path) VALUES(?1)",
            [p.to_string_lossy()],
        )
        .map_err(err)?;
    pm_directories(app)
}
#[tauri::command]
pub fn pm_remove_directory(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    open(&app)?
        .execute("DELETE FROM directories WHERE path=?1", [path])
        .map_err(err)?;
    pm_directories(app)
}
fn terms(query: &str) -> HashSet<String> {
    let q = query.to_lowercase();
    let mut out: HashSet<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|v| v.chars().count() > 1)
        .map(String::from)
        .collect();
    let chars: Vec<char> = q.chars().collect();
    for p in chars.windows(2) {
        if p.iter().all(|c| !c.is_ascii() && c.is_alphanumeric()) {
            out.insert(p.iter().collect());
        }
    }
    out
}
fn score(text: &str, terms: &HashSet<String>) -> usize {
    let s = text.to_lowercase();
    terms.iter().filter(|t| s.contains(t.as_str())).count()
}
fn recall(c: &Connection, query: &str) -> Result<Value, String> {
    let terms = terms(query);
    let mut s=c.prepare("SELECT text,source,created FROM memories WHERE seq IN (SELECT MAX(seq) FROM memories GROUP BY source) ORDER BY seq DESC").map_err(err)?;
    let mut memories=s.query_map([],|r|Ok(json!({"text":r.get::<_,String>(0)?,"source":r.get::<_,String>(1)?,"created":r.get::<_,i64>(2)?}))).map_err(err)?.collect::<Result<Vec<_>,_>>().map_err(err)?;
    memories.sort_by_key(|m| std::cmp::Reverse(score(m["text"].as_str().unwrap_or(""), &terms)));
    memories.truncate(12);
    let keywords = terms.iter().take(32).cloned().collect::<Vec<_>>();
    let predicate = if keywords.is_empty() {
        "1=1".into()
    } else {
        keywords
            .iter()
            .enumerate()
            .map(|(i, _)| format!("instr(lower(j.text),?{})>0", i + 1))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let sql=format!("SELECT conversation,role,text,created FROM journal j WHERE ({predicate}) AND NOT EXISTS(SELECT 1 FROM journal n WHERE n.conversation=j.conversation AND n.message_id=j.message_id AND n.seq>j.seq) ORDER BY seq DESC LIMIT 200");
    let mut s = c.prepare(&sql).map_err(err)?;
    let rows=s.query_map(rusqlite::params_from_iter(keywords),|r|Ok(json!({"conversation":r.get::<_,String>(0)?,"role":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?}))).map_err(err)?;
    let mut history = Vec::new();
    for row in rows {
        let row = row.map_err(err)?;
        let rank = score(row["text"].as_str().unwrap_or(""), &terms);
        if history.len() < 8 || rank > 0 {
            history.push((rank, row));
        }
    }
    history.sort_by_key(|(rank, _)| std::cmp::Reverse(*rank));
    history.truncate(8);
    Ok(json!({"memories":memories,"history":history.into_iter().map(|(_,v)|v).collect::<Vec<_>>()}))
}
fn files(root: &Path, dir: &Path, depth: usize, budget: &mut usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || *budget == 0 {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            let p = entry.path();
            if excluded(&p) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                files(root, &p, depth + 1, budget, out);
            } else if kind.is_file() && p.starts_with(root) {
                out.push(p);
            }
        }
    }
}
fn search_files(directories: &[String], query: &str) -> Vec<Value> {
    let terms = terms(query);
    if terms.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut budget = 1600;
    for root in directories {
        let root = Path::new(root);
        let mut found = vec![];
        files(root, root, 0, &mut budget, &mut found);
        for p in found {
            if !["md", "txt", "rs", "ts", "tsx", "js", "py", "html", "css"]
                .contains(&p.extension().unwrap_or_default().to_string_lossy().as_ref())
            {
                continue;
            }
            // Recheck canonical containment at the point of use, including symlinked ancestors.
            let Ok(real) = fs::canonicalize(&p) else {
                continue;
            };
            if !real.starts_with(root) || excluded(&real) {
                continue;
            }
            let Ok(meta) = fs::metadata(&real) else {
                continue;
            };
            if meta.len() > 65536 {
                continue;
            }
            let Ok(text) = fs::read_to_string(&real) else {
                continue;
            };
            let rank = score(&p.to_string_lossy(), &terms) * 3 + score(&text, &terms);
            if rank == 0 {
                continue;
            }
            let lines: Vec<_> = text.lines().collect();
            let line = lines.iter().position(|l| score(l, &terms) > 0).unwrap_or(0);
            let snippet = lines
                .iter()
                .skip(line.saturating_sub(1))
                .take(12)
                .copied()
                .collect::<Vec<_>>()
                .join("\n")
                .chars()
                .take(1200)
                .collect::<String>();
            out.push(json!({"file":p.to_string_lossy(),"line":line+1,"snippet":snippet,"score":rank,"modified":meta.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_secs())}));
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["score"].as_u64().unwrap_or(0)));
    out.truncate(4);
    out
}
#[tauri::command]
pub async fn pm_context(app: tauri::AppHandle, query: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c=open(&app)?;let directories=roots(&c)?;
        Ok(json!({"recall":recall(&c,&query)?,"directories":directories,"files":search_files(&directories,&query),"observedAt":now()}))
    }).await.map_err(err)?
}
fn codex_snapshot(home: &Path) -> Result<Value, String> {
    let mut paths = fs::read_dir(home)
        .map_err(|_| "未找到本机 Codex 数据")?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("state_") && n.ends_with(".sqlite"))
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|p| {
        p.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .trim_start_matches("state_")
            .parse::<u32>()
            .unwrap_or(0)
    });
    let path = paths.last().ok_or("未找到 Codex 任务索引")?;
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    c.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(err)?;
    let mut s=c.prepare("SELECT id,title,cwd,updated_at,rollout_path FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 12").map_err(|_|"当前 Codex 索引版本暂不支持")?;
    let rows = s
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(err)?;
    let mut tasks = vec![];
    for row in rows {
        let (id, title, cwd, updated, path) = row.map_err(err)?;
        let mut status = "unknown";
        let mut observed = String::new();
        let mut progress = String::new();
        if let Ok(real) = fs::canonicalize(&path) {
            if real.starts_with(home.join("sessions")) {
                if let Ok(mut f) = fs::File::open(real) {
                    let len = f.metadata().map_err(err)?.len();
                    let start = len.saturating_sub(1_048_576);
                    let _ = f.seek(SeekFrom::Start(start));
                    let mut bytes = Vec::new();
                    let _ = f.take(1_048_576).read_to_end(&mut bytes);
                    let data = String::from_utf8_lossy(&bytes);
                    for line in data.lines() {
                        if let Ok(v) = serde_json::from_str::<Value>(line) {
                            if v["type"] == "response_item"
                                && v["payload"]["type"] == "message"
                                && v["payload"]["role"] == "assistant"
                            {
                                if let Some(parts) = v["payload"]["content"].as_array() {
                                    let text = parts
                                        .iter()
                                        .filter_map(|p| p["text"].as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    if !text.is_empty() {
                                        progress = text.chars().take(300).collect();
                                    }
                                }
                            }
                            if v["type"] == "event_msg" {
                                let kind = v["payload"]["type"].as_str().unwrap_or("");
                                match kind {
                                    "task_started" => status = "running_recorded",
                                    "task_complete" => status = "completed",
                                    "turn_aborted" => status = "interrupted",
                                    _ => {}
                                }
                                observed = v["timestamp"].as_str().unwrap_or("").into();
                            }
                        }
                    }
                }
            }
        }
        let stale = now() - updated > 600;
        if stale && status == "running_recorded" {
            status = "unknown";
        }
        if !stale && status == "unknown" && !observed.is_empty() {
            status = "recent_activity";
        }
        tasks.push(json!({"id":id,"title":title,"directory":cwd,"status":status,"progress":progress,"updatedAt":updated,"lastEventAt":observed,"stale":stale}));
    }
    Ok(
        json!({"tasks":tasks,"observedAt":now(),"source":"Codex 本机只读索引和事件记录；不等同于实时进程状态，unknown 不得猜测为正在运行"}),
    )
}
#[tauri::command]
pub async fn pm_codex_status() -> Result<Value, String> {
    let home = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(
                std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_default(),
            )
            .join(".codex")
        });
    tauri::async_runtime::spawn_blocking(move || codex_snapshot(&home))
        .await
        .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_survives_new_conversation_and_revisions() {
        let c = database(Path::new(":memory:")).unwrap();
        for text in ["项目先做语音", "项目先做语音记忆"] {
            append(
                &c,
                "first",
                &[Message {
                    id: "one".into(),
                    role: "user".into(),
                    text: text.into(),
                }],
            )
            .unwrap();
        }
        append(
            &c,
            "second",
            &[Message {
                id: "two".into(),
                role: "user".into(),
                text: "继续".into(),
            }],
        )
        .unwrap();
        let result = recall(&c, "语音记忆").unwrap();
        assert_eq!(result["history"][0]["text"], "项目先做语音记忆");
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM journal", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
    #[test]
    fn private_files_are_excluded() {
        for p in [
            "/projects/a/.env",
            "/projects/a/.git/config",
            "/projects/a/token.key",
            "/projects/a/accounts.json",
            "/projects/a/node_modules/a.ts",
        ] {
            assert!(excluded(Path::new(p)));
        }
        assert!(!excluded(Path::new("/projects/a/src/app.ts")));
    }
    #[test]
    fn invalid_batch_is_atomic() {
        let c = database(Path::new(":memory:")).unwrap();
        assert!(append(
            &c,
            "one",
            &[
                Message {
                    id: "1".into(),
                    role: "user".into(),
                    text: "hello".into()
                },
                Message {
                    id: "2".into(),
                    role: "system".into(),
                    text: "bad".into()
                }
            ]
        )
        .is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM journal", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "antdesk-pm-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        fs::canonicalize(p).unwrap()
    }
    #[test]
    fn restart_restores_history_and_pinned_memory() {
        let dir = temp();
        let p = dir.join("test.sqlite3");
        {
            let c = database(&p).unwrap();
            append(
                &c,
                "yesterday",
                &[Message {
                    id: "m".into(),
                    role: "user".into(),
                    text: "先完成个人 PM".into(),
                }],
            )
            .unwrap();
            c.execute("INSERT INTO memories(text,source,created) VALUES('先完成个人 PM','用户明确保存',1)",[]).unwrap();
        }
        let c = database(&p).unwrap();
        let v = recall(&c, "个人 PM").unwrap();
        assert_eq!(v["memories"][0]["text"], "先完成个人 PM");
        assert_eq!(v["history"][0]["conversation"], "yesterday");
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn codex_inspection_is_read_only_and_stale_running_is_unknown() {
        let dir = temp();
        fs::create_dir(dir.join("sessions")).unwrap();
        let rollout = dir.join("sessions/task.jsonl");
        fs::write(&rollout,"{\"type\":\"event_msg\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"payload\":{\"type\":\"task_started\"}}\n").unwrap();
        let path = dir.join("state_5.sqlite");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,archived INTEGER)").unwrap();
        c.execute(
            "INSERT INTO threads VALUES('test','真实任务标题','/project',1,?1,0)",
            [rollout.to_string_lossy()],
        )
        .unwrap();
        drop(c);
        let original = fs::read(&path).unwrap();
        let snapshot = codex_snapshot(&dir).unwrap();
        assert_eq!(snapshot["tasks"][0]["status"], "unknown");
        assert_eq!(snapshot["tasks"][0]["stale"], true);
        assert_eq!(original, fs::read(&path).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn directory_search_does_not_follow_symlinks_or_read_secrets() {
        let dir = temp();
        let allowed = dir.join("allowed");
        fs::create_dir(&allowed).unwrap();
        fs::write(allowed.join("plan.md"), "语音助手本周计划").unwrap();
        fs::write(allowed.join(".env"), "语音助手secret").unwrap();
        fs::write(dir.join("private.md"), "语音助手private").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("private.md"), allowed.join("linked.md")).unwrap();
        let result = search_files(&[allowed.to_string_lossy().into()], "语音助手");
        assert_eq!(result.len(), 1);
        assert!(result[0]["file"].as_str().unwrap().ends_with("plan.md"));
        assert!(search_files(&[], "语音助手").is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "Read-only live Codex check"]
    fn live_codex() {
        let home = PathBuf::from(std::env::var("HOME").unwrap()).join(".codex");
        let v = codex_snapshot(&home).unwrap();
        assert!(!v["tasks"].as_array().unwrap().is_empty());
    }
}
