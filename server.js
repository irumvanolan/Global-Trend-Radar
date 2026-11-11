
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const countries = [
  { code: "RW", name: "Rwanda" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "KE", name: "Kenya" },
  { code: "UG", name: "Uganda" },
  { code: "TZ", name: "Tanzania" },
  { code: "NG", name: "Nigeria" },
  { code: "ZA", name: "South Africa" },
  { code: "GH", name: "Ghana" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "IN", name: "India" },
  { code: "BR", name: "Brazil" },
  { code: "JP", name: "Japan" },
  { code: "CA", name: "Canada" }
];

const cache = new Map();
const inFlight = new Map();

function getCountry(code) {
  return countries.find(
    item => item.code === String(code || "RW").toUpperCase()
  ) || countries[0];
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() > item.staleUntil) {
    cache.delete(key);
    return null;
  }

  return {
    data: item.data,
    fresh: Date.now() < item.expiresAt
  };
}

function saveCache(key, data, freshMinutes = 10, staleHours = 24) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + freshMinutes * 60 * 1000,
    staleUntil: Date.now() + staleHours * 60 * 60 * 1000
  });
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "GLOBAL-TREND-RADAR/2.2",
        "Accept": "application/json, application/rss+xml, application/xml, text/xml"
      }
    });

    if (!response.ok) {
      throw new Error(`External service returned ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithRetry(url, timeoutMs = 12000) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchText(url, timeoutMs);
    } catch (error) {
      lastError = error;
      console.error(`Fetch attempt ${attempt} failed:`, error.message);

      if (attempt < 2) await wait(700);
    }
  }

  throw lastError;
}

async function fetchJSON(url, timeoutMs = 12000) {
  const body = await fetchTextWithRetry(url, timeoutMs);

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("External service returned invalid JSON.");
  }
}

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    )
    .trim();
}

function getTag(item, tag) {
  const regex = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );

  const match = item.match(regex);
  return match ? decodeXml(match[1]) : "";
}

function parseGoogleNews(xml, country) {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  return items.slice(0, 25).map(item => {
    const title = getTag(item, "title");
    const link = getTag(item, "link");
    const pubDate = getTag(item, "pubDate");
    const source = getTag(item, "source");

    return {
      title: title || "Untitled news",
      url: link,
      source: source || "Google News",
      publishedAt: pubDate || null,
      image: "",
      language: "",
      country: country.name
    };
  }).filter(item => item.title && item.url);
}

// GOOGLE NEWS RSS
async function getGoogleNews(country) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", country.name);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", country.code);
  url.searchParams.set("ceid", `${country.code}:en`);

  const xml = await fetchTextWithRetry(url.toString(), 12000);
  const articles = parseGoogleNews(xml, country);

  if (!articles.length) {
    throw new Error("Google News RSS returned no articles.");
  }

  return articles;
}

// GDELT REQUEST QUEUE
let gdeltQueue = Promise.resolve();
let lastGdeltRequestAt = 0;
let gdeltBlockedUntil = 0;

function queuedGdeltRequest(url) {
  const task = gdeltQueue.then(async () => {
    if (Date.now() < gdeltBlockedUntil) {
      throw new Error("GDELT is temporarily rate-limited.");
    }

    const elapsed = Date.now() - lastGdeltRequestAt;
    const remaining = 5200 - elapsed;

    if (remaining > 0) await wait(remaining);

    lastGdeltRequestAt = Date.now();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "GLOBAL-TREND-RADAR/2.2" }
    });

    if (response.status === 429) {
      gdeltBlockedUntil = Date.now() + 10 * 60 * 1000;
      throw new Error("GDELT rate limit: retry after 10 minutes.");
    }

    if (!response.ok) {
      throw new Error(`GDELT returned ${response.status}`);
    }

    return response.json();
  });

  gdeltQueue = task.catch(() => {});
  return task;
}

async function getGdeltNews(country) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", country.name);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "20");
  url.searchParams.set("sort", "HybridRel");
  url.searchParams.set("timespan", "7d");

  const data = await queuedGdeltRequest(url.toString());

  if (!Array.isArray(data.articles)) {
    throw new Error("GDELT returned no valid articles.");
  }

  return data.articles.map(article => ({
    title: article.title || "Untitled news",
    url: article.url || "",
    source: article.domain || "Unknown source",
    publishedAt: article.seendate || null,
    image: article.socialimage || "",
    language: article.language || "",
    country: country.name
  })).filter(article => article.url);
}

// SHARED NEWS CACHE
async function getNewsData(country) {
  const key = `news-${country.code}`;
  const saved = getCached(key);

  if (saved && saved.fresh) {
    return { ...saved.data, cached: true };
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const request = (async () => {
    try {
      let articles;
      let source;

      try {
        articles = await getGoogleNews(country);
        source = "Google News RSS";
      } catch (rssError) {
        console.error("Google News RSS error:", rssError.message);

        articles = await getGdeltNews(country);
        source = "GDELT";
      }

      const result = {
        country: country.name,
        updatedAt: new Date().toISOString(),
        total: articles.length,
        articles,
        source,
        cached: false,
        stale: false
      };

      saveCache(key, result, 10, 24);
      return result;
    } catch (error) {
      console.error("News services error:", error.message);

      const old = getCached(key);

      if (old) {
        return {
          ...old.data,
          cached: true,
          stale: true
        };
      }

      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

// APPLE MUSIC RSS
async function getAppleMusic(country) {
  const key = `music-${country.code}`;
  const saved = getCached(key);

  if (saved && saved.fresh) {
    return {
      ...saved.data,
      cached: true
    };
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const request = (async () => {
    try {
      const url =
        `https://rss.marketingtools.apple.com/api/v2/` +
        `${country.code.toLowerCase()}/music/most-played/25/songs.json`;

      const data = await fetchJSON(url, 12000);
      const feed = data.feed || {};
      const results = Array.isArray(feed.results) ? feed.results : [];

      if (!results.length) {
        throw new Error("Apple Music returned no songs for this country.");
      }

      const songs = results.map((song, index) => ({
        rank: index + 1,
        id: song.id || "",
        title: song.name || song.title || "Unknown song",
        artist: song.artistName || "Unknown artist",
        album: song.collectionName || "",
        artwork: song.artworkUrl100 || "",
        url: song.url || "",
        releaseDate: song.releaseDate || null,
        genres: Array.isArray(song.genres)
          ? song.genres.map(genre => genre.name).filter(Boolean)
          : []
      }));

      const videos = songs.map(song => ({
        videoId: song.id,
        title: song.title,
        channelTitle: song.artist,
        thumbnail: song.artwork,
        publishedAt: song.releaseDate,
        views: null,
        url: song.url,
        rank: song.rank
      }));

      const result = {
        country: country.name,
        configured: true,
        source: "Apple Music RSS",
        updatedAt: new Date().toISOString(),
        total: songs.length,
        songs,
        videos,
        cached: false,
        stale: false
      };

      saveCache(key, result, 30, 24);
      return result;
    } catch (error) {
      console.error("Apple Music error:", error.message);

      const old = getCached(key);

      if (old) {
        return {
          ...old.data,
          cached: true,
          stale: true,
          warning: "Showing previously saved music data."
        };
      }

      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "GLOBAL TREND RADAR",
    version: "2.2.0",
    newsSources: ["Google News RSS", "GDELT"],
    musicSources: ["Apple Music RSS"],
    time: new Date().toISOString()
  });
});

// COUNTRIES
app.get("/api/countries", (req, res) => {
  res.json(countries);
});

// NEWS RADAR
app.get("/api/news", async (req, res) => {
  const country = getCountry(req.query.country);

  try {
    const data = await getNewsData(country);

    res.json({
      country: data.country,
      updatedAt: data.updatedAt,
      total: data.articles.length,
      articles: data.articles,
      source: data.source,
      cached: data.cached,
      stale: Boolean(data.stale)
    });
  } catch (error) {
    res.status(502).json({
      error: "News service is temporarily unavailable.",
      details: error.message,
      articles: []
    });
  }
});

// MUSIC RADAR
app.get("/api/music", async (req, res) => {
  const country = getCountry(req.query.country);

  try {
    const data = await getAppleMusic(country);
    res.json(data);
  } catch (error) {
    res.status(502).json({
      error: "Music service is temporarily unavailable.",
      details: error.message,
      country: country.name,
      songs: [],
      videos: []
    });
  }
});

// VIRAL RADAR
app.get("/api/viral", async (req, res) => {
  const country = getCountry(req.query.country);

  try {
    const data = await getNewsData(country);

    const trends = data.articles.map((article, index) => ({
      rank: index + 1,
      title: article.title,
      source: article.source,
      url: article.url,
      publishedAt: article.publishedAt,
      country: country.name,
      status: "UNVERIFIED"
    }));

    res.json({
      country: country.name,
      updatedAt: data.updatedAt,
      total: trends.length,
      trends,
      source: data.source,
      cached: data.cached,
      stale: Boolean(data.stale),
      note: "These are news topics, not verified cross-platform social media popularity rankings."
    });
  } catch (error) {
    console.error("Viral error:", error.message);

    res.status(502).json({
      error: "Trend service is temporarily unavailable.",
      details: error.message,
      trends: []
    });
  }
});

// ORIGINAL CONTENT STUDIO
app.post("/api/script", (req, res) => {
  const topic = String(req.body.topic || "")
    .trim()
    .slice(0, 300);

  const country = getCountry(req.body.country);
  const language = req.body.language === "en" ? "en" : "rw";
  const style = String(req.body.style || "news").toLowerCase();
  const duration = Number(req.body.duration || 30);

  if (!topic) {
    return res.status(400).json({
      error: "Please enter a topic."
    });
  }

  if (![15, 30, 60, 90].includes(duration)) {
    return res.status(400).json({
      error: "Duration must be 15, 30, 60 or 90 seconds."
    });
  }

  const styles = {
    news: language === "rw"
      ? "Amakuru y'ingenzi:"
      : "Important update:",

    story: language === "rw"
      ? "Dore inkuru ikomeye:"
      : "Here is an interesting story:",

    education: language === "rw"
      ? "Ese wari ubizi?"
      : "Did you know?",

    entertainment: language === "rw"
      ? "Reka turebe ibyavuzwe:"
      : "Let's look at what's happening:"
  };

  const opening = styles[style] || styles.news;

  const script = language === "rw"
    ? `${opening}

Uyu munsi turavuga kuri: ${topic}.

Iyi ngingo irimo kuvugisha abantu benshi. Ni ngombwa kuyisobanukirwa, kumenya aho amakuru yaturutse no kureba ingaruka ishobora kugira.

Kurikirana GLOBAL TREND RADAR kugira ngo umenye ibigezweho ku isi.`
    : `${opening}

Today we are looking at: ${topic}.

This topic is attracting attention. It is important to understand the facts, check the sources and consider why it matters.

Follow GLOBAL TREND RADAR to stay informed about what is happening around the world.`;

  res.json({
    country: country.name,
    language,
    style,
    duration,
    topic,
    script,
    note: "This is original template-based content. Verify facts before publishing.",
    createdAt: new Date().toISOString()
  });
});

// HOME PAGE
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// UNKNOWN API ROUTES
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found."
  });
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`GLOBAL TREND RADAR v2.2.0 running on port ${PORT}`);
});
