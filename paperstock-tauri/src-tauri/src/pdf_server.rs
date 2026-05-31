use std::{
    collections::HashMap,
    fs::File,
    io::{copy, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct PdfServer {
    port: u16,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
    counter: AtomicU64,
}

impl PdfServer {
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let files = Arc::new(Mutex::new(HashMap::new()));
        let server_files = Arc::clone(&files);

        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let files = Arc::clone(&server_files);
                thread::spawn(move || handle_connection(stream, files));
            }
        });

        Ok(Self {
            port,
            files,
            counter: AtomicU64::new(1),
        })
    }

    pub fn register(&self, file_path: String) -> Result<String, String> {
        let path = PathBuf::from(&file_path);
        if !path.is_file() {
            return Err("PDFファイルが見つかりません".to_string());
        }

        let token = self.next_token();
        self.files
            .lock()
            .map_err(|_| "PDFサーバ状態をロックできませんでした".to_string())?
            .insert(token.clone(), path);

        Ok(format!("http://127.0.0.1:{}/pdf/{}", self.port, token))
    }

    fn next_token(&self) -> String {
        let seq = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        format!("{nanos:x}-{seq:x}")
    }
}

fn handle_connection(mut stream: TcpStream, files: Arc<Mutex<HashMap<String, PathBuf>>>) {
    let mut buf = [0_u8; 8192];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    if n == 0 {
        return;
    }

    let request = String::from_utf8_lossy(&buf[..n]);
    let mut lines = request.lines();
    let Some(request_line) = lines.next() else {
        write_status(&mut stream, 400, "Bad Request");
        return;
    };

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method == "OPTIONS" {
        write_options(&mut stream);
        return;
    }
    if method != "GET" && method != "HEAD" {
        write_status(&mut stream, 405, "Method Not Allowed");
        return;
    }

    let Some(token) = target.strip_prefix("/pdf/") else {
        write_status(&mut stream, 404, "Not Found");
        return;
    };
    let token = token.split('?').next().unwrap_or("");

    let range_header = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("range") {
            Some(value.trim().to_string())
        } else {
            None
        }
    });

    let path = match files.lock().ok().and_then(|m| m.get(token).cloned()) {
        Some(path) => path,
        None => {
            write_status(&mut stream, 404, "Not Found");
            return;
        }
    };

    if let Err(_e) = serve_file(
        &mut stream,
        &path,
        method == "HEAD",
        range_header.as_deref(),
    ) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

fn serve_file(
    stream: &mut TcpStream,
    path: &Path,
    head_only: bool,
    range_header: Option<&str>,
) -> std::io::Result<()> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        write_headers(stream, 200, "OK", 0, None, file_len)?;
        return Ok(());
    }

    let range = range_header.and_then(|h| parse_range(h, file_len));
    let (status, reason, start, end) = match range {
        Some((start, end)) => (206, "Partial Content", start, end),
        None => (200, "OK", 0, file_len - 1),
    };
    let body_len = end - start + 1;
    let content_range = (status == 206).then_some((start, end));

    write_headers(stream, status, reason, body_len, content_range, file_len)?;
    if head_only {
        return Ok(());
    }

    file.seek(SeekFrom::Start(start))?;
    let mut limited = file.take(body_len);
    copy(&mut limited, stream)?;
    Ok(())
}

fn parse_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (start_raw, end_raw) = spec.split_once('-')?;

    if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().ok()?.min(file_len);
        return Some((file_len - suffix_len, file_len - 1));
    }

    let start = start_raw.parse::<u64>().ok()?;
    if start >= file_len {
        return None;
    }

    let end = if end_raw.is_empty() {
        file_len - 1
    } else {
        end_raw.parse::<u64>().ok()?.min(file_len - 1)
    };
    if end < start {
        return None;
    }

    Some((start, end))
}

fn write_status(stream: &mut TcpStream, status: u16, reason: &str) {
    let body = reason.as_bytes();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(body);
}

fn write_options(stream: &mut TcpStream) {
    let _ = write!(
        stream,
        "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Max-Age: 86400\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
}

fn write_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_len: u64,
    content_range: Option<(u64, u64)>,
    file_len: u64,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/pdf\r\nAccept-Ranges: bytes\r\nContent-Length: {content_len}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\nConnection: close\r\n"
    )?;
    if let Some((start, end)) = content_range {
        write!(stream, "Content-Range: bytes {start}-{end}/{file_len}\r\n")?;
    }
    write!(stream, "\r\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read, net::TcpStream, time::Duration};

    #[test]
    fn serves_byte_ranges_without_loading_whole_file() {
        let path = std::env::temp_dir().join(format!(
            "paperstock_pdf_server_test_{}.pdf",
            std::process::id()
        ));
        fs::write(&path, b"%PDF-1.7\n0123456789abcdef\n%%EOF").unwrap();

        let server = PdfServer::start().unwrap();
        let url = server.register(path.to_string_lossy().to_string()).unwrap();
        let port = url
            .split(':')
            .nth(2)
            .and_then(|s| s.split('/').next())
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap();
        let token = url.rsplit('/').next().unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "GET /pdf/{token} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=5-9\r\n\r\n"
        )
        .unwrap();

        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();

        assert!(response.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(response.contains("Accept-Ranges: bytes"));
        assert!(response.contains(
            "Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range"
        ));
        assert!(response.contains("Content-Range: bytes 5-9/"));
        assert!(response.ends_with("1.7\n0"));

        let _ = fs::remove_file(path);
    }
}
