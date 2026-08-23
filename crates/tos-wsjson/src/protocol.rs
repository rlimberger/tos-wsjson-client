//! Wire format.
//!
//! Every request is `{"payload":[{"header":{service,id,ver},"params":{…}}]}` and
//! every response `{"payload":[{"header":{service,id,ver,type},"body":{…}}]}`,
//! where `type` is `snapshot` | `patch` | `error`. Patch bodies carry an
//! RFC-6902 array to apply to the last document seen for the same id.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Sent as the first frame after the socket opens; the gateway replies with a
/// [`ConnectionResponse`] and then heartbeats at the requested interval.
pub const CONNECTION_REQUEST: &str =
    r#"{"ver":"27.*.*","fmt":"json-patches-structured","heartbeat":"2s"}"#;

#[derive(Debug, Clone, Serialize)]
pub struct RequestHeader {
    pub service: String,
    pub id: String,
    pub ver: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequestItem {
    pub header: RequestHeader,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct Request {
    pub payload: Vec<RequestItem>,
}

impl Request {
    pub fn one(service: &str, id: &str, ver: u32, params: Value) -> Self {
        Request {
            payload: vec![RequestItem {
                header: RequestHeader {
                    service: service.to_string(),
                    id: id.to_string(),
                    ver,
                },
                params,
            }],
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResponseHeader {
    pub service: String,
    pub id: String,
    #[serde(default)]
    pub ver: u32,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResponseItem {
    pub header: ResponseHeader,
    #[serde(default)]
    pub body: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Response {
    pub payload: Vec<ResponseItem>,
}

/// The gateway's reply to [`CONNECTION_REQUEST`].
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionResponse {
    pub session: String,
    pub build: String,
    pub ver: String,
}

/// What a raw inbound text frame can be.
#[derive(Debug, Clone)]
pub enum Frame {
    Connected(ConnectionResponse),
    Heartbeat(i64),
    Payload(Response),
    Unknown(Value),
}

pub fn parse_frame(text: &str) -> Result<Frame, serde_json::Error> {
    let value: Value = serde_json::from_str(text)?;
    if value.get("payload").is_some() {
        return Ok(Frame::Payload(serde_json::from_value(value)?));
    }
    if let Some(hb) = value.get("heartbeat").and_then(|v| v.as_i64()) {
        return Ok(Frame::Heartbeat(hb));
    }
    if value.get("session").is_some() && value.get("build").is_some() {
        return Ok(Frame::Connected(serde_json::from_value(value)?));
    }
    Ok(Frame::Unknown(value))
}

/// A decoded response document for one request id.
#[derive(Debug, Clone)]
pub struct Document {
    pub service: String,
    pub id: String,
    pub ver: u32,
    /// Full document after applying any patches.
    pub body: Value,
}
