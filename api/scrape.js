// File: api/scrape.js

import axios from 'axios';
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  const { url, type, query, include_content = 'false' } = req.query;

  // Default fallback message
  if (!url && (!type || !query)) {
    return res.status(400).json({
      success: false,
      error: "URL parameter is required. Use type=rss for RSS feed with full content, or provide a news article URL.",
      examples: {
        rss_with_content: "/api/scrape?type=rss&query=technology&include_content=true",
        rss_links_only: "/api/scrape?type=rss&query=sports&include_content=false",
        single_article: "/api/scrape?url=https://example.com/article"
      }
    });
  }

  try {
    if (url) {
      // Extract full content from a news article
      const response = await axios.get(url);
      const $ = cheerio.load(response.data);
      const paragraphs = $('p').map((_, el) => $(el).text()).get();
      return res.json({ success: true, paragraphs });
    }

    if (type === 'rss' && query) {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}`;
      const rssRes = await axios.get(rssUrl);
      const $ = cheerio.load(rssRes.data, { xmlMode: true });

      const items = $('item').map((_, item) => {
        const $item = $(item);
        return {
          title: $item.find('title').text(),
          link: $item.find('link').text(),
          pubDate: $item.find('pubDate').text()
        };
      }).get();

      // If include_content is true, fetch and parse full content
      if (include_content === 'true') {
        const results = [];
        for (let item of items) {
          try {
            const articleRes = await axios.get(item.link);
            const $$ = cheerio.load(articleRes.data);
            const content = $$('p').map((_, p) => $$(p).text()).get().join('\n');
            results.push({ ...item, content });
          } catch (err) {
            results.push({ ...item, content: null, error: "Failed to fetch article content" });
          }
        }
        return res.json({ success: true, results });
      }

      return res.json({ success: true, items });
    }

    res.status(400).json({ success: false, error: "Invalid parameters" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
