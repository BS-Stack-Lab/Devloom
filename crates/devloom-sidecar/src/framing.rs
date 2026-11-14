use std::io::{self, Read, Write};
pub const MAX_BODY: usize = 65536;
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<serde_json::Value>> {
    let mut header = Vec::new();
    loop {
        let mut byte = [0];
        match reader.read(&mut byte)? {
            0 if header.is_empty() => return Ok(None),
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            _ => header.push(byte[0]),
        }
        if header.len() > 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header = std::str::from_utf8(&header).map_err(|_| io::ErrorKind::InvalidData)?;
    let digits = header
        .strip_prefix("Content-Length: ")
        .and_then(|s| s.strip_suffix("\r\n\r\n"))
        .ok_or(io::ErrorKind::InvalidData)?;
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
    {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let length: usize = digits.parse().map_err(|_| io::ErrorKind::InvalidData)?;
    if length == 0 || length > MAX_BODY {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let text = std::str::from_utf8(&body).map_err(|_| io::ErrorKind::InvalidData)?;
    serde_json::from_str(text)
        .map(Some)
        .map_err(|_| io::ErrorKind::InvalidData.into())
}
pub fn write_frame(writer: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_boundaries() {
        let value = serde_json::json!({"text":"한글 👨‍👩‍👧‍👦 é\n"});
        let mut wire = Vec::new();
        write_frame(&mut wire, &value).unwrap();
        assert_eq!(read_frame(&mut wire.as_slice()).unwrap(), Some(value));
        for bad in [
            b"Content-Length: 65537\r\n\r\n".as_slice(),
            b"Content-Length: -1\r\n\r\n",
            b"Content-Length: 2\r\n\r\n{",
        ] {
            assert!(read_frame(&mut &*bad).is_err());
        }
    }
}
