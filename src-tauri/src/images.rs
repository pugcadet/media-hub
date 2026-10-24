//! Serves pictures to the window through a private address scheme (`hubimg://`).
//! The window never sees the server address or the API key: it asks for
//! `/<item id>/<Primary|Backdrop|...>?w=<width>` and this code fetches it from Jellyfin.

use crate::error::{Error, Result};
use crate::state::AppState;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, UriSchemeResponder};

fn plain(status: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static response")
}

fn width_from_query(q: Option<&str>) -> u32 {
    q.unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("w="))
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(400)
}

async fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>> {
    let uri = request.uri();
    let mut parts = uri.path().split('/').filter(|p| !p.is_empty());
    let (Some(id), Some(kind), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(Error::msg("bad path"));
    };
    let state = app.state::<AppState>();
    let client = state.client()?.ok_or_else(|| Error::msg("not connected"))?;
    let (bytes, content_type) = client.image(id, kind, width_from_query(uri.query())).await?;
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Cache-Control", "private, max-age=86400")
        .body(bytes)
        .map_err(|e| Error::msg(e.to_string()))
}

pub fn handle(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let response = serve(&app, &request).await.unwrap_or_else(|_| plain(404));
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_width() {
        assert_eq!(width_from_query(Some("w=300")), 300);
        assert_eq!(width_from_query(Some("x=1&w=640")), 640);
        assert_eq!(width_from_query(Some("w=abc")), 400);
        assert_eq!(width_from_query(None), 400);
    }
}
