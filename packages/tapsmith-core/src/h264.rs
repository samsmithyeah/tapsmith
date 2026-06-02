//! Minimal H.264 Annex-B helpers for the screen video stream: split a byte
//! stream into NAL units and group them into access units with keyframe/config
//! flags. Not a full parser — just enough to frame the stream for WebCodecs.

/// nal_unit_type of an Annex-B NAL unit *including* its start code.
#[allow(dead_code)]
pub fn nal_type(nal_with_start: &[u8]) -> u8 {
    let body = strip_start_code(nal_with_start);
    body.first().map(|b| b & 0x1F).unwrap_or(0)
}

#[allow(dead_code)]
fn strip_start_code(b: &[u8]) -> &[u8] {
    if b.starts_with(&[0, 0, 0, 1]) {
        &b[4..]
    } else if b.starts_with(&[0, 0, 1]) {
        &b[3..]
    } else {
        b
    }
}

/// Split an Annex-B buffer into NAL units, each slice including its start code.
#[allow(dead_code)]
pub fn split_nal_units(buf: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 {
            let s = if i > 0 && buf[i - 1] == 0 { i - 1 } else { i };
            starts.push(s);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (idx, &s) in starts.iter().enumerate() {
        let end = starts.get(idx + 1).copied().unwrap_or(buf.len());
        out.push(&buf[s..end]);
    }
    out
}

/// Incremental Annex-B → access-unit assembler. Flushes an access unit when a
/// new VCL slice (type 1/5) begins after the current AU already contains one.
#[allow(dead_code)]
pub struct Parser {
    buf: Vec<u8>,
}

impl Parser {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Feed bytes; return any access units completed by this push.
    #[allow(dead_code)]
    pub fn push(&mut self, bytes: &[u8]) -> Vec<AccessUnit> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let nals = split_nal_units(&self.buf);
            if nals.len() < 2 {
                break;
            }
            let mut seen_vcl = false;
            let mut flush_at: Option<usize> = None;
            let mut offset = 0;
            for nal in &nals {
                let t = nal_type(nal);
                let is_vcl = t == 1 || t == 5;
                if is_vcl && seen_vcl {
                    flush_at = Some(offset);
                    break;
                }
                if is_vcl {
                    seen_vcl = true;
                }
                offset += nal.len();
            }
            match flush_at {
                Some(at) => {
                    let au_bytes = self.buf[..at].to_vec();
                    out.push(Self::make_au(&au_bytes));
                    self.buf.drain(..at);
                }
                None => break,
            }
        }
        out
    }

    #[allow(dead_code)]
    fn make_au(bytes: &[u8]) -> AccessUnit {
        let mut keyframe = false;
        let mut config = false;
        for nal in split_nal_units(bytes) {
            match nal_type(nal) {
                5 => keyframe = true,
                7 | 8 => config = true,
                _ => {}
            }
        }
        AccessUnit {
            data: bytes.to_vec(),
            keyframe,
            config,
        }
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

/// A coalesced H.264 access unit ready to forward to the client.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub struct AccessUnit {
    /// Annex-B bytes (start codes + NAL units) for this access unit.
    pub data: Vec<u8>,
    /// Contains an IDR slice (type 5) → keyframe.
    pub keyframe: bool,
    /// Contains SPS (7) or PPS (8) → decoder config.
    pub config: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nal(start4: bool, ntype: u8, body: &[u8]) -> Vec<u8> {
        let mut v = if start4 {
            vec![0, 0, 0, 1]
        } else {
            vec![0, 0, 1]
        };
        v.push(ntype & 0x1F);
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn splits_nal_units_by_start_code() {
        let mut buf = nal(true, 7, &[1, 2]);
        buf.extend(nal(false, 8, &[3]));
        buf.extend(nal(true, 5, &[4, 5]));
        let nals = split_nal_units(&buf);
        assert_eq!(nals.len(), 3);
        assert_eq!(nal_type(nals[0]), 7);
        assert_eq!(nal_type(nals[1]), 8);
        assert_eq!(nal_type(nals[2]), 5);
    }

    #[test]
    fn assembles_config_plus_idr_into_keyframe_access_unit() {
        let mut p = Parser::new();
        let mut buf = nal(true, 7, &[1]);
        buf.extend(nal(true, 8, &[2]));
        buf.extend(nal(true, 5, &[3]));
        let mut aus = p.push(&buf);
        aus.extend(p.push(&nal(true, 1, &[9]))); // next AU boundary flushes the first
        assert_eq!(aus.len(), 1);
        assert!(aus[0].keyframe);
        assert!(aus[0].config);
    }

    #[test]
    fn non_idr_access_unit_is_not_keyframe() {
        let mut p = Parser::new();
        let mut aus = p.push(&nal(true, 1, &[1]));
        aus.extend(p.push(&nal(true, 1, &[2])));
        assert_eq!(aus.len(), 1);
        assert!(!aus[0].keyframe);
        assert!(!aus[0].config);
    }
}
