//! Working-order watcher for thinkorswim PaperMoney.
//!
//! Spawns the Node `orderWatcher` sidecar (same session as `.env`) and keeps
//! a table in sync with `order_events`. Cancelling an order in the web UI
//! removes the row when the CANCELED/FINAL frame arrives.

use anyhow::{Context as _, Result};
use gpui::*;
use gpui_component::{
    h_flex,
    status_bar::StatusBar,
    table::{Table, TableBody, TableCell, TableHead, TableHeader, TableRow},
    tag::Tag,
    v_flex, ActiveTheme, Root, TitleBar, WindowOptions,
};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisplayOrder {
    order_id: i64,
    symbol: String,
    side: String,
    quantity: f64,
    filled_quantity: f64,
    remaining: f64,
    order_type: String,
    limit_price: Option<f64>,
    tif: Option<String>,
    status: String,
    cancelable: bool,
}

#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(flatten)]
    body: WatcherMsg,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WatcherMsg {
    #[serde(rename = "hello")]
    Hello {
        account: String,
        #[serde(rename = "tradingSystem")]
        trading_system: String,
        #[serde(rename = "gatewayUrl")]
        gateway_url: String,
    },
    #[serde(rename = "connection")]
    Connection {
        state: String,
        attempt: Option<u32>,
        #[serde(rename = "delayMs")]
        delay_ms: Option<u64>,
        reason: Option<String>,
    },
    #[serde(rename = "orders")]
    Orders { orders: Vec<DisplayOrder> },
    #[serde(rename = "error")]
    Error { message: String },
}

struct OrderWatch {
    account: SharedString,
    connection: SharedString,
    error: Option<SharedString>,
    orders: Vec<DisplayOrder>,
}

impl OrderWatch {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, rx) = smol::channel::unbounded::<WatcherMsg>();
        match spawn_sidecar(tx.clone()) {
            Ok(()) => {}
            Err(err) => {
                let _ = tx.send_blocking(WatcherMsg::Error {
                    message: format!("{err:#}"),
                });
            }
        }

        cx.spawn(async move |this, cx| {
            while let Ok(msg) = rx.recv().await {
                if this
                    .update(cx, |this, cx| {
                        this.apply(msg);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        let _ = window;
        Self {
            account: "connecting…".into(),
            connection: "starting".into(),
            error: None,
            orders: Vec::new(),
        }
    }

    fn apply(&mut self, msg: WatcherMsg) {
        match msg {
            WatcherMsg::Hello {
                account,
                trading_system,
                ..
            } => {
                self.account = format!("{trading_system}  {account}").into();
                self.connection = "connected".into();
                self.error = None;
            }
            WatcherMsg::Connection { state, attempt, .. } => {
                self.connection = match (state.as_str(), attempt) {
                    ("reconnecting", Some(n)) => format!("reconnecting ({n})").into(),
                    (other, _) => other.to_string().into(),
                };
            }
            WatcherMsg::Orders { orders } => {
                self.orders = orders;
            }
            WatcherMsg::Error { message } => {
                self.error = Some(message.into());
                self.connection = "error".into();
            }
        }
    }

    fn status_tag(&self) -> Tag {
        match self.connection.to_string().as_str() {
            "connected" => Tag::success().small().child("connected"),
            s if s.starts_with("reconnecting") => Tag::warning().small().child(s.to_string()),
            "error" | "gaveUp" | "disconnected" => {
                Tag::danger().small().child(self.connection.clone())
            }
            other => Tag::secondary().small().child(other.to_string()),
        }
    }
}

impl Render for OrderWatch {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .child(
                TitleBar::new().child(
                    h_flex()
                        .w_full()
                        .px_3()
                        .justify_between()
                        .child("Order Watch")
                        .child(self.status_tag()),
                ),
            )
            .child(
                div()
                    .id("orders")
                    .flex_1()
                    .min_h_0()
                    .p_4()
                    .child(self.render_table(cx)),
            )
            .children(self.error.clone().map(|err| {
                div()
                    .px_4()
                    .pb_2()
                    .text_color(cx.theme().danger)
                    .child(err)
            }))
            .child(
                StatusBar::new()
                    .left(self.account.clone())
                    .child(format!("{} working", self.orders.len()))
                    .right(self.connection.clone()),
            )
            .children(Root::render_notification_layer(cx))
    }
}

impl OrderWatch {
    fn render_table(&self, cx: &App) -> impl IntoElement {
        if self.orders.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .text_color(cx.theme().muted_foreground)
                .child("No working orders")
                .child("Place or cancel in thinkorswim Web — this table follows order_events.")
                .into_any_element();
        }

        let header = TableHeader::new().child(
            TableRow::new()
                .child(TableHead::new().w(px(108.)).child("Order"))
                .child(TableHead::new().w(px(72.)).child("Side"))
                .child(TableHead::new().child("Symbol"))
                .child(TableHead::new().w(px(88.)).text_right().child("Qty"))
                .child(TableHead::new().w(px(88.)).text_right().child("Filled"))
                .child(TableHead::new().w(px(88.)).text_right().child("Limit"))
                .child(TableHead::new().w(px(72.)).child("TIF"))
                .child(TableHead::new().w(px(100.)).child("Status")),
        );

        let rows = self.orders.iter().map(|order| {
            let side_tag = if order.side.eq_ignore_ascii_case("SELL") {
                Tag::danger().small().outline().child(order.side.clone())
            } else {
                Tag::success().small().outline().child(order.side.clone())
            };
            TableRow::new()
                .child(TableCell::new().w(px(108.)).child(order.order_id.to_string()))
                .child(TableCell::new().w(px(72.)).child(side_tag))
                .child(TableCell::new().child(order.symbol.clone()))
                .child(
                    TableCell::new()
                        .w(px(88.))
                        .text_right()
                        .child(format_qty(order.remaining)),
                )
                .child(
                    TableCell::new()
                        .w(px(88.))
                        .text_right()
                        .child(format_qty(order.filled_quantity)),
                )
                .child(
                    TableCell::new()
                        .w(px(88.))
                        .text_right()
                        .child(
                            order
                                .limit_price
                                .map(|p| format!("{p}"))
                                .unwrap_or_else(|| "—".into()),
                        ),
                )
                .child(
                    TableCell::new()
                        .w(px(72.))
                        .child(order.tif.clone().unwrap_or_default()),
                )
                .child(
                    TableCell::new()
                        .w(px(100.))
                        .child(Tag::info().small().child(order.status.clone())),
                )
        });

        Table::new()
            .w_full()
            .child(header)
            .child(TableBody::new().children(rows))
            .into_any_element()
    }
}

fn format_qty(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{n:.0}")
    } else {
        format!("{n}")
    }
}

fn spawn_sidecar(tx: smol::channel::Sender<WatcherMsg>) -> Result<()> {
    let script = watcher_script()?;
    let repo = script
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let mut child = Command::new("node")
        .arg("--env-file=.env")
        .arg(&script)
        .current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn node {}", script.display()))?;

    let stdout = child.stdout.take().context("sidecar stdout")?;
    let stderr = child.stderr.take().context("sidecar stderr")?;

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Envelope>(&line) {
                Ok(env) => {
                    if tx.send_blocking(env.body).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.send_blocking(WatcherMsg::Error {
                        message: format!("bad sidecar line: {err}"),
                    });
                }
            }
        }
        let _ = child.wait();
        let _ = tx.send_blocking(WatcherMsg::Error {
            message: "order watcher exited".into(),
        });
    });

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            eprintln!("[orderWatcher] {line}");
        }
    });

    Ok(())
}

fn watcher_script() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("ORDER_WATCHER_JS") {
        return Ok(PathBuf::from(p));
    }
    let from_crate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../dist/example/orderWatcher.js");
    if from_crate.exists() {
        return Ok(from_crate.canonicalize()?);
    }
    let from_cwd = std::env::current_dir()?.join("dist/example/orderWatcher.js");
    if from_cwd.exists() {
        return Ok(from_cwd);
    }
    anyhow::bail!(
        "orderWatcher.js not found; run `npx tsc -p tsconfig.json` in tos-wsjson-client"
    );
}

fn main() {
    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);

    app.run(move |cx| {
        gpui_component::init(cx);

        cx.spawn(async move |cx| {
            let mut options = TitleBar::window_options();
            options.window_bounds = Some(WindowBounds::centered(size(px(980.), px(560.)), cx));
            options.window_min_size = Some(size(px(640.), px(360.)));

            cx.open_window(options, |window, cx| {
                window.set_window_title("Order Watch");
                let view = cx.new(|cx| OrderWatch::new(window, cx));
                cx.new(|cx| Root::new(view, window, cx).bg(cx.theme().background))
            })
            .expect("failed to open window");
        })
        .detach();
    });
}
