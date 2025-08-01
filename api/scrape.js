// File: api/scraper.js
import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: "Missing 'q' query parameter" });
  }

  const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;

  try {
    const response = await axios.get(searchUrl);
    const $ = cheerio.load(response.data);

    const articles = [];

    $("article").each((_, el) => {
      const title = $(el).find("h3, h4").text();
      const linkPart = $(el).find("a").attr("href");
      const link = linkPart
        ? "https://news.google.com" + linkPart.replace("./", "/")
        : null;

      const source = $(el).find("div[role='heading']").text().trim() || "Unknown";
      const time = $(el).find("time").attr("datetime") || "";

      if (title && link) {
        articles.push({ title, link, source, time });
      }
    });

    return res.status(200).json({
      status: "success",
      query: q,
      totalResults: articles.length,
      articles,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to fetch news",
      details: err.message,
    });
  }
}
