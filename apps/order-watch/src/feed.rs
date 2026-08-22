//! Client for the local order-feed bridge (`dist/example/orderFeedServer.js`).
//!
//! The bridge owns the authenticated thinkorswim session and re-broadcasts the
//! working-order book. The UI never holds the token and can restart freely.

use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

use serde::Deserialize;

pub const DEFAULT_FEED_URL: &str = "ws://127.0.0.1:8787";

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Order {
    #[serde(rename = "orderId")]
    pub order_id: i64,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub quantity: f64,
    #[serde(default, rename = "filledQuantity")]
    pub filled_quantity: f64,
    #[serde(default)]
    pub remaining: f64,
    #[serde(default, rename = "orderType")]
    pub order_type: String,
    #[serde(default, rename = "limitPrice")]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub tif: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// Frames the bridge sends. Unknown variants fail decode and are skipped, so a
/// newer bridge cannot crash an older watcher.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FeedMessage {
    Session {
        account: String,
        #[serde(rename = "tradingSystem")]
        trading_system: String,
    },
    Orders {
        orders: Vec<Order>,
    },
    Connection {
        state: String,
    },
}

#[derive(Debug, Clone)]
pub enum FeedEvent {
    Message(FeedMessage),
    BridgeDown(String),
    BridgeUp,
}

/// Reconnects to the bridge forever with a fixed backoff. The Schwab session
/// lives in the Node process, not here.
pub fn spawn(url: String, tx: Sender<FeedEvent>) {
    thread::spawn(move || loop {
        match tungstenite::connect(&url) {
            Ok((mut socket, _resp)) => {
                if tx.send(FeedEvent::BridgeUp).is_err() {
                    return;
                }
                loop {
                    match socket.read() {
                        Ok(tungstenite::Message::Text(text)) => {
                            match serde_json::from_str::<FeedMessage>(&text) {
                                Ok(msg) => {
                                    if tx.send(FeedEvent::Message(msg)).is_err() {
                                        return;
                                    }
                                }
                                Err(_) => continue,
                            }
                        }
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => continue,
                        Err(e) => {
                            let _ = tx.send(FeedEvent::BridgeDown(e.to_string()));
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                if tx.send(FeedEvent::BridgeDown(e.to_string())).is_err() {
                    return;
                }
            }
        }
        thread::sleep(Duration::from_secs(2));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_bridge_frames() {
        let session: FeedMessage = serde_json::from_str(
            r#"{"type":"session","account":"D-68851449","tradingSystem":"PaperMoney"}"#,
        )
        .unwrap();
        assert!(matches!(session, FeedMessage::Session { .. }));

        let orders: FeedMessage = serde_json::from_str(
            r#"{"type":"orders","orders":[{"orderId":5388218149,"symbol":"/MESU26:XCME",
                "side":"BUY","quantity":1,"filledQuantity":0,"remaining":1,
                "orderType":"LIMIT","limitPrice":1050,"tif":"DAY","status":"WORKING",
                "description":"BUY +1 /MESU26:XCME @1050.00 LMT"}]}"#,
        )
        .unwrap();
        match orders {
            FeedMessage::Orders { orders } => {
                assert_eq!(orders.len(), 1);
                assert_eq!(orders[0].order_id, 5388218149);
                assert_eq!(orders[0].limit_price, Some(1050.0));
            }
            other => panic!("expected orders, got {other:?}"),
        }
    }

    #[test]
    fn unknown_frame_types_are_skipped() {
        assert!(serde_json::from_str::<FeedMessage>(r#"{"type":"whatever"}"#).is_err());
    }
}
