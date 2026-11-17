use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use nip_domain::{PodcastEpisode, PodcastEpisodeState, SourceId};
use quick_xml::events::Event;
use quick_xml::Reader;
use thiserror::Error;
use ureq::Agent;
use url::Url;

pub const PRODUCTION_POLL_INTERVAL: TimeDelta = TimeDelta::hours(6);
const MAX_FEED_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BACKOFF: TimeDelta = TimeDelta::hours(6);
const BASE_BACKOFF: TimeDelta = TimeDelta::minutes(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedRequest {
    pub url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub retry_after: Option<String>,
    pub body: String,
}

#[derive(Debug, Error)]
pub enum FeedClientError {
    #[error("podcast feed request failed")]
    Request,
    #[error("podcast feed response exceeded the configured size limit or was not valid UTF-8")]
    InvalidBody,
}

/// The engine receives RSS over this narrow boundary, allowing deterministic
/// in-process fixtures without public network access.
pub trait FeedClient {
    fn fetch(&self, request: &FeedRequest) -> Result<FeedResponse, FeedClientError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum AudioClientError {
    #[error("podcast enclosure request failed")]
    Request,
    #[error("podcast enclosure response was invalid or too large")]
    InvalidBody,
}

pub trait AudioClient {
    fn fetch(&self, url: &str) -> Result<AudioResponse, AudioClientError>;
}

pub struct HttpAudioClient {
    agent: Agent,
    allow_loopback: bool,
}

impl Default for HttpAudioClient {
    fn default() -> Self {
        Self::new(false)
    }
}

impl HttpAudioClient {
    fn new(allow_loopback: bool) -> Self {
        let config = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .max_redirects(0)
            .build();
        Self {
            agent: config.into(),
            allow_loopback,
        }
    }

    /// Test-only client for the loopback synthetic enclosure fixture. The
    /// production client never permits loopback, private, or link-local hosts.
    pub fn for_test() -> Self {
        Self::new(true)
    }
}

impl AudioClient for HttpAudioClient {
    fn fetch(&self, value: &str) -> Result<AudioResponse, AudioClientError> {
        let url = validate_audio_url(value, self.allow_loopback)
            .map_err(|_| AudioClientError::Request)?;
        let mut response = self
            .agent
            .get(url.as_str())
            .call()
            .map_err(|_| AudioClientError::Request)?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = if status == 200 {
            response
                .body_mut()
                .with_config()
                .limit(MAX_AUDIO_BYTES)
                .read_to_vec()
                .map_err(|_| AudioClientError::InvalidBody)?
        } else {
            Vec::new()
        };
        Ok(AudioResponse {
            status,
            content_type,
            body,
        })
    }
}

pub struct HttpFeedClient {
    agent: Agent,
}

impl Default for HttpFeedClient {
    fn default() -> Self {
        let config = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(20)))
            .build();
        Self {
            agent: config.into(),
        }
    }
}

impl FeedClient for HttpFeedClient {
    fn fetch(&self, request: &FeedRequest) -> Result<FeedResponse, FeedClientError> {
        let url = validate_feed_url(&request.url).map_err(|_| FeedClientError::Request)?;
        let mut call = self.agent.get(url.as_str());
        if let Some(etag) = request.etag.as_deref() {
            call = call.header("If-None-Match", etag);
        }
        if let Some(last_modified) = request.last_modified.as_deref() {
            call = call.header("If-Modified-Since", last_modified);
        }
        let mut response = call.call().map_err(|_| FeedClientError::Request)?;
        let status = response.status();
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let last_modified = response
            .headers()
            .get("last-modified")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = if status == 200 {
            response
                .body_mut()
                .with_config()
                .limit(MAX_FEED_BYTES)
                .read_to_string()
                .map_err(|_| FeedClientError::InvalidBody)?
        } else {
            String::new()
        };
        Ok(FeedResponse {
            status: status.into(),
            etag,
            last_modified,
            retry_after,
            body,
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FeedValidationError {
    #[error("feed URL must be an absolute HTTP or HTTPS URL without embedded credentials")]
    InvalidUrl,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum AudioUrlError {
    #[error("audio URL must resolve to a public HTTP or HTTPS destination")]
    Invalid,
}

fn validate_audio_url(value: &str, allow_loopback: bool) -> Result<Url, AudioUrlError> {
    let url = Url::parse(value).map_err(|_| AudioUrlError::Invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AudioUrlError::Invalid);
    }
    let host = url.host_str().ok_or(AudioUrlError::Invalid)?;
    let port = url.port_or_known_default().ok_or(AudioUrlError::Invalid)?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| AudioUrlError::Invalid)?;
    if addresses.into_iter().any(|address| {
        let ip = address.ip();
        if allow_loopback {
            !(ip.is_loopback() || is_public_ip(ip))
        } else {
            !is_public_ip(ip)
        }
    }) {
        return Err(AudioUrlError::Invalid);
    }
    Ok(url)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
        }
        IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
        }
    }
}

pub fn validate_feed_url(value: &str) -> Result<Url, FeedValidationError> {
    let mut url = Url::parse(value).map_err(|_| FeedValidationError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(FeedValidationError::InvalidUrl);
    }
    url.set_fragment(None);
    Ok(url)
}

#[derive(Debug)]
pub struct ParsedFeed {
    pub show_title: Option<String>,
    pub episodes: Vec<PodcastEpisode>,
}

#[derive(Debug, Error)]
pub enum FeedParseError {
    #[error("RSS feed XML is invalid")]
    InvalidXml,
    #[error("the supplied document is not an RSS channel")]
    NotRss,
}

#[derive(Default)]
struct RawEpisode {
    guid: Option<String>,
    title: Option<String>,
    link: Option<String>,
    enclosure: Option<String>,
    pub_date: Option<String>,
}

/// Parse the RSS metadata required for source-linked episode discovery. Audio
/// enclosures are recorded; bounded retrieval is a separate service operation.
pub fn parse_rss_feed(
    xml: &str,
    feed_url: &Url,
    source_id: &SourceId,
    discovered_at: DateTime<Utc>,
) -> Result<ParsedFeed, FeedParseError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_channel = false;
    let mut feed_title = None;
    let mut current_episode: Option<RawEpisode> = None;
    let mut active_field: Option<String> = None;
    let mut field_text = String::new();
    let mut found_rss_root = false;
    let mut found_channel = false;
    let mut episodes = Vec::new();

    loop {
        match reader
            .read_event()
            .map_err(|_| FeedParseError::InvalidXml)?
        {
            Event::Start(element) => {
                let name = element.local_name().as_ref().to_ascii_lowercase();
                match name.as_str() {
                    "rss" | "rdf" => found_rss_root = true,
                    "channel" => {
                        in_channel = true;
                        found_channel = true;
                    }
                    "item" => {
                        current_episode = Some(RawEpisode::default());
                    }
                    "enclosure" if current_episode.is_some() => {
                        if let Some(value) = enclosure_url(&element, feed_url) {
                            if let Some(item) = current_episode.as_mut() {
                                item.enclosure = Some(value);
                            }
                        }
                    }
                    "guid" | "title" | "link" | "pubdate" if current_episode.is_some() => {
                        active_field = Some(name);
                        field_text.clear();
                    }
                    "title" if in_channel => {
                        active_field = Some("feed_title".to_owned());
                        field_text.clear();
                    }
                    _ => {}
                }
            }
            Event::Empty(element) => {
                let name = element.local_name().as_ref().to_ascii_lowercase();
                if name == "enclosure" && current_episode.is_some() {
                    if let Some(value) = enclosure_url(&element, feed_url) {
                        if let Some(item) = current_episode.as_mut() {
                            item.enclosure = Some(value);
                        }
                    }
                }
            }
            Event::Text(text) => {
                if active_field.is_some() {
                    field_text.push_str(&text.xml10_content());
                }
            }
            Event::GeneralRef(reference) => {
                if active_field.is_some() {
                    let replacement = reference
                        .resolve_char_ref()
                        .map_err(|_| FeedParseError::InvalidXml)?
                        .map(|value| value.to_string())
                        .or_else(|| {
                            quick_xml::escape::resolve_predefined_entity(&reference)
                                .map(str::to_owned)
                        })
                        .ok_or(FeedParseError::InvalidXml)?;
                    field_text.push_str(&replacement);
                }
            }
            Event::CData(text) => {
                if active_field.is_some() {
                    field_text.push_str(&text.xml10_content());
                }
            }
            Event::End(element) => {
                let name = element.local_name().as_ref().to_ascii_lowercase();
                if active_field
                    .as_deref()
                    .is_some_and(|field| field_matches_end(field, &name))
                {
                    if let Some(field) = active_field.take() {
                        let value = field_text.trim().to_owned();
                        if !value.is_empty() {
                            if field == "feed_title" {
                                feed_title = Some(value);
                            } else if let Some(item) = current_episode.as_mut() {
                                match field.as_str() {
                                    "guid" => item.guid = Some(value),
                                    "title" => item.title = Some(value),
                                    "link" => item.link = Some(value),
                                    "pubdate" => item.pub_date = Some(value),
                                    _ => {}
                                }
                            }
                        }
                        field_text.clear();
                    }
                }
                if name == "item" {
                    if let Some(item) = current_episode.take() {
                        if let Some(parsed) =
                            finish_episode(item, feed_url, source_id, discovered_at)
                        {
                            episodes.push(parsed);
                        }
                    }
                } else if name == "channel" {
                    in_channel = false;
                }
            }
            Event::Eof => break,
            Event::Decl(_) | Event::Comment(_) | Event::PI(_) | Event::DocType(_) => {}
        }
    }

    if !found_rss_root || !found_channel {
        return Err(FeedParseError::NotRss);
    }
    Ok(ParsedFeed {
        show_title: feed_title,
        episodes,
    })
}

fn field_matches_end(field: &str, end: &str) -> bool {
    match field {
        "feed_title" => end == "title",
        "pubdate" => end == "pubdate",
        _ => field == end,
    }
}

fn enclosure_url(element: &quick_xml::events::BytesStart<'_>, feed_url: &Url) -> Option<String> {
    for attribute in element.attributes().with_checks(true).flatten() {
        if attribute.key.as_ref() == "url" {
            let value = attribute.value.as_ref();
            let value = quick_xml::escape::unescape(value).ok()?;
            return resolve_http_url(feed_url, value.trim());
        }
    }
    None
}

fn finish_episode(
    item: RawEpisode,
    feed_url: &Url,
    source_id: &SourceId,
    discovered_at: DateTime<Utc>,
) -> Option<PodcastEpisode> {
    let source_native_id = item
        .guid
        .map(|guid| guid.trim().to_owned())
        .filter(|guid| !guid.is_empty());
    let canonical_url = item
        .link
        .as_deref()
        .and_then(|link| resolve_http_url(feed_url, link.trim()));
    if source_native_id.is_none() && canonical_url.is_none() {
        return None;
    }
    Some(PodcastEpisode {
        source_id: source_id.clone(),
        source_native_id,
        canonical_url,
        title: item
            .title
            .map(|title| title.trim().to_owned())
            .filter(|v| !v.is_empty()),
        enclosure_url: item
            .enclosure
            .as_deref()
            .and_then(|url| resolve_http_url(feed_url, url)),
        published_at: item.pub_date.as_deref().and_then(parse_publication_date),
        discovered_at,
        state: PodcastEpisodeState::AwaitingLocalTranscription,
    })
}

fn resolve_http_url(base: &Url, candidate: &str) -> Option<String> {
    let mut url = base.join(candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn parse_publication_date(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc2822(value)
        .map(|value| value.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| value.with_timezone(&Utc))
        })
}

pub fn scheduled_next_poll(
    now: DateTime<Utc>,
    consecutive_failures: u32,
    retry_after: Option<&str>,
) -> DateTime<Utc> {
    let backoff = if consecutive_failures == 0 {
        PRODUCTION_POLL_INTERVAL
    } else {
        let exponent = consecutive_failures.saturating_sub(1).min(16);
        let multiplier = 1_i64 << exponent;
        BASE_BACKOFF
            .checked_mul(multiplier as i32)
            .unwrap_or(MAX_BACKOFF)
            .min(MAX_BACKOFF)
    };
    let exponential_at = now.checked_add_signed(backoff).unwrap_or(now);
    retry_after
        .and_then(|header| parse_retry_after(header, now))
        .filter(|value| *value > exponential_at)
        .unwrap_or(exponential_at)
}

fn parse_retry_after(value: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if let Ok(seconds) = value.trim().parse::<i64>() {
        if seconds >= 0 {
            return now.checked_add_signed(TimeDelta::seconds(seconds));
        }
    }
    DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    const FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture Show</title><item>
  <guid isPermaLink="false">ep-001</guid><title>First episode</title>
  <link>episodes/one#details</link><pubDate>Sun, 15 Nov 2026 12:00:00 +0000</pubDate>
  <enclosure url="audio/one.mp3?token=x&amp;v=2" type="audio/mpeg" length="123"/>
</item><item><title>URL-keyed item</title><link>https://pod.test/two?x=1#frag</link>
  <enclosure url="https://cdn.test/two.mp3" type="audio/mpeg"/>
</item><item><title>No stable identity</title></item></channel></rss>"#;

    #[test]
    fn parses_rss_title_items_relative_urls_and_optional_dates() {
        let feed_url = Url::parse("https://pod.test/show/feed.xml?keep=1#fragment").unwrap();
        let source_id = SourceId::new("show-1").unwrap();
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        let feed = parse_rss_feed(FIXTURE, &feed_url, &source_id, now).unwrap();
        assert_eq!(feed.show_title.as_deref(), Some("Fixture Show"));
        assert_eq!(feed.episodes.len(), 2);
        assert_eq!(feed.episodes[0].source_native_id.as_deref(), Some("ep-001"));
        assert_eq!(
            feed.episodes[0].canonical_url.as_deref(),
            Some("https://pod.test/show/episodes/one")
        );
        assert_eq!(
            feed.episodes[0].enclosure_url.as_deref(),
            Some("https://pod.test/show/audio/one.mp3?token=x&v=2")
        );
        assert_eq!(
            feed.episodes[0].published_at.unwrap().to_rfc3339(),
            "2026-11-15T12:00:00+00:00"
        );
        assert_eq!(feed.episodes[1].source_native_id, None);
        assert_eq!(feed.episodes[1].published_at, None);
    }

    #[test]
    fn rejects_non_rss_xml_and_invalid_feed_urls() {
        let feed_url = Url::parse("https://pod.test/feed.xml").unwrap();
        let source_id = SourceId::new("show-1").unwrap();
        assert!(matches!(
            parse_rss_feed("<feed><entry/></feed>", &feed_url, &source_id, Utc::now()),
            Err(FeedParseError::NotRss)
        ));
        for invalid in [
            "file:///tmp/feed.xml",
            "ftp://example.test/feed",
            "https://user:pw@example.test/feed",
            "/relative",
        ] {
            assert_eq!(
                validate_feed_url(invalid),
                Err(FeedValidationError::InvalidUrl)
            );
        }
    }

    #[test]
    fn retry_after_longer_than_backoff_is_honored() {
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        assert_eq!(
            scheduled_next_poll(now, 1, Some("3600")),
            now + TimeDelta::hours(1)
        );
        assert_eq!(
            scheduled_next_poll(now, 0, None),
            now + PRODUCTION_POLL_INTERVAL
        );
    }

    #[test]
    fn http_fetcher_sends_validators_and_handles_not_modified_loopback_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for (index, stream) in listener.incoming().take(2).enumerate() {
                let mut stream = stream.unwrap();
                let mut request = [0_u8; 4096];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]).to_ascii_lowercase();
                if index == 0 {
                    tx.send(request).unwrap();
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nETag: \"v1\"\r\nContent-Length: 11\r\nConnection: close\r\n\r\n<rss></rss>")
                        .unwrap();
                } else {
                    tx.send(request).unwrap();
                    stream
                        .write_all(b"HTTP/1.1 304 Not Modified\r\nRetry-After: 120\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                        .unwrap();
                }
            }
        });
        let client = HttpFeedClient::default();
        let url = format!("http://{address}/feed.xml");
        let first = client
            .fetch(&FeedRequest {
                url: url.clone(),
                etag: None,
                last_modified: None,
            })
            .unwrap();
        assert_eq!(first.status, 200);
        assert_eq!(first.etag.as_deref(), Some("\"v1\""));
        assert!(rx.recv().unwrap().starts_with("get /feed.xml http/1.1"));

        let second = client
            .fetch(&FeedRequest {
                url,
                etag: first.etag,
                last_modified: None,
            })
            .unwrap();
        assert_eq!(second.status, 304);
        assert_eq!(second.retry_after.as_deref(), Some("120"));
        assert!(rx.recv().unwrap().contains("if-none-match: \"v1\""));
        server.join().unwrap();
    }
}
