use std::{collections::HashMap, path::PathBuf};

use pico_core::omp::camofox::CamofoxDaemon;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

fn temp_root() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("pico-camofox-e2e-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn http(base: &str, key: &str, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let addr = base.trim_start_matches("http://");
    let mut stream = TcpStream::connect(addr).await.expect("connect to camofox daemon");
    let body = body.unwrap_or("");
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n");
    if !body.is_empty() {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    } else if method != "GET" {
        req.push_str("Content-Length: 0\r\n");
    }
    req.push_str("\r\n");
    req.push_str(body);
    stream.write_all(req.as_bytes()).await.expect("write request");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read response");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    (status, body)
}

async fn snapshot_until_content(base: &str, key: &str, tab_id: &str) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (status, body) = http(base, key, "GET", &format!("/tabs/{tab_id}/snapshot?userId=default"), None).await;
        assert_eq!(status, 200, "snapshot should be 200; body: {body}");
        if body.contains("Example Domain") || std::time::Instant::now() >= deadline {
            return body;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[tokio::test]
#[ignore = "live: needs the built pico image (pinned camofox-browser + camofox-fetch-engine + Xvfb + GTK/Firefox libs); fetches the engine if absent"]
async fn camofox_daemon_serves_snapshots_and_session_groups() {
    let root = temp_root();
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let daemon = CamofoxDaemon::new(&root, cancel.clone(), &tracker);

    pico_core::omp::camofox::ensure_engine(cancel.clone()).await;
    daemon.ensure_started().await;

    let env: HashMap<String, String> = daemon.host_env(true).into_iter().collect();
    let base = env["CAMOFOX_BASE_URL"].clone();
    let key = env["CAMOFOX_ACCESS_KEY"].clone();

    let (health, _) = http(&base, &key, "GET", "/health", None).await;
    assert_eq!(health, 200, "daemon /health should be 200 after ensure_started");

    let (status, created) = http(
        &base,
        &key,
        "POST",
        "/tabs",
        Some(r#"{"userId":"default","sessionKey":"threadA","url":"https://example.com"}"#),
    )
    .await;
    assert_eq!(status, 200, "POST /tabs threadA should be 200; body: {created}");
    let tab_id = created
        .split_once("\"tabId\":\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(id, _)| id.to_owned())
        .unwrap_or_else(|| panic!("no tabId in create response: {created}"));

    let snapshot = snapshot_until_content(&base, &key, &tab_id).await;
    assert!(snapshot.contains("Example Domain"), "snapshot missing page content: {snapshot}");

    let (status_b, created_b) = http(
        &base,
        &key,
        "POST",
        "/tabs",
        Some(r#"{"userId":"default","sessionKey":"threadB","url":"https://example.com"}"#),
    )
    .await;
    assert_eq!(status_b, 200, "POST /tabs threadB should be 200; body: {created_b}");

    let (status, listing) = http(&base, &key, "GET", "/tabs?userId=default", None).await;
    assert_eq!(status, 200, "GET /tabs should be 200; body: {listing}");
    assert!(
        listing.contains(r#""listItemId":"threadA""#),
        "listing missing threadA group; body: {listing}"
    );
    assert!(
        listing.contains(r#""listItemId":"threadB""#),
        "listing missing threadB group; body: {listing}"
    );

    cancel.cancel();
    tracker.close();
    tracker.wait().await;
    std::fs::remove_dir_all(&root).ok();
}
