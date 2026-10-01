//! `tomo-file://localhost/<encoded absolute path>`: the bytes of a local image, video, audio, or PDF file, for the
//! viewer of a file pane. Only the main webview may read, and only files of those types, so a page in a browser
//! pane cannot read the disk through it. A media element asks for byte ranges, so a long video seeks at once.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "tomo-file";
const MAIN_WEBVIEW: &str = "main";
const CHUNK: u64 = 4 * 1024 * 1024;

pub fn mime_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "jxl" => "image/jxl",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// The first byte and the last byte of a `Range: bytes=…` header, clamped to the file and to one chunk.
/// `Err` is a range that starts after the end of the file. A header that is not one byte range reads as none.
fn byte_range(spec: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some((first, last)) = spec.and_then(|s| s.trim().strip_prefix("bytes=")).filter(|s| !s.contains(',')).and_then(|s| s.split_once('-')) else {
        return Ok(None);
    };
    let (start, end) = match (first.trim().parse::<u64>().ok(), last.trim().parse::<u64>().ok()) {
        (None, Some(suffix)) => (len.saturating_sub(suffix), len.saturating_sub(1)),
        (Some(start), None) => (start, len.saturating_sub(1)),
        (Some(start), Some(end)) => (start, end.min(len.saturating_sub(1))),
        (None, None) => return Ok(None),
    };
    if start >= len || start > end {
        return Err(());
    }
    Ok(Some((start, end.min(start + CHUNK - 1))))
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap_or_default()
}

fn read_span(path: &Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn serve(webview: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if webview != MAIN_WEBVIEW {
        return status(StatusCode::FORBIDDEN);
    }
    let encoded = request.uri().path().trim_start_matches('/');
    let Ok(decoded) = percent_encoding::percent_decode_str(encoded).decode_utf8() else { return status(StatusCode::BAD_REQUEST) };
    let path = Path::new(decoded.as_ref());
    let Some(mime) = path.is_absolute().then(|| mime_of(path)).flatten() else { return status(StatusCode::FORBIDDEN) };
    let Some(len) = std::fs::metadata(path).ok().filter(|m| m.is_file()).map(|m| m.len()) else { return status(StatusCode::NOT_FOUND) };
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let (code, start, end) = match byte_range(range, len) {
        Err(()) => return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{len}")).body(Vec::new()).unwrap_or_default(),
        Ok(Some((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end),
        Ok(None) => (StatusCode::OK, 0, len.saturating_sub(1)),
    };
    let size = if len == 0 { 0 } else { end - start + 1 };
    let Ok(body) = read_span(path, start, size) else { return status(StatusCode::INTERNAL_SERVER_ERROR) };
    let response = Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, body.len());
    let response = if code == StatusCode::PARTIAL_CONTENT { response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")) } else { response };
    response.body(body).unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_is_clamped_to_the_file_and_to_one_chunk() {
        assert_eq!(byte_range(None, 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-1"), 100), Ok(Some((0, 1))));
        assert_eq!(byte_range(Some("bytes=10-"), 100), Ok(Some((10, 99))));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(byte_range(Some("bytes=50-500"), 100), Ok(Some((50, 99))));
        assert_eq!(byte_range(Some("bytes=0-"), 10 * CHUNK), Ok(Some((0, CHUNK - 1))));
        assert_eq!(byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=0-1,5-6"), 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-"), 0), Err(()));
    }

    fn get(webview: &str, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let uri = format!("{SCHEME}://localhost/{}", percent_encoding::utf8_percent_encode(path, percent_encoding::NON_ALPHANUMERIC));
        let request = range.into_iter().fold(Request::builder().uri(uri), |r, v| r.header(header::RANGE, v));
        serve(webview, &request.body(Vec::new()).unwrap())
    }

    #[test]
    fn only_the_main_webview_reads_and_only_viewable_files() {
        let dir = std::env::temp_dir().join(format!("tomo-viewer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a b.png");
        std::fs::write(&png, b"0123456789").unwrap();
        std::fs::write(dir.join("secret.txt"), b"no").unwrap();
        let png = png.to_string_lossy().into_owned();

        let whole = get("main", &png, None);
        assert_eq!((whole.status(), whole.body().as_slice()), (StatusCode::OK, &b"0123456789"[..]));
        assert_eq!(whole.headers()[header::CONTENT_TYPE], "image/png");
        let part = get("main", &png, Some("bytes=2-4"));
        assert_eq!((part.status(), part.body().as_slice()), (StatusCode::PARTIAL_CONTENT, &b"234"[..]));
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(get("main", &png, Some("bytes=20-")).status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(get("browser-p1", &png, None).status(), StatusCode::FORBIDDEN);
        assert_eq!(get("main", &dir.join("secret.txt").to_string_lossy(), None).status(), StatusCode::FORBIDDEN);
        assert_eq!(get("main", &dir.join("gone.png").to_string_lossy(), None).status(), StatusCode::NOT_FOUND);
        assert_eq!(get("main", "relative.png", None).status(), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
