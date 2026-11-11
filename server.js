
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

function getCountry(code) {
  return countries.find(
    country => country.code === String(code || "RW").toUpperCase()
  ) || countries[0];
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "GlobalTrendRadar/1.0" }
  });

  if (!response.ok) {
    throw new Error(`External service returned ${response.status}`);
  }

  return response.json();
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "GLOBAL TREND RADAR",
    version: "1.0.0",
    time: new Date().toISOString()
  });
});

app.get("/api/countries", (req, res) => {
  res.json(countries);
});

// NEWS RADAR
app.get("/api/news", async (req, res) => {
  const country = getCountry(req.query.country);
  const cacheKey = `news-${country.code}`;

  const saved = getCached(cacheKey);
  if (saved) return res.json(saved);

  try {
    const query = `(${country.name})`;
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");

    url.searchParams.set("query", query);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", "20");
    url.searchParams.set("sort", "HybridRel");

    const data = await fetchJSON(url.toString());
    const articles = (data.articles || []).map(article => ({
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
      articles
    };

    setCached(cacheKey, result, 5);
    res.json(result);
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
  if (saved) return res.json(saved);

  if (!YOUTUBE_API_KEY) {
    return res.json({
      country: country.name,
      configured: false,
      message: "YouTube API key has not been configured yet.",
      videos: []
    });
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");

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
  const cacheKey = `viral-${country.code}`;

  const saved = getCached(cacheKey);
  if (saved) return res.json(saved);

  try {
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");

    url.searchParams.set("query", `(${country.name})`);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", "15");
    url.searchParams.set("sort", "HybridRel");

    const data = await fetchJSON(url.toString());

    const trends = (data.articles || []).map((article, index) => ({
      rank: index + 1,
      title: article.title || "Untitled topic",
      source: article.domain || "Unknown source",
      url: article.url || "",
      publishedAt: article.seendate || null,
      country: country.name,
      status: "UNVERIFIED"
    }));

    const result = {
      country: country.name,
      updatedAt: new Date().toISOString(),
      total: trends.length,
      trends
    };

    setCached(cacheKey, result, 5);
    res.json(result);
  } catch (error) {
    res.status(502).json({
      error: "Trend service is temporarily unavailable.",
      details: error.message,
      trends: []
    });
  }
});

// ORIGINAL CONTENT STUDIO
app.post("/api/script", (req, res) => {
  const topic = String(req.body.topic || "").trim().slice(0, 300);
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
    ? `${opening}\n\nUyu munsi turavuga kuri: ${topic}.\n\nIyi ngingo irimo kuvugisha abantu benshi. Ni ngombwa kuyisobanukirwa, kumenya aho amakuru yaturutse no kureba ingaruka ishobora kugira.\n\nKurikirana GLOBAL TREND RADAR kugira ngo umenye ibigezweho ku isi.`
    : `${opening}\n\nToday we are looking at: ${topic}.\n\nThis topic is attracting attention. It is important to understand the facts, check the sources and consider why it matters.\n\nFollow GLOBAL TREND RADAR to stay informed about what is happening around the world.`;

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
  res.status(404).json({ error: "API route not found." });
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

app.listen(PORT, () => {
  console.log(`GLOBAL TREND RADAR running on port ${PORT}`);
});
