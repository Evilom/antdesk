//! Durable continuity for one conversation across transport renewals and midnight.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

fn error(e: impl std::fmt::Display) -> String {
    format!("全天对话记录：{e}")
}
fn init(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS conversation_openings(seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_observations(seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, source TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_observation_source ON conversation_observations(conversation,source,seq);
      CREATE INDEX IF NOT EXISTS conversation_observation_time ON conversation_observations(conversation,created);
      CREATE INDEX IF NOT EXISTS journal_conversation_time ON journal(conversation,created);").map_err(error)
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 {
        Err("对话标识无效".into())
    } else {
        Ok(())
    }
}
pub(super) fn active_conversation(c: &Connection) -> Result<Option<String>, String> {
    init(c)?;
    c.query_row(
        "SELECT conversation FROM conversation_openings ORDER BY seq DESC LIMIT 1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map_err(error)
}
fn activate(c: &Connection, conversation: &str, at: i64) -> Result<(), String> {
    valid_id(conversation)?;
    if active_conversation(c)?.as_deref() != Some(conversation) {
        c.execute(
            "INSERT INTO conversation_openings(conversation,created) VALUES(?1,?2)",
            params![conversation, at],
        )
        .map_err(error)?;
    }
    Ok(())
}
#[tauri::command]
pub fn pm_activate_conversation(app: tauri::AppHandle, conversation: String) -> Result<(), String> {
    activate(&crate::pm::open(&app)?, &conversation, crate::pm::now())
}
#[derive(Deserialize)]
pub struct Observation {
    source: String,
    fingerprint: String,
    text: String,
}
fn record(
    c: &Connection,
    conversation: &str,
    entries: &[Observation],
    at: i64,
) -> Result<(), String> {
    valid_id(conversation)?;
    init(c)?;
    if entries.len() > 64 {
        return Err("单次项目记录过多".into());
    }
    let tx = c.unchecked_transaction().map_err(error)?;
    for entry in entries {
        if entry.source.is_empty()
            || entry.source.len() > 1200
            || entry.fingerprint.len() > 8000
            || entry.text.chars().count() > 1800
        {
            return Err("项目记录格式无效".into());
        }
        let previous: Option<String>=tx.query_row("SELECT fingerprint FROM conversation_observations WHERE conversation=?1 AND source=?2 ORDER BY seq DESC LIMIT 1",params![conversation,entry.source],|r|r.get(0)).optional().map_err(error)?;
        if previous.as_deref() != Some(&entry.fingerprint) {
            tx.execute("INSERT INTO conversation_observations(conversation,source,fingerprint,text,created) VALUES(?1,?2,?3,?4,?5)",params![conversation,entry.source,entry.fingerprint,entry.text,at]).map_err(error)?;
        }
    }
    tx.commit().map_err(error)
}
#[tauri::command]
pub fn pm_record_observations(
    app: tauri::AppHandle,
    conversation: String,
    entries: Vec<Observation>,
) -> Result<(), String> {
    record(
        &crate::pm::open(&app)?,
        &conversation,
        &entries,
        crate::pm::now(),
    )
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    kind: String,
    text: String,
    created: i64,
    order: i64,
    matched: bool,
}
/// Retain coverage across the entire window, recent turns, and query matches separately.
fn select(
    entries: impl Iterator<Item = Result<Entry, String>>,
    since: i64,
    query: &str,
) -> Result<(Vec<Entry>, usize), String> {
    let terms = crate::pm::terms(query);
    let mut buckets: BTreeMap<(i64, String), Vec<Entry>> = BTreeMap::new();
    let mut recent = Vec::new();
    let mut matches = Vec::new();
    let mut count = 0;
    for row in entries {
        let mut row = row?;
        count += 1;
        let rank = crate::pm::score(&row.text, &terms);
        row.matched = rank > 0;
        // A matched excerpt starts near the matched term, even in a long voice reply.
        let chars: Vec<char> = row.text.chars().collect();
        let start = if rank > 0 {
            let lower = row.text.to_lowercase();
            terms
                .iter()
                .filter_map(|term| lower.find(term))
                .min()
                .map(|byte| lower[..byte].chars().count().saturating_sub(80))
                .unwrap_or(0)
        } else {
            0
        };
        row.text = chars.iter().skip(start).take(420).collect();
        if chars.len() > start + 420 {
            row.text.push_str("…（节选）");
        }
        if start > 0 {
            row.text.insert(0, '…');
        }
        if rank > 0 {
            matches.push((rank, row.clone()));
            matches.sort_by_key(|(rank, r)| std::cmp::Reverse((*rank, r.created)));
            matches.truncate(12);
        }
        let bucket = buckets
            .entry(((row.created - since) / 7200, row.kind.clone()))
            .or_default();
        if bucket.len() < 2 {
            bucket.push(row.clone());
        } else {
            bucket[1] = row.clone();
        }
        recent.push(row);
        if recent.len() > 8 {
            recent.remove(0);
        }
    }
    let mut result = matches
        .into_iter()
        .map(|(_, r)| r)
        .chain(buckets.into_values().flatten())
        .chain(recent)
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    result.retain(|r| seen.insert(r.id.clone()));
    result.sort_by_key(|r| (r.created, r.order));
    Ok((result, count))
}
fn read_day(c: &Connection, conversation: &str, query: &str, at: i64) -> Result<Value, String> {
    valid_id(conversation)?;
    init(c)?;
    let since = at - 86400;
    let started: Option<i64> = c
        .query_row(
            "SELECT MIN(created) FROM conversation_openings WHERE conversation=?1",
            [conversation],
            |r| r.get(0),
        )
        .map_err(error)?;
    let mut statement=c.prepare("SELECT j.message_id,j.role,j.text,(SELECT MIN(created) FROM journal o WHERE o.conversation=j.conversation AND o.message_id=j.message_id) AS first_at,(SELECT MIN(seq) FROM journal o WHERE o.conversation=j.conversation AND o.message_id=j.message_id) AS first_seq FROM journal j WHERE j.conversation=?1 AND j.created>=?2 AND j.created<=?3 AND NOT EXISTS(SELECT 1 FROM journal n WHERE n.conversation=j.conversation AND n.message_id=j.message_id AND n.seq>j.seq) ORDER BY first_at,first_seq").map_err(error)?;
    let rows = statement
        .query_map(params![conversation, since, at], |r| {
            Ok(Entry {
                id: format!("message:{}", r.get::<_, String>(0)?),
                kind: r.get(1)?,
                text: r.get(2)?,
                created: r.get(3)?,
                order: r.get(4)?,
                matched: false,
            })
        })
        .map_err(error)?;
    let (messages, message_count) = select(
        rows.map(|r| r.map_err(error)).filter(|r| {
            r.as_ref()
                .map(|r| r.created >= since && r.created <= at)
                .unwrap_or(true)
        }),
        since,
        query,
    )?;
    let mut statement=c.prepare("SELECT seq,text,created FROM conversation_observations WHERE conversation=?1 AND created>=?2 AND created<=?3 ORDER BY created,seq").map_err(error)?;
    let rows = statement
        .query_map(params![conversation, since, at], |r| {
            Ok(Entry {
                id: format!("observation:{}", r.get::<_, i64>(0)?),
                kind: "project".into(),
                text: r.get(1)?,
                created: r.get(2)?,
                order: r.get(0)?,
                matched: false,
            })
        })
        .map_err(error)?;
    let (observations, observation_count) = select(rows.map(|r| r.map_err(error)), since, query)?;
    Ok(
        json!({"conversation":conversation,"startedAt":started,"observedAt":at,"since":since,"messageCount":message_count,"observationCount":observation_count,"messages":messages,"observations":observations,"scope":"仅本对话文字/语音转写及客户端采集的已接入项目状态；记录时间不等于工作耗时；未采集的活动未知"}),
    )
}
#[tauri::command]
pub async fn pm_day_context(
    app: tauri::AppHandle,
    conversation: String,
    query: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_day(
            &crate::pm::open(&app)?,
            &conversation,
            &query.chars().take(500).collect::<String>(),
            crate::pm::now(),
        )
    })
    .await
    .map_err(error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE journal(seq INTEGER PRIMARY KEY,conversation TEXT,message_id TEXT,role TEXT,text TEXT,created INTEGER);CREATE INDEX journal_message ON journal(conversation,message_id,seq);").unwrap();
        c
    }
    #[test]
    fn midnight_and_many_messages_keep_morning_and_current_conversation() {
        let c = db();
        let at = 2_000_000;
        activate(&c, "same-day", at - 86300).unwrap();
        for i in 0..300 {
            c.execute("INSERT INTO journal(conversation,message_id,role,text,created) VALUES('same-day',?1,'user',?2,?3)",params![format!("m{i}"),if i==0{"早上完成番薯工作包".to_string()}else{format!("第{i}条进展")},at-86000+i*250]).unwrap();
        }
        c.execute("INSERT INTO journal(conversation,message_id,role,text,created) VALUES('other','x','user','无关对话',?1)",[at]).unwrap();
        let day = read_day(&c, "same-day", "番薯", at).unwrap();
        assert_eq!(day["messageCount"], 300);
        assert!(day["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["text"] == "早上完成番薯工作包" && r["matched"] == true));
        assert!(day["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "message:m299"));
        assert_eq!(
            active_conversation(&c).unwrap().as_deref(),
            Some("same-day")
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM journal", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            301
        );
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
    #[test]
    fn revisions_are_one_turn_and_do_not_make_yesterday_new() {
        let c = db();
        let at = 2_000_000;
        for (id, text, time) in [
            ("old", "昨天的原文", at - 90000),
            ("old", "昨天的修订", at - 20),
            ("today", "今天草稿", at - 100),
            ("today", "今天最终稿", at - 10),
        ] {
            c.execute("INSERT INTO journal(conversation,message_id,role,text,created) VALUES('c',?1,'user',?2,?3)",params![id,text,time]).unwrap();
        }
        let day = read_day(&c, "c", "", at).unwrap();
        assert_eq!(day["messageCount"], 1);
        assert_eq!(day["messages"][0]["text"], "今天最终稿");
        assert_eq!(day["messages"][0]["created"], at - 100);
    }
    #[test]
    fn same_second_turns_keep_original_order_and_empty_conversation_survives_restart() {
        let dir = std::env::temp_dir().join(format!("antdesk-continuity-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.sqlite3");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE journal(seq INTEGER PRIMARY KEY,conversation TEXT,message_id TEXT,role TEXT,text TEXT,created INTEGER);").unwrap();
            activate(&c, "first", 100).unwrap();
            for (id, role, text) in [
                ("u", "user", "第一句"),
                ("a", "assistant", "第二句"),
                ("u", "user", "第一句修订"),
            ] {
                c.execute("INSERT INTO journal(conversation,message_id,role,text,created) VALUES('first',?1,?2,?3,100)",params![id,role,text]).unwrap();
            }
            let day = read_day(&c, "first", "", 101).unwrap();
            assert_eq!(day["messages"][0]["text"], "第一句修订");
            assert_eq!(day["messages"][1]["text"], "第二句");
            activate(&c, "new-empty", 102).unwrap();
        }
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            active_conversation(&c).unwrap().as_deref(),
            Some("new-empty")
        );
        assert_eq!(read_day(&c, "first", "", 86401).unwrap()["messageCount"], 2);
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(c);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn observations_dedupe_polls_but_keep_reverts_and_new_conversation_is_explicit() {
        let c = db();
        activate(&c, "first", 1).unwrap();
        activate(&c, "first", 2).unwrap();
        for (at, state) in [(1, "dirty"), (2, "dirty"), (3, "clean"), (4, "dirty")] {
            record(
                &c,
                "first",
                &[Observation {
                    source: "git:project".into(),
                    fingerprint: state.into(),
                    text: state.into(),
                }],
                at,
            )
            .unwrap();
        }
        let day = read_day(&c, "first", "", 10).unwrap();
        assert_eq!(day["observationCount"], 3);
        activate(&c, "second", 5).unwrap();
        assert_eq!(active_conversation(&c).unwrap().as_deref(), Some("second"));
        assert_eq!(
            read_day(&c, "second", "", 10).unwrap()["observationCount"],
            0
        );
        assert_eq!(
            read_day(&c, "first", "", 10).unwrap()["observationCount"],
            3
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM conversation_openings", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}
