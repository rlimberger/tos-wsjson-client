//! Working-order watcher. Never talks to Schwab: `orderFeedServer.js` owns
//! the authenticated session and broadcasts the book over localhost WebSocket.
//! A cancel or fill made in the ToS web UI reaches this window through the
//! same `order_events` stream and the row disappears or updates.

mod feed;

use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

use feed::{FeedEvent, FeedMessage, Order};
use gpui::{prelude::FluentBuilder as _, *};
use gpui_component::{
    table::{Column, DataTable, TableDelegate, TableState},
    ActiveTheme as _, StyledExt as _, *,
};

/// How often the UI drains the feed thread's channel.
const POLL_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Clone, Copy, PartialEq)]
enum Link {
    Connecting,
    Up,
    Down,
}

impl Link {
    fn label(self) -> &'static str {
        match self {
            Link::Connecting => "connecting",
            Link::Up => "live",
            Link::Down => "disconnected",
        }
    }
}

struct OrdersTable {
    columns: Vec<Column>,
    orders: Vec<Order>,
}

impl OrdersTable {
    fn new() -> Self {
        Self {
            columns: vec![
                Column::new("id", "Order").width(px(110.)),
                Column::new("symbol", "Contract").width(px(140.)),
                Column::new("side", "Side").width(px(60.)),
                Column::new("qty", "Qty").width(px(90.)),
                Column::new("price", "Price").width(px(100.)),
                Column::new("type", "Type").width(px(90.)),
                Column::new("tif", "TIF").width(px(70.)),
                Column::new("status", "Status").width(px(100.)),
            ],
            orders: Vec::new(),
        }
    }
}

fn fmt_qty(o: &Order) -> String {
    if o.filled_quantity > 0.0 {
        format!("{}/{}", o.filled_quantity, o.quantity)
    } else {
        format!("{}", o.quantity)
    }
}

fn fmt_price(o: &Order) -> String {
    match o.limit_price {
        Some(p) => format!("{p:.2}"),
        None => "—".to_string(),
    }
}

impl TableDelegate for OrdersTable {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.orders.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> Column {
        self.columns[col_ix].clone()
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let Some(order) = self.orders.get(row_ix) else {
            return div().into_any_element();
        };
        // Side is the one place color carries meaning.
        let buy = order.side.eq_ignore_ascii_case("BUY");
        match col_ix {
            0 => format!("{}", order.order_id).into_any_element(),
            1 => order.symbol.clone().into_any_element(),
            2 => div()
                .text_color(if buy {
                    cx.theme().green
                } else {
                    cx.theme().red
                })
                .child(order.side.clone())
                .into_any_element(),
            3 => fmt_qty(order).into_any_element(),
            4 => fmt_price(order).into_any_element(),
            5 => order.order_type.clone().into_any_element(),
            6 => order.tif.clone().unwrap_or_default().into_any_element(),
            7 => order.status.clone().into_any_element(),
            _ => div().into_any_element(),
        }
    }
}

struct Watcher {
    table: Entity<TableState<OrdersTable>>,
    rx: Receiver<FeedEvent>,
    account: Option<String>,
    trading_system: Option<String>,
    gateway_state: String,
    link: Link,
    last_error: Option<String>,
    order_count: usize,
}

impl Watcher {
    fn new(rx: Receiver<FeedEvent>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let table = cx.new(|cx| TableState::new(OrdersTable::new(), window, cx));

        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL_INTERVAL).await;
                if this.update(cx, |this, cx| this.drain(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        Self {
            table,
            rx,
            account: None,
            trading_system: None,
            gateway_state: "unknown".into(),
            link: Link::Connecting,
            last_error: None,
            order_count: 0,
        }
    }

    fn drain(&mut self, cx: &mut Context<Self>) {
        let mut dirty = false;
        while let Ok(event) = self.rx.try_recv() {
            dirty = true;
            match event {
                FeedEvent::Message(FeedMessage::Session {
                    account,
                    trading_system,
                }) => {
                    self.account = Some(account);
                    self.trading_system = Some(trading_system);
                }
                FeedEvent::Message(FeedMessage::Orders { orders }) => {
                    self.order_count = orders.len();
                    self.table.update(cx, |state, cx| {
                        state.delegate_mut().orders = orders;
                        state.refresh(cx);
                    });
                }
                FeedEvent::Message(FeedMessage::Connection { state }) => {
                    self.gateway_state = state;
                }
                FeedEvent::BridgeUp => {
                    self.link = Link::Up;
                    self.last_error = None;
                }
                FeedEvent::BridgeDown(err) => {
                    self.link = Link::Down;
                    self.last_error = Some(err);
                    self.table.update(cx, |state, cx| {
                        state.delegate_mut().orders.clear();
                        state.refresh(cx);
                    });
                    self.order_count = 0;
                }
            }
        }
        if dirty {
            cx.notify();
        }
    }

    fn status_dot(&self, cx: &App) -> Div {
        let color = match self.link {
            Link::Up if self.gateway_state == "connected" => cx.theme().green,
            Link::Up => cx.theme().yellow,
            Link::Connecting => cx.theme().yellow,
            Link::Down => cx.theme().red,
        };
        div().size_2().rounded_full().bg(color)
    }

    fn header(&self, cx: &App) -> impl IntoElement {
        let account = self.account.clone().unwrap_or_else(|| "—".into());
        let system = self.trading_system.clone().unwrap_or_else(|| "—".into());
        h_flex()
            .w_full()
            .px_3()
            .py_2()
            .gap_3()
            .items_center()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(self.status_dot(cx))
            .child(div().font_semibold().child("Working orders"))
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!("{system} · {account}")),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!(
                        "{} order{} · bridge {} · gateway {}",
                        self.order_count,
                        if self.order_count == 1 { "" } else { "s" },
                        self.link.label(),
                        self.gateway_state
                    )),
            )
    }

    fn empty_state(&self, cx: &App) -> impl IntoElement {
        let message = match (self.link, self.last_error.as_ref()) {
            (Link::Down, Some(err)) => format!("Bridge unreachable — {err}"),
            (Link::Down, None) => "Bridge unreachable".to_string(),
            (Link::Connecting, _) => "Connecting to the order feed…".to_string(),
            (Link::Up, _) => "No working orders".to_string(),
        };
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_1()
            .child(
                div()
                    .text_color(cx.theme().muted_foreground)
                    .child(message),
            )
            .when(self.link == Link::Down, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(
                            "start it with: node --env-file=.env dist/example/orderFeedServer.js",
                        ),
                )
            })
    }
}

impl Render for Watcher {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_rows = self.order_count > 0;
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.header(cx))
            .child(
                div()
                    .flex_1()
                    .w_full()
                    .when(has_rows, |this| {
                        this.child(DataTable::new(&self.table).stripe(true).bordered(false))
                    })
                    .when(!has_rows, |this| this.child(self.empty_state(cx))),
            )
    }
}

fn main() {
    let url = std::env::var("TOS_FEED_URL").unwrap_or_else(|_| feed::DEFAULT_FEED_URL.to_string());
    let (tx, rx) = channel();
    feed::spawn(url, tx);

    gpui_platform::application().run(move |cx| {
        gpui_component::init(cx);
        cx.spawn(async move |cx| {
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: point(px(120.), px(120.)),
                        size: size(px(880.), px(420.)),
                    })),
                    titlebar: Some(TitlebarOptions {
                        title: Some("thinkorswim — working orders".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    let view = cx.new(|cx| Watcher::new(rx, window, cx));
                    cx.new(|cx| Root::new(view, window, cx).bg(cx.theme().background))
                },
            )
            .expect("failed to open window");
        })
        .detach();
    });
}
