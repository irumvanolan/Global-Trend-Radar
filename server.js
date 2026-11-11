
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

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

// CACHE
const cache = new Map();

function getCached(key) {
  const item = cache.get(key);
  if (!item || Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, minutes) {
  cache.set(key, {
    data,
    expires: Date.now() + minutes * 60 * 1000
  });
}

// COUNTRY
function getCountry(code) {
  return countries.find(
    country => country.code === String(code || "RW").toUpperCase()
  ) || countries[0];
}

// HTTP JSON
async function fetchJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "GlobalTrendRadar/2.1"
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`External service returned ${response.status}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("External service returned invalid JSON.");
  }
}

// RSS
async function fetchRSS(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "GlobalTrendRadar/2.1",
      "Accept": "application/rss+xml, application/xml, text/xml"
    }
  });

  if (!response.ok) {
    throw new Error(`RSS service returned ${response.status}`);
  }

  return response.text();
}

function cleanXML(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    )
    .trim();
}

function getXMLTag(block, tag) {
  const regex = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const match = block.match(regex);
  return match ? cleanXML(match[1]) : "";
}

function parseRSS(xml, countryName) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items.map(item => ({
    title: getXMLTag(item, "title") || "Untitled news",
    url: getXMLTag(item, "link"),
    source: getXMLTag(item, "source") || "Google News RSS",
    publishedAt: getXMLTag(item, "pubDate") || null,
    image: "",
    language: "",
    country: countryName
  })).filter(article => article.title && article.url);
}

// GDELT REQUEST QUEUE
let gdeltQueue = Promise.resolve();
let lastGdeltRequestAt = 0;
let gdeltCooldownUntil = 0;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queuedGdeltRequest(url) {
  const task = gdeltQueue.then(async () => {
    const elapsed = Date.now() - lastGdeltRequestAt;
    const remaining = 5200 - elapsed;

    if (remaining > 0) await wait(remaining);

    lastGdeltRequestAt = Date.now();

    return fetchJSON(url);
  });

  gdeltQueue = task.catch(() => {});
  return task;
}

async function getGdeltArticles(country) {
  const url = new URL(
    "https://api.gdeltproject.org/api/v2/doc/doc"
  );

  url.searchParams.set("query", country.name);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "20");
  url.searchParams.set("sort", "HybridRel");
  url.searchParams.set("timespan", "7d");

  const data = await queuedGdeltRequest(url.toString());

  if (!Array.isArray(data.articles)) {
    throw new Error("GDELT returned an invalid articles list.");
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

async function getRSSArticles(country) {
  const url = new URL("https://news.google.com/rss/search");

  url.searchParams.set("q", `${country.name} when:7d`);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", country.code);
  url.searchParams.set("ceid", `${country.code}:en`);

  const xml = await fetchRSS(url.toString());
  const articles = parseRSS(xml, country.name);

  if (!articles.length) {
    throw new Error("RSS returned no news articles.");
  }

  return articles;
}

// SHARED NEWS CACHE
const newsCache = new Map();
const newsInFlight = new Map();

async function getNewsArticles(country) {
  const key = country.code;
  const now = Date.now();
  const saved = newsCache.get(key);

  if (saved && now < saved.expiresAt) {
    return {
      ...saved.data,
      cached: true
    };
  }

  if (newsInFlight.has(key)) {
    return newsInFlight.get(key);
  }

  const request = (async () => {
    try {
      let articles;
      let provider;

      if (Date.now() >= gdeltCooldownUntil) {
        try {
          articles = await getGdeltArticles(country);
          provider = "GDELT";
        } catch (error) {
          console.error("GDELT error:", error.message);

          if (error.message.includes("429")) {
            gdeltCooldownUntil = Date.now() + 10 * 60 * 1000;
          }
        }
      }

      if (!articles || !articles.length) {
        articles = await getRSSArticles(country);
        provider = "Google News RSS";
      }

      const result = {
        country: country.name,
        updatedAt: new Date().toISOString(),
        total: articles.length,
        articles,
        provider,
        cached: false,
        stale: false
      };

      newsCache.set(key, {
        data: result,
        expiresAt: Date.now() + 5 * 60 * 1000,
        staleUntil: Date.now() + 60 * 60 * 1000
      });

      return result;

    } catch (error) {
      console.error("News sources error:", error.message);

      const old = newsCache.get(key);

      if (old && Date.now() < old.staleUntil) {
        return {
          ...old.data,
          cached: true,
          stale: true
        };
      }

      throw error;

    } finally {
      newsInFlight.delete(key);
    }
  })();

  newsInFlight.set(key, request);
  return request;
}

// HEALTH
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "GLOBAL TREND RADAR",
    version: "2.1.0",
    newsSources: ["GDELT", "Google News RSS"],
    musicSources: ["Apple Music RSS"],
    time: new Date().toISOString()
  });
});

// COUNTRIES
app.get("/api/countries", (req, res) => {
  res.json(countries);
});

// NEWS
app.get("/api/news", async (req, res) => {
  const country = getCountry(req.query.country);

  try {
    const data = await getNewsArticles(country);

    res.json({
      country: data.country,
      updatedAt: data.updatedAt,
      total: data.articles.length,
      articles: data.articles,
      provider: data.provider,
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

// APPLE MUSIC RADAR
app.get("/api/music", async (req, res) => {
  const country = getCountry(req.query.country);
  const cacheKey = `music-${country.code}`;

  const saved = getCached(cacheKey);
  if (saved) return res.json(saved);

  try {
    const url =
      `https://rss.marketingtools.apple.com/api/v2/${country.code.toLowerCase()}/music/most-played/25/songs.json`;

    const data = await fetchJSON(url);
    const results = data.feed?.results || [];

    if (!results.length) {
      throw new Error(
        "No Apple Music chart available for this country."
      );
    }

    const songs = results.map((song, index) => ({
      rank: index + 1,
      id: song.id || "",
      title: song.name || "Unknown song",
      artist: song.artistName || "Unknown artist",
      album: song.collectionName || "",
      artwork: song.artworkUrl100 || "",
      url: song.url || "",
      releaseDate: song.releaseDate || "",
      genres: (song.genres || []).map(g => g.name)
    }));

    const result = {
      country: country.name,
      source: "Apple Music",
      chart: "Top 25 Most Played Songs",
      updatedAt: new Date().toISOString(),
      total: songs.length,
      configured: true,
      songs
    };

    setCached(cacheKey, result, 30);
    res.json(result);

  } catch (error) {
    console.error("Apple Music error:", error.message);

    res.status(502).json({
      error: "Music service is temporarily unavailable.",
      details: error.message,
      songs: []
    });
  }
});

// VIRAL RADAR
app.get("/api/viral", async (req, res) => {
  const country = getCountry(req.query.country);

  try {
    const data = await getNewsArticles(country);

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
      provider: data.provider,
      cached: data.cached,
      stale: Boolean(data.stale),
      note: "These are news topics, not verified social-media popularity rankings."
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

// CONTENT STUDIO
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
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
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

  res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(
    `GLOBAL TREND RADAR running on port ${PORT}`
  );
});
