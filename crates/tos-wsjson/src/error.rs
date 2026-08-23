use std::fmt;

/// Everything that can go wrong talking to the gateway.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("websocket: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    /// The gateway answered with `type: "error"`.
    #[error("{service}: {message}")]
    Service { service: String, message: String },

    /// Login was rejected — the token is missing, expired or revoked. Callers
    /// use this to decide whether to start an interactive login.
    #[error("login rejected: {0}")]
    Auth(String),

    #[error("the connection is closed")]
    Disconnected,

    #[error("timed out waiting for {0}")]
    Timeout(String),

    #[error("{0}")]
    Protocol(String),
}

impl Error {
    /// True when re-authenticating (rather than reconnecting) is the fix.
    pub fn is_auth(&self) -> bool {
        matches!(self, Error::Auth(_))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Marker for a request that a caller can wait on.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestId(pub String);

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for RequestId {
    fn from(value: &str) -> Self {
        RequestId(value.to_string())
    }
}

impl From<String> for RequestId {
    fn from(value: String) -> Self {
        RequestId(value)
    }
}
