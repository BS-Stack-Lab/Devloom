use crate::framing::write_frame;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, Write},
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::{Duration, Instant},
};
fn id(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0 && *n <= 2147483647)
}
fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}
fn error(writer: &mut impl Write, id: Value, code: i32) -> io::Result<()> {
    write_frame(
        writer,
        &json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":"Request rejected"}}),
    )
}
fn result(writer: &mut impl Write, id: u64, value: Value) -> io::Result<()> {
    write_frame(writer, &json!({"jsonrpc":"2.0","id":id,"result":value}))
}
pub fn run(receiver: Receiver<Result<Value, ()>>, writer: &mut impl Write) -> io::Result<()> {
    let mut ready = false;
    let mut pending: BTreeMap<u64, (Instant, String)> = BTreeMap::new();
    loop {
        let now = Instant::now();
        let due: Vec<u64> = pending
            .iter()
            .filter(|(_, (at, _))| *at <= now)
            .map(|(id, _)| *id)
            .collect();
        for request_id in due {
            let (_, text) = pending.remove(&request_id).unwrap();
            result(writer, request_id, json!({"text":text}))?;
        }
        let wait = pending
            .values()
            .map(|(at, _)| at.saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(Duration::from_secs(60));
        let value = match receiver.recv_timeout(wait) {
            Ok(Ok(value)) => value,
            Ok(Err(())) => return Err(io::ErrorKind::InvalidData.into()),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        };
        let request_id = value.get("id").and_then(id);
        let has_id = value.get("id").is_some();
        if !keys(&value, &["jsonrpc", "id", "method", "params"])
            || value["jsonrpc"] != "2.0"
            || !value["method"].is_string()
            || (has_id && request_id.is_none())
        {
            error(writer, request_id.map_or(Value::Null, Value::from), -32600)?;
            if request_id.is_none() {
                return Ok(());
            }
            continue;
        }
        let method = value["method"].as_str().unwrap();
        let params = &value["params"];
        if !has_id {
            if method == "$/cancelRequest"
                && keys(params, &["id"])
                && let Some(cancel_id) = params.get("id").and_then(id)
                && pending.remove(&cancel_id).is_some()
            {
                error(writer, json!(cancel_id), -32800)?;
            }
            continue;
        }
        let request_id = request_id.unwrap();
        if pending.remove(&request_id).is_some() {
            error(writer, json!(request_id), -32600)?;
            continue;
        }
        if method == "hello" {
            if ready {
                error(writer, json!(request_id), -32600)?;
                continue;
            }
            if !keys(params, &["protocolMajor", "protocolMinor"])
                || !params["protocolMajor"].is_u64()
                || !params["protocolMinor"].is_u64()
            {
                error(writer, json!(request_id), -32602)?;
                continue;
            }
            if params["protocolMajor"] != 1 {
                error(writer, json!(request_id), -32001)?;
                return Ok(());
            }
            if params["protocolMinor"] != 0 {
                error(writer, json!(request_id), -32602)?;
                continue;
            }
            ready = true;
            result(
                writer,
                request_id,
                json!({"protocolMajor":1,"protocolMinor":0,"build":env!("CARGO_PKG_VERSION"),"features":["echo","delay","cancel","shutdown"]}),
            )?;
            continue;
        }
        if !ready {
            error(writer, json!(request_id), -32002)?;
            continue;
        }
        if method == "shutdown" {
            if !keys(params, &[]) {
                error(writer, json!(request_id), -32602)?;
                continue;
            }
            for pending_id in pending.keys() {
                error(writer, json!(pending_id), -32800)?;
            }
            result(writer, request_id, Value::Null)?;
            return Ok(());
        }
        if method != "echo" && method != "delay" {
            error(writer, json!(request_id), -32601)?;
            continue;
        }
        let allowed = if method == "echo" {
            vec!["text"]
        } else {
            vec!["text", "delayMs"]
        };
        let text = params["text"].as_str();
        let delay = params["delayMs"].as_u64();
        if !keys(params, &allowed)
            || text.is_none_or(|s| s.len() > 8192)
            || (method == "delay" && delay.is_none_or(|d| d > 10000))
        {
            error(writer, json!(request_id), -32602)?;
            continue;
        }
        if method == "echo" {
            result(writer, request_id, json!({"text":text.unwrap()}))?;
        } else if pending.len() >= 16 {
            error(writer, json!(request_id), -32003)?;
        } else {
            pending.insert(
                request_id,
                (
                    Instant::now() + Duration::from_millis(delay.unwrap()),
                    text.unwrap().to_owned(),
                ),
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handshake_and_shutdown() {
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        tx.send(Ok(
            json!({"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"x"}}),
        ))
        .unwrap();
        tx.send(Ok(json!({"jsonrpc":"2.0","id":2,"method":"hello","params":{"protocolMajor":99,"protocolMinor":0}}))).unwrap();
        let mut bytes = Vec::new();
        run(rx, &mut bytes).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("-32002"));
        assert!(text.contains("-32001"));
    }
}
