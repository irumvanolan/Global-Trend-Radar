
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

// GENERAL CACHE
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
    country =>
      country.code === String(code || "RW").toUpperCase()
  ) || countries[0];
}

// HTTP REQUEST
async function fetchJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "GlobalTrendRadar/1.0"
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`External service returned ${response.status}`);
  }

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("External service returned invalid JSON.");
  }

  return data;
}

// GDELT REQUEST QUEUE
// Nta request nshya ikorwa mbere y'amasegonda 5.2.
let gdeltQueue = Promise.resolve();
let lastGdeltRequestAt = 0;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queuedGdeltRequest(url) {
  const task = gdeltQueue.then(async () => {
    const elapsed = Date.now() - lastGdeltRequestAt;
    const remaining = 5200 - elapsed;

    if (remaining > 0) {
      await wait(remaining);
    }

    lastGdeltRequestAt = Date.now();

    console.log("GDELT request started:", new Date().toISOString());

    return fetchJSON(url);
  });

  // Iyo request imwe yanze, izikurikiraho zirakomeza.
  gdeltQueue = task.catch(() => {});

  return task;
}

// SHARED GDELT CACHE
const gdeltCache = new Map();
const gdeltInFlight = new Map();

async function getGdeltArticles(country) {
  const key = country.code;
  const now = Date.now();

  const saved = gdeltCache.get(key);

  // Cache imara iminota 5.
  if (saved && now < saved.expiresAt) {
    return {
      ...saved.data,
      cached: true
    };
  }

  // Niba indi route isanzwe ihamagara GDELT,
  // iyi route irayitegereza aho gukora indi request.
  if (gdeltInFlight.has(key)) {
    return gdeltInFlight.get(key);
  }

  const url = new URL(
    "https://api.gdeltproject.org/api/v2/doc/doc"
  );

  url.searchParams.set("query", country.name);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "20");
  url.searchParams.set("sort", "HybridRel");
  url.searchParams.set("timespan", "7d");

  const request = (async () => {
    try {
      const data = await queuedGdeltRequest(url.toString());

      if (!Array.isArray(data.articles)) {
        throw new Error("GDELT returned no valid articles list.");
      }

      const articles = data.articles.map(article => ({
        title: article.title || "Untitled news",
        url: article.url || "",
        source: article.domain || "Unknown source",
        publishedAt: article.seendate || null,
        image: article.socialimage || "",
        language: article.language || "",
        country: country.name
      }));

      const result = {
        country: country.name,
        updatedAt: new Date().toISOString(),
        total: articles.length,
        articles,
        cached: false
      };

      // Fresh cache: 5 minutes.
      // Stale data: available for up to 30 minutes.
      gdeltCache.set(key, {
        data: result,
        expiresAt: Date.now() + 5 * 60 * 1000,
        staleUntil: Date.now() + 30 * 60 * 1000
      });

      return result;

    } catch (error) {
      console.error("GDELT error:", error.message);

      // Koresha amakuru ashaje niba GDELT yanze.
      const old = gdeltCache.get(key);

      if (old && Date.now() < old.staleUntil) {
        return {
          ...old.data,
          cached: true,
          stale: true
        };
      }

      throw error;

    } finally {
      gdeltInFlight.delete(key);
    }
  })();

  gdeltInFlight.set(key, request);

  return request;
}

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "GLOBAL TREND RADAR",
    version: "1.1.0",
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
    const data = await getGdeltArticles(country);

    res.json({
      country: data.country,
      updatedAt: data.updatedAt,
      total: data.articles.length,
      articles: data.articles,
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
  const cacheKey = `music-${country.code}`;

  const saved = getCached(cacheKey);

  if (saved) {
    return res.json(saved);
  }

  if (!YOUTUBE_API_KEY) {
    return res.json({
      country: country.name,
      configured: false,
      message: "YouTube API key has not been configured yet.",
      videos: []
    });
  }

  try {
    const url = new URL(
      "https://www.googleapis.com/youtube/v3/videos"
    );

    url.searchParams.set("part", "snippet,statistics");
    url.searchParams.set("chart", "mostPopular");
    url.searchParams.set("regionCode", country.code);
    url.searchParams.set("videoCategoryId", "10");
    url.searchParams.set("maxResults", "20");
    url.searchParams.set("key", YOUTUBE_API_KEY);

    const data = await fetchJSON(url.toString());

    const videos = (data.items || []).map(video => ({
      videoId: video.id,
      title: video.snippet?.title || "Untitled video",
      channelTitle: video.snippet?.channelTitle || "Unknown artist",
      thumbnail:
        video.snippet?.thumbnails?.high?.url ||
        video.snippet?.thumbnails?.medium?.url ||
        "",
      publishedAt: video.snippet?.publishedAt || null,
      views: Number(video.statistics?.viewCount || 0),
      url: `https://www.youtube.com/watch?v=${video.id}`
    }));

    const result = {
      country: country.name,
      configured: true,
      updatedAt: new Date().toISOString(),
      total: videos.length,
      videos
    };

    setCached(cacheKey, result, 10);

    res.json(result);

  } catch (error) {
    console.error("YouTube error:", error.message);

    res.status(502).json({
      error: "Music service is temporarily unavailable.",
      details: error.message,
      videos: []
    });
  }
});

// VIRAL RADAR
app.get("/api/viral", async (req, res) => {
  const country = getCountry(req.query.country);

  try {
    // Ikoresha amakuru News yamaze kubona.
    // Nta yindi request ya GDELT ikora.
    const data = await getGdeltArticles(country);

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
      cached: data.cached,
      stale: Boolean(data.stale)
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
