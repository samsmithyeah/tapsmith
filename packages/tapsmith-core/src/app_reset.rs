//! App reset ladder — the daemon side of Tapsmith's declared isolation policy.
//!
//! The SDK asks for a reset *mode* (`warm` / `restart` / `clear`) and whether
//! escalation is allowed; this module owns the pure decisions around it:
//!
//! * **Hooks marker** — how an app advertises an in-app reset hook
//!   (`@tapsmith/react-native`) through its accessibility tree, and how the
//!   daemon acknowledges a warm reset by watching the marker's epoch advance.
//! * **Cold policy** — when a warm reset on an iOS simulator must instead be
//!   delivered cold (terminate + relaunch): retries, a streak of failed warm
//!   verifications, or the bounded warm window (PILOT-249).
//! * **The ladder** — `warm → restart → clear`, run through a [`ResetOps`]
//!   trait so the sequencing is unit-tested against a mock while the real
//!   device work lives in `grpc_server.rs`.
//!
//! Wire format the in-app module implements (framework-agnostic):
//!
//! ```text
//! marker (always-present a11y text): tapsmith-hooks:<version>;epoch=<n>;url=<prefix>[;err=<urlencoded>]
//! request (deep link):               <prefix><target>?__tapsmith_reset=1&nonce=<opaque>
//! ack:                               marker epoch strictly greater than the pre-request value
//! ```

use std::time::Instant;

use async_trait::async_trait;

pub const HOOKS_MARKER_PREFIX: &str = "tapsmith-hooks:";
pub const RESET_QUERY_FLAG: &str = "__tapsmith_reset=1";

/// Parsed `@tapsmith/react-native` marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HooksMarker {
    pub version: u32,
    pub epoch: u64,
    /// URL prefix the module built its reset link from (e.g. `myapp://`,
    /// `exp://192.168.1.2:8081/--/`). Empty when the module could not
    /// determine a scheme — the daemon then falls back to other steps.
    pub url_prefix: String,
    /// Error reported by the last in-app reset, if it failed.
    pub err: Option<String>,
    /// Random per-process token. The epoch counter restarts at 0 when the app
    /// is relaunched, so a changed `boot` is how a cold-delivered reset is
    /// recognised as acknowledged (see [`hooks_acknowledged`]). `None` for
    /// modules that predate the field.
    pub boot: Option<String>,
}

/// Find and parse the hooks marker in a UI hierarchy dump (Android
/// `text="…"`, iOS `label="…"` / `name="…"` / `value="…"`). The marker may be
/// XML-escaped; `&amp;` etc. are decoded before parsing.
pub fn parse_hooks_marker(hierarchy_xml: &str) -> Option<HooksMarker> {
    let start = hierarchy_xml.find(HOOKS_MARKER_PREFIX)?;
    let rest = &hierarchy_xml[start + HOOKS_MARKER_PREFIX.len()..];
    // The marker ends at the closing quote of the attribute it lives in.
    let end = rest.find(['"', '\'', '<', '\n']).unwrap_or(rest.len());
    let raw = xml_unescape(&rest[..end]);

    let mut fields = raw.split(';');
    let version: u32 = fields.next()?.trim().parse().ok()?;
    let mut epoch: Option<u64> = None;
    let mut url_prefix = String::new();
    let mut err: Option<String> = None;
    let mut boot: Option<String> = None;
    for field in fields {
        let Some((k, v)) = field.split_once('=') else {
            continue;
        };
        match k.trim() {
            "epoch" => epoch = v.trim().parse().ok(),
            "url" => url_prefix = v.trim().to_string(),
            "boot" => {
                let b = v.trim();
                if !b.is_empty() {
                    boot = Some(b.to_string());
                }
            }
            "err" => {
                let decoded = percent_decode(v.trim());
                if !decoded.is_empty() {
                    err = Some(decoded);
                }
            }
            _ => {}
        }
    }
    Some(HooksMarker {
        version,
        epoch: epoch?,
        url_prefix,
        err,
        boot,
    })
}

/// Whether the marker read *after* a reset request acknowledges it.
///
/// Normally the ack is the epoch advancing past the value read before the
/// request. A cold delivery relaunches the app, which restarts the in-memory
/// counter at 0 — so when the marker's per-process `boot` token differs from
/// the one read before, any epoch ≥ 1 (the fresh process handled its launch
/// URL) is the acknowledgement. Without boot tokens on both sides, fall back
/// to the strict comparison.
pub fn hooks_acknowledged(
    epoch_before: u64,
    boot_before: Option<&str>,
    after: &HooksMarker,
) -> bool {
    match (boot_before, after.boot.as_deref()) {
        (Some(b), Some(a)) if a != b => after.epoch >= 1,
        _ => after.epoch > epoch_before,
    }
}

/// `<prefix><target>?__tapsmith_reset=1&nonce=<nonce>`.
///
/// The module publishes a prefix that already ends in `/` (`myapp:///`,
/// `exp://host:8081/--/`) so the daemon only has to append the route; a
/// prefix without one gets a single `/` added. `target_path`'s own leading
/// slash is dropped so it never doubles.
pub fn build_reset_url(prefix: &str, target_path: &str, nonce: &str) -> String {
    let base = if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    };
    let target = target_path.trim().trim_start_matches('/');
    let (path, existing_query) = match target.split_once('?') {
        Some((p, q)) if !q.is_empty() => (p, Some(q)),
        Some((p, _)) => (p, None),
        None => (target, None),
    };
    let sep_query = match existing_query {
        Some(q) => format!("{q}&"),
        None => String::new(),
    };
    format!("{base}{path}?{sep_query}{RESET_QUERY_FLAG}&nonce={nonce}")
}

fn xml_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ─── Cold policy ───

/// Per-session counters behind the warm/cold decision. Reset whenever the
/// active device or agent session changes.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResetPolicyState {
    /// Warm resets delivered since the last cold relaunch / restart / clear.
    pub warm_resets_since_cold: u32,
    /// Warm resets in a row whose verification failed.
    pub consecutive_warm_failures: u32,
}

/// Why a reset that could have been warm is being delivered cold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColdReason {
    RetryAttempt,
    WarmFailureStreak(u32),
    WarmWindowBound(u32),
}

impl ColdReason {
    pub fn describe(&self) -> String {
        match self {
            ColdReason::RetryAttempt => "cold relaunch: retry attempt".to_string(),
            ColdReason::WarmFailureStreak(n) => {
                format!("cold relaunch: {n} consecutive warm resets failed verification")
            }
            ColdReason::WarmWindowBound(n) => {
                format!("cold relaunch: warm-window bound reached ({n} resets)")
            }
        }
    }
}

pub const WARM_FAILURE_STREAK_LIMIT: u32 = 2;

impl ResetPolicyState {
    /// Decide whether the next warm reset must be delivered cold.
    pub fn cold_reason(&self, force_cold: bool, cold_every_n: u32) -> Option<ColdReason> {
        if force_cold {
            return Some(ColdReason::RetryAttempt);
        }
        if self.consecutive_warm_failures >= WARM_FAILURE_STREAK_LIMIT {
            return Some(ColdReason::WarmFailureStreak(
                self.consecutive_warm_failures,
            ));
        }
        if cold_every_n > 0 && self.warm_resets_since_cold >= cold_every_n {
            return Some(ColdReason::WarmWindowBound(cold_every_n));
        }
        None
    }

    /// Fold a completed reset back into the counters.
    pub fn record(&mut self, outcome: &ResetOutcome) {
        if outcome.cold_launch {
            // Any restart / clear / cold delivery starts a fresh warm window.
            self.warm_resets_since_cold = 0;
            self.consecutive_warm_failures = 0;
            return;
        }
        match outcome.mode_used {
            ResetMode::Warm => {
                self.warm_resets_since_cold += 1;
                self.consecutive_warm_failures = 0;
            }
            _ => {
                self.warm_resets_since_cold = 0;
                self.consecutive_warm_failures = 0;
            }
        }
    }

    /// A warm attempt failed verification (whether or not the ladder then
    /// recovered with a restart/clear — that recovery resets the counters via
    /// [`Self::record`], so callers record the failure first).
    pub fn record_warm_failure(&mut self) {
        self.consecutive_warm_failures += 1;
    }
}

// ─── Plan & ladder ───

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    Warm,
    Restart,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirstStep {
    /// Warm reset through the in-app hooks (`marker` present).
    WarmHooks {
        cold: Option<ColdReason>,
    },
    /// Warm reset through an explicit legacy `resetAppDeepLink`.
    WarmDeepLink {
        link: String,
        cold: Option<ColdReason>,
    },
    Restart,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetPlan {
    pub first: FirstStep,
    /// Explanation attached when the requested mode could not be honoured
    /// as asked (e.g. warm requested, no hook available).
    pub reason: Option<String>,
}

/// Inputs the daemon has when planning a reset.
pub struct PlanInput<'a> {
    pub mode: ResetMode,
    pub marker: Option<&'a HooksMarker>,
    pub reset_deep_link: &'a str,
    pub force_cold: bool,
    pub cold_every_n: u32,
    /// Cold delivery is only a distinct concept on iOS simulators. Elsewhere a
    /// "cold" decision maps to a restart step so the bounded warm window
    /// still exists on every platform.
    pub supports_cold_delivery: bool,
}

pub fn decide(state: &ResetPolicyState, input: &PlanInput<'_>) -> ResetPlan {
    match input.mode {
        ResetMode::Restart => ResetPlan {
            first: FirstStep::Restart,
            reason: None,
        },
        ResetMode::Clear => ResetPlan {
            first: FirstStep::Clear,
            reason: None,
        },
        ResetMode::Warm => {
            let cold = state.cold_reason(input.force_cold, input.cold_every_n);
            let hook_available = input
                .marker
                .map(|m| !m.url_prefix.is_empty())
                .unwrap_or(false)
                || !input.reset_deep_link.is_empty();
            if !hook_available {
                return ResetPlan {
                    first: FirstStep::Restart,
                    reason: Some(
                        "warm reset requested but the app exposes no reset hook \
                         (@tapsmith/react-native or resetAppDeepLink); restarted instead"
                            .to_string(),
                    ),
                };
            }
            if let (Some(reason), false) = (&cold, input.supports_cold_delivery) {
                // No cold delivery on this platform: honour the bound with a restart.
                return ResetPlan {
                    first: FirstStep::Restart,
                    reason: Some(reason.describe()),
                };
            }
            if input
                .marker
                .map(|m| !m.url_prefix.is_empty())
                .unwrap_or(false)
            {
                ResetPlan {
                    first: FirstStep::WarmHooks { cold: cold.clone() },
                    reason: cold.map(|c| c.describe()),
                }
            } else {
                ResetPlan {
                    first: FirstStep::WarmDeepLink {
                        link: input.reset_deep_link.to_string(),
                        cold: cold.clone(),
                    },
                    reason: cold.map(|c| c.describe()),
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetStep {
    pub name: String,
    pub duration_ms: u64,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetOutcome {
    pub mode_used: ResetMode,
    pub fell_back: bool,
    /// The app process was recreated (cold deep-link delivery, restart, clear).
    pub cold_launch: bool,
    pub reason: Option<String>,
    pub steps: Vec<ResetStep>,
    pub epoch_after: Option<u64>,
    /// Set when every step failed; the ladder is exhausted.
    pub error: Option<String>,
}

/// Device work the ladder sequences. Each method performs one step and
/// returns a short human detail on success or the failure message.
#[async_trait]
pub trait ResetOps {
    /// Deliver the hooks reset link; resolve with the epoch observed after the ack.
    async fn warm_hooks(&self, cold: bool) -> Result<u64, String>;
    /// Deliver the legacy reset deep link.
    async fn warm_deep_link(&self, link: &str, cold: bool) -> Result<(), String>;
    async fn restart(&self) -> Result<(), String>;
    async fn clear(&self) -> Result<(), String>;
}

pub async fn run_ladder(
    ops: &(impl ResetOps + Sync),
    plan: ResetPlan,
    allow_fallback: bool,
) -> ResetOutcome {
    let mut steps: Vec<ResetStep> = Vec::new();
    let mut reasons: Vec<String> = plan.reason.into_iter().collect();
    let mut fell_back = false;

    async fn timed<T>(
        steps: &mut Vec<ResetStep>,
        name: &str,
        fut: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let t0 = Instant::now();
        let res = fut.await;
        steps.push(ResetStep {
            name: name.to_string(),
            duration_ms: t0.elapsed().as_millis() as u64,
            ok: res.is_ok(),
            detail: res.as_ref().err().cloned().unwrap_or_default(),
        });
        res
    }

    // Step 1 — warm.
    let mut next = match plan.first {
        FirstStep::WarmHooks { cold } => {
            let is_cold = cold.is_some();
            match timed(&mut steps, "warm-hooks", ops.warm_hooks(is_cold)).await {
                Ok(epoch) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Warm,
                        fell_back: false,
                        cold_launch: is_cold,
                        reason: join(&reasons),
                        steps,
                        epoch_after: Some(epoch),
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("warm reset via in-app hooks failed ({e})"));
                    Some(ResetMode::Restart)
                }
            }
        }
        FirstStep::WarmDeepLink { link, cold } => {
            let is_cold = cold.is_some();
            match timed(
                &mut steps,
                "warm-deep-link",
                ops.warm_deep_link(&link, is_cold),
            )
            .await
            {
                Ok(()) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Warm,
                        fell_back: false,
                        cold_launch: is_cold,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("warm reset via resetAppDeepLink failed ({e})"));
                    Some(ResetMode::Restart)
                }
            }
        }
        FirstStep::Restart => Some(ResetMode::Restart),
        FirstStep::Clear => Some(ResetMode::Clear),
    };
    // A warm first step that fell through is a fallback only if allowed.
    let warm_failed = matches!(steps.first(), Some(s) if !s.ok);
    if warm_failed {
        if !allow_fallback {
            return ResetOutcome {
                mode_used: ResetMode::Warm,
                fell_back: false,
                cold_launch: false,
                reason: join(&reasons),
                steps,
                epoch_after: None,
                error: Some("warm reset failed and fallback is disabled".to_string()),
            };
        }
        fell_back = true;
    }

    // Steps 2/3 — restart, then clear.
    while let Some(mode) = next {
        match mode {
            ResetMode::Restart => match timed(&mut steps, "restart", ops.restart()).await {
                Ok(()) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Restart,
                        fell_back,
                        cold_launch: true,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("restart failed ({e})"));
                    if !allow_fallback {
                        return ResetOutcome {
                            mode_used: ResetMode::Restart,
                            fell_back,
                            cold_launch: false,
                            reason: join(&reasons),
                            steps,
                            epoch_after: None,
                            error: Some(e),
                        };
                    }
                    fell_back = true;
                    next = Some(ResetMode::Clear);
                }
            },
            ResetMode::Clear => match timed(&mut steps, "clear", ops.clear()).await {
                Ok(()) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Clear,
                        fell_back,
                        cold_launch: true,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("clear failed ({e})"));
                    return ResetOutcome {
                        mode_used: ResetMode::Clear,
                        fell_back,
                        cold_launch: false,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: Some(e),
                    };
                }
            },
            ResetMode::Warm => unreachable!("warm is only ever the first step"),
        }
    }
    unreachable!("ladder always returns from a step")
}

fn join(reasons: &[String]) -> Option<String> {
    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // ── marker ──

    #[test]
    fn parses_android_text_marker() {
        let xml = r#"<node text="tapsmith-hooks:1;epoch=4;url=myapp://" class="android.widget.TextView"/>"#;
        assert_eq!(
            parse_hooks_marker(xml),
            Some(HooksMarker {
                version: 1,
                epoch: 4,
                url_prefix: "myapp://".into(),
                err: None,
                boot: None,
            })
        );
    }

    #[test]
    fn parses_ios_label_marker_with_escaped_ampersand_and_err() {
        let xml = r#"<XCUIElementTypeStaticText label="tapsmith-hooks:1;epoch=7;url=exp://192.168.1.2:8081/--/;err=AsyncStorage%20failed%3A%20boom&amp;x" />"#;
        let m = parse_hooks_marker(xml).unwrap();
        assert_eq!(m.epoch, 7);
        assert_eq!(m.url_prefix, "exp://192.168.1.2:8081/--/");
        assert_eq!(m.err.as_deref(), Some("AsyncStorage failed: boom&x"));
    }

    #[test]
    fn marker_absent_or_malformed_is_none() {
        assert_eq!(parse_hooks_marker("<node text=\"hello\"/>"), None);
        assert_eq!(
            parse_hooks_marker("<node text=\"tapsmith-hooks:1;url=x\"/>"),
            None
        );
        assert_eq!(
            parse_hooks_marker("<node text=\"tapsmith-hooks:abc;epoch=1\"/>"),
            None
        );
    }

    #[test]
    fn marker_with_empty_url_parses_but_has_no_prefix() {
        let m = parse_hooks_marker("<node text=\"tapsmith-hooks:1;epoch=0;url=\"/>").unwrap();
        assert_eq!(m.url_prefix, "");
        assert_eq!(m.err, None);
    }

    #[test]
    fn builds_reset_urls_for_scheme_and_expo_prefixes() {
        assert_eq!(
            build_reset_url("myapp:///", "/", "n1"),
            "myapp:///?__tapsmith_reset=1&nonce=n1"
        );
        assert_eq!(
            build_reset_url("myapp:///", "/login", "n2"),
            "myapp:///login?__tapsmith_reset=1&nonce=n2"
        );
        assert_eq!(
            build_reset_url("myapp://", "login", "n2b"),
            "myapp://login?__tapsmith_reset=1&nonce=n2b"
        );
        assert_eq!(
            build_reset_url("exp://10.0.0.5:8081/--/", "settings?tab=2", "n3"),
            "exp://10.0.0.5:8081/--/settings?tab=2&__tapsmith_reset=1&nonce=n3"
        );
        assert_eq!(
            build_reset_url("myapp:///", "", "n4"),
            "myapp:///?__tapsmith_reset=1&nonce=n4"
        );
    }

    // ── policy ──

    #[test]
    fn parses_boot_token() {
        let m = parse_hooks_marker(
            r#"<node text="tapsmith-hooks:1;epoch=3;boot=a1b2c3d4;url=app:///" />"#,
        )
        .unwrap();
        assert_eq!(m.epoch, 3);
        assert_eq!(m.boot.as_deref(), Some("a1b2c3d4"));
        let legacy =
            parse_hooks_marker(r#"<node text="tapsmith-hooks:1;epoch=3;url=app:///" />"#).unwrap();
        assert_eq!(legacy.boot, None);
    }

    #[test]
    fn ack_rule_handles_relaunch() {
        let after = |epoch: u64, boot: Option<&str>| HooksMarker {
            version: 1,
            epoch,
            url_prefix: "app:///".into(),
            err: None,
            boot: boot.map(str::to_string),
        };
        // Same process: epoch must advance.
        assert!(hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(11, Some("aaaa"))
        ));
        assert!(!hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(10, Some("aaaa"))
        ));
        // Relaunched process: counter restarted, any epoch ≥ 1 acks.
        assert!(hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(1, Some("bbbb"))
        ));
        assert!(!hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(0, Some("bbbb"))
        ));
        // Retry-forced cold after a single warm reset: 1 → 1 is still an ack.
        assert!(hooks_acknowledged(1, Some("aaaa"), &after(1, Some("bbbb"))));
        // Legacy markers without boot fall back to the strict rule.
        assert!(!hooks_acknowledged(10, None, &after(1, None)));
        assert!(hooks_acknowledged(10, None, &after(11, None)));
    }

    fn marker() -> HooksMarker {
        HooksMarker {
            version: 1,
            epoch: 3,
            url_prefix: "app://".into(),
            err: None,
            boot: None,
        }
    }

    fn input<'a>(mode: ResetMode, marker: Option<&'a HooksMarker>, link: &'a str) -> PlanInput<'a> {
        PlanInput {
            mode,
            marker,
            reset_deep_link: link,
            force_cold: false,
            cold_every_n: 10,
            supports_cold_delivery: true,
        }
    }

    #[test]
    fn warm_with_hooks_stays_warm_by_default() {
        let m = marker();
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, Some(&m), ""),
        );
        assert_eq!(plan.first, FirstStep::WarmHooks { cold: None });
        assert_eq!(plan.reason, None);
    }

    #[test]
    fn warm_without_any_hook_restarts_and_explains() {
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, None, ""),
        );
        assert_eq!(plan.first, FirstStep::Restart);
        assert!(plan.reason.unwrap().contains("no reset hook"));
    }

    #[test]
    fn warm_prefers_hooks_over_legacy_link_and_falls_back_to_link() {
        let m = marker();
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, Some(&m), "app:///__reset"),
        );
        assert!(matches!(plan.first, FirstStep::WarmHooks { .. }));
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, None, "app:///__reset"),
        );
        assert_eq!(
            plan.first,
            FirstStep::WarmDeepLink {
                link: "app:///__reset".into(),
                cold: None
            }
        );
    }

    #[test]
    fn cold_triggers_retry_streak_and_window() {
        let m = marker();
        let mut i = input(ResetMode::Warm, Some(&m), "");
        i.force_cold = true;
        let plan = decide(&ResetPolicyState::default(), &i);
        assert_eq!(
            plan.first,
            FirstStep::WarmHooks {
                cold: Some(ColdReason::RetryAttempt)
            }
        );
        assert_eq!(plan.reason.as_deref(), Some("cold relaunch: retry attempt"));

        let streak = ResetPolicyState {
            warm_resets_since_cold: 1,
            consecutive_warm_failures: 2,
        };
        let plan = decide(&streak, &input(ResetMode::Warm, Some(&m), ""));
        assert_eq!(
            plan.first,
            FirstStep::WarmHooks {
                cold: Some(ColdReason::WarmFailureStreak(2))
            }
        );

        let bound = ResetPolicyState {
            warm_resets_since_cold: 10,
            consecutive_warm_failures: 0,
        };
        let plan = decide(&bound, &input(ResetMode::Warm, Some(&m), ""));
        assert_eq!(
            plan.reason.as_deref(),
            Some("cold relaunch: warm-window bound reached (10 resets)")
        );
        let mut off = input(ResetMode::Warm, Some(&m), "");
        off.cold_every_n = 0;
        assert_eq!(
            decide(&bound, &off).first,
            FirstStep::WarmHooks { cold: None }
        );
    }

    #[test]
    fn cold_without_cold_delivery_maps_to_restart() {
        let m = marker();
        let mut i = input(ResetMode::Warm, Some(&m), "");
        i.force_cold = true;
        i.supports_cold_delivery = false;
        let plan = decide(&ResetPolicyState::default(), &i);
        assert_eq!(plan.first, FirstStep::Restart);
        assert_eq!(plan.reason.as_deref(), Some("cold relaunch: retry attempt"));
    }

    #[test]
    fn explicit_restart_and_clear_ignore_hooks() {
        let m = marker();
        assert_eq!(
            decide(
                &ResetPolicyState::default(),
                &input(ResetMode::Restart, Some(&m), "")
            )
            .first,
            FirstStep::Restart
        );
        assert_eq!(
            decide(
                &ResetPolicyState::default(),
                &input(ResetMode::Clear, Some(&m), "")
            )
            .first,
            FirstStep::Clear
        );
    }

    #[test]
    fn state_records_outcomes() {
        let mut s = ResetPolicyState::default();
        let warm = ResetOutcome {
            mode_used: ResetMode::Warm,
            fell_back: false,
            cold_launch: false,
            reason: None,
            steps: vec![],
            epoch_after: Some(1),
            error: None,
        };
        s.record(&warm);
        s.record(&warm);
        assert_eq!(s.warm_resets_since_cold, 2);
        s.record_warm_failure();
        assert_eq!(s.consecutive_warm_failures, 1);
        let cold = ResetOutcome {
            cold_launch: true,
            mode_used: ResetMode::Warm,
            ..warm.clone()
        };
        s.record(&cold);
        assert_eq!(s, ResetPolicyState::default());
    }

    // ── ladder ──

    struct MockOps {
        warm: Result<u64, String>,
        link: Result<(), String>,
        restart: Result<(), String>,
        clear: Result<(), String>,
        calls: Mutex<Vec<String>>,
    }

    impl MockOps {
        fn new() -> Self {
            Self {
                warm: Ok(5),
                link: Ok(()),
                restart: Ok(()),
                clear: Ok(()),
                calls: Mutex::new(vec![]),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ResetOps for MockOps {
        async fn warm_hooks(&self, cold: bool) -> Result<u64, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("warm_hooks(cold={cold})"));
            self.warm.clone()
        }
        async fn warm_deep_link(&self, link: &str, cold: bool) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("warm_deep_link({link},cold={cold})"));
            self.link.clone()
        }
        async fn restart(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("restart".into());
            self.restart.clone()
        }
        async fn clear(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("clear".into());
            self.clear.clone()
        }
    }

    fn plan(first: FirstStep) -> ResetPlan {
        ResetPlan {
            first,
            reason: None,
        }
    }

    #[tokio::test]
    async fn warm_hooks_success_is_terminal() {
        let ops = MockOps::new();
        let out = run_ladder(&ops, plan(FirstStep::WarmHooks { cold: None }), true).await;
        assert_eq!(out.mode_used, ResetMode::Warm);
        assert!(!out.fell_back && !out.cold_launch && out.error.is_none());
        assert_eq!(out.epoch_after, Some(5));
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=false)"]);
        assert_eq!(out.steps.len(), 1);
        assert!(out.steps[0].ok);
    }

    #[tokio::test]
    async fn cold_warm_delivery_counts_as_cold_launch() {
        let ops = MockOps::new();
        let out = run_ladder(
            &ops,
            ResetPlan {
                first: FirstStep::WarmHooks {
                    cold: Some(ColdReason::RetryAttempt),
                },
                reason: Some("cold relaunch: retry attempt".into()),
            },
            true,
        )
        .await;
        assert!(out.cold_launch);
        assert_eq!(out.reason.as_deref(), Some("cold relaunch: retry attempt"));
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=true)"]);
    }

    #[tokio::test]
    async fn warm_failure_falls_back_to_restart_with_reason() {
        let mut ops = MockOps::new();
        ops.warm = Err("epoch did not advance within 3000ms".into());
        let out = run_ladder(&ops, plan(FirstStep::WarmHooks { cold: None }), true).await;
        assert_eq!(out.mode_used, ResetMode::Restart);
        assert!(out.fell_back && out.cold_launch && out.error.is_none());
        assert_eq!(
            out.reason.as_deref(),
            Some("warm reset via in-app hooks failed (epoch did not advance within 3000ms)")
        );
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=false)", "restart"]);
        assert_eq!(
            out.steps
                .iter()
                .map(|s| (s.name.as_str(), s.ok))
                .collect::<Vec<_>>(),
            vec![("warm-hooks", false), ("restart", true)]
        );
    }

    #[tokio::test]
    async fn warm_failure_without_fallback_is_an_error() {
        let mut ops = MockOps::new();
        ops.link = Err("no ui change".into());
        let out = run_ladder(
            &ops,
            plan(FirstStep::WarmDeepLink {
                link: "app:///__reset".into(),
                cold: None,
            }),
            false,
        )
        .await;
        assert!(out.error.is_some());
        assert_eq!(
            ops.calls(),
            vec!["warm_deep_link(app:///__reset,cold=false)"]
        );
    }

    #[tokio::test]
    async fn restart_failure_escalates_to_clear_then_exhausts() {
        let mut ops = MockOps::new();
        ops.restart = Err("launch failed".into());
        let out = run_ladder(&ops, plan(FirstStep::Restart), true).await;
        assert_eq!(out.mode_used, ResetMode::Clear);
        assert!(out.fell_back && out.cold_launch && out.error.is_none());
        assert_eq!(ops.calls(), vec!["restart", "clear"]);

        let mut ops = MockOps::new();
        ops.restart = Err("launch failed".into());
        ops.clear = Err("pm clear failed".into());
        let out = run_ladder(&ops, plan(FirstStep::Restart), true).await;
        assert_eq!(out.error.as_deref(), Some("pm clear failed"));
        assert_eq!(
            out.reason.as_deref(),
            Some("restart failed (launch failed); clear failed (pm clear failed)")
        );
    }

    #[tokio::test]
    async fn explicit_clear_runs_only_clear() {
        let ops = MockOps::new();
        let out = run_ladder(&ops, plan(FirstStep::Clear), false).await;
        assert_eq!(out.mode_used, ResetMode::Clear);
        assert!(!out.fell_back);
        assert_eq!(ops.calls(), vec!["clear"]);
    }
}
